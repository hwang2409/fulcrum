# fulcrum core
# fulcrum core

start: `make dev` installs, builds every package, and runs the playground (then open `/gallery.html`). `make test` builds and runs the tests; `make clean` removes builds.

## packages

- `@fulcrum/core`: agent-agnostic run events and a burst-coalescing run store.
- `@fulcrum/zeta`: zeta serve wire types, adapter, JSON-RPC client, websocket transport, and authenticated `connectZeta`.
- `@fulcrum/react`: react 19 hooks and headless timeline parts over `@fulcrum/core`. It does not depend on `@fulcrum/zeta`.
- `@fulcrum/markdown`: streaming markdown with a framework-free, dependency-free document core and an optional `@fulcrum/markdown/react` renderer (peer: `@fulcrum/react`, which draws its code blocks).
- `apps/playground` (private): replays the zeta fixtures, runs a stress test, or connects to a live zeta server in a browser.

## zeta web client

`apps/web` is a real zeta client built only on the public `@fulcrum/*` exports: a session list (a drawer at phone widths), the live run with markdown, highlighting, tool cards, and approvals, and the 12 themes. It finds the server through the dev-server handoff and reconnects by itself.

```sh
zeta serve --ws 8765 --ws-origin http://localhost:5180
make web   # http://localhost:5180
```

The app shows a clear state when zeta is not running (with this command), refuses the origin or token, is in use by another client, or drops. Without zeta, `bun run --cwd apps/web fake-zeta` starts a scripted server and prints how to start the app against it. `bun run --cwd apps/web gate` is the browser gate (1440 and 390 px, every theme, every connection state). Library gaps the app found are in `apps/web/GAPS.md`.

## connect to zeta

start a local websocket server with an origin allowlist, then start the playground:

```sh
zeta serve --ws 8765 --ws-origin http://localhost:5173
make dev
```

open the live zeta panel and paste the discovery url from `$ZETA_HOME/run/serve.ws.json` (the dev helper can fill it in when available).

## store

`createRunStore()` owns one run. Dispatch generic `RunEvent` values, read ordered `{ id, kind }` entries with `getOutline()`, and read the current entity with `getItem(id)`. The store batches reduction and subscriber notification through its scheduler; synchronous reads flush pending events. Use keyed subscriptions for entity rows and `subscribeOutline()` for the ordered timeline. `getOutlineSnapshot()` returns `{ items, change }`: `change` is `{ from, splices }`, the edits (`{ index, deleteCount, items }`, applied in order) that turn the outline `from` into `items`, merged across one notification; it is `null` on the first snapshot and after dispose. An approval that folds into its tool row is one splice, not a new outline. Malformed known events with an invalid required field are counted by `getDiagnostics()` and ignored. An invalid optional field is omitted, counted in `sanitizedFields`, and the sanitized event is applied; valid events keep their identity and allocate no validation copy. An arbitrary event kind becomes an `unknown` row; the built-in `Fallback` shows only its kind name, not its data. If validated reduction unexpectedly throws, the store reports the error through `onError` and exposes `desynced` plus its reason through `getDiagnostics()` and `subscribeDiagnostics()`. Reads keep returning the last good snapshot, while new dispatches are refused until `resync(events)` installs history. These store guarantees apply through `createRunStore`; internal direct reducer callers own the maps they supply and must keep them with the returned state. `prepend(older)` re-reduces the older page followed by the accepted event log from an empty store. The result is therefore exactly the same as chronological reduction, including generated ids and cross-event folds. Accepted live events apply after older history and win naturally. A reducer rejection publishes no part of the page and enters the same visible desync state as a failed live reduction. Value-equal entities keep their object identity. The outline is one index-0 splice when the old outline is an exact suffix, or one full replacement when ids changed. Its cost is O(older + applied log) per prepend, at most once per page; pages queued in one frame share one reduction. `fromZetaEvent` maps Zeta wire events to generic events, and `connect(transport)` adds JSON-RPC request matching. A `user_message` may carry an `intent`, the client's id for what the user asked: a later user message with the same intent replaces that row in place, so a message the harness dropped and the client resent shows once. `hasMessageDelivery(deliveryId)` reports whether a durable user-message row with that `delivery_id` is present; delivery ids are the durable identity, so an echo with the same id joins the existing row rather than appending another. The Zeta client retries a desync history load immediately, then after 0.5, 1, 2, 4, and 8 seconds (15.5 seconds total), records the final error in store diagnostics, and exposes `retrySession(id)` for an app-owned retry action. The web app wires that action into `RunProvider`; its normal socket reconnect creates a fresh client and rebuilds the open session from history.

build with `bun install --frozen-lockfile`, `bunx tsc -b`, and `bun test`.

## react

```tsx
import { createRunStore } from "@fulcrum/core";
import { Approval, RunProvider, Timeline, type Renderers } from "@fulcrum/react";

const store = createRunStore();
// Keep renderers stable (module scope). Keys are item kinds or `tool:<name>`.
const renderers: Renderers = {
  approval: ({ id }) => <Approval id={id} onApprove={approve} onDeny={deny} />,
};

<RunProvider store={store}>
  <Timeline renderers={renderers} />
</RunProvider>;
```

- hooks: `useRun(selector)` (return a primitive or a reference from state), `useTimeline()` (stable ordered `{ id, kind }` entries), `useItem(id)`, and `useItemSelector(id, selector)`. They use `useSyncExternalStore`, so a text delta re-renders only the item that changed.
- parts: `Timeline`, `Message`, `ToolCall`, `Approval`, `SubAgent`, `RunNavigator`, and `Fallback` for other kinds. Parts have no styles. They take `className` and expose `data-part`, `data-kind`, `data-state` (`streaming`, `done`, `error`, `pending`), `data-role`, and `data-tool`. While a store is desynced, `Timeline` keeps its last good rows and shows an agent-neutral `resyncing…` status. Pass `onRetry` to `RunProvider` to show a retry button after resync fails. Message text stays plain unless a markdown renderer is supplied. The renderer is used for assistant messages by default; set `markdownFor="all"` for user messages or `markdown={false}` for explicit plain text.
- content blocks: a message renders its `content` in order, then its streaming text. Text is markdown (or plain); `reasoning` is a closed disclosure that says "thinking" while it streams and announces "reasoning finished" once; `source` links out; `file` shows name, media type, and size; `image` reserves its box (`width`/`height` when known) and opens on click; any other type is an "unsupported block" with copyable json. Adapters stream a whole block with `{ type: "message_block", block }` and reasoning with `message_delta` `kind: "reasoning"`. Override one type with `blocks`, and open files and images with `onOpen`; the defaults (`ReasoningBlock`, `SourceBlock`, `FileBlock`, `ImageBlock`, `UnknownBlock`) are exported to wrap:

  ```tsx
  type ContentBlockProps = { block: ContentBlock; id: string; streaming: boolean; markdown?: ComponentType<MarkdownContentProps>; onOpen?: (block: FileContentBlock | ImageContentBlock) => void };
  const blocks: BlockRenderers = { source: ({ block }) => <Citation href={safeUrl(block.url)} /> }; // module scope: a stable object
  const renderers: Renderers = { message: ({ id }) => <Message id={id} markdown={Markdown} blocks={blocks} onOpen={openInPanel} /> };
  ```

  Every URL goes through `safeUrl` from `@fulcrum/core`: links are http, https, mailto, or relative; images may also be inline png, jpeg, gif, webp, avif, or bmp `data:` URLs. Any URL longer than `MAX_URL_CHARS` (8 MiB) is refused before any other work. Addresses never become labels, titles, or data attributes.
- tool body slot: `ToolCall` and `Approval` own the one header row (`tool-name`, `tool-summary`, `tool-status`), the disclosure, the state rail, and the approval actions. A per-tool card passes only what goes inside `data-part="tool-body"`, so it never draws a second header:

  ```tsx
  type ToolBodyProps = { item: ToolItem; output: string; state: ItemState };
  type ToolViewProps = { summary?: (item: ToolItem) => string; body?: ComponentType<ToolBodyProps> };

  const ShellBody = ({ output }: ToolBodyProps) => <pre data-part="tool-output">{output}</pre>;
  const renderers: Renderers = { "tool:bash": ({ id }) => <ToolCall id={id} body={ShellBody} /> };
  ```

  `item` is the normalized core tool item, including the agent-neutral `item.view` hint when the adapter set one. `output` is the streamed output plus a final result that adds to it. Approvals pass the requested call, with the `view` an adapter may put on `approval_request`, as an active tool item with no output and state `pending` or `submitting`. The default `body` is `ToolBody`, which picks the card for `item.view.kind` (`ShellBody`, `ReadBody`, `EditBody`, `WriteBody`, `SearchBody`, `FetchBody`) or `GenericBody` with no view; each is exported for reuse in your own body. The default `summary` is `toolSummary`: `$ ls`, `src/a.ts:1-40`, `src/a.ts +3 -1`, `"TODO" packages/`, `example.com/docs`, or the first string argument with no view. `view.durationMs`, when set, shows next to the status word. With a view the part sets `data-tool-view="<kind>"`.
- tool cards: shell shows stdout, then stderr apart when the view has the split streams, and the exit code; read numbers lines from the range start; edit renders a unified diff with old and new line numbers and the changed span marked; write numbers the written content; search groups `path:line:text` matches by file; fetch shows the HTTP status, the full url, and the body. Every card ends in a row of copy buttons (command, path, output). Large output, arguments, file bodies, search results, and diffs show a short preview and open in one fixed-height virtual text viewer. The viewer splits giant lines into 2,000-character segments and mounts at most 200 rows, while copy still returns the complete value. Because only the visible window is mounted, browser find-in-page searches only that window; use the copy control when the complete value must be searched. The open viewer has a head with its line and character counts, whether it is `at bottom`, `scrolled`, or has `new output`, and a jump control.
- highlighting: pass a highlighter to the provider, `<RunProvider store={store} highlight={createHighlighter()}>` (`@fulcrum/highlight`), and every card colors what it structurally knows: the shell command (bash), read and write bodies by the path's extension or file name (`languageForPath`: `Makefile`, `Dockerfile`, `.bashrc`, ...), edit diffs by the file's language with the +/- row tints and the changed span kept, search matches by each file's language with the match marked, fetch bodies by `view.contentType` (`languageForContentType`) or the url's extension, and arguments and JSON outputs as JSON (detected by parsing the whole output, never by guessing; compact JSON under 256 kB is re-indented without re-serializing numbers). Shell output renders ANSI SGR colors, bold, dim, italic, and underline as `ansi-*` classes on theme colors and strips every other control sequence, with bounds that keep hostile output linear; copy returns the text without escapes. Highlighting runs in the highlighter's worker, text shows plain first, and the large viewer highlights only its mounted rows. With no highlighter, cards render the same text plain. Outside a run, `<HighlightContext value={highlight}>` and `<Code text={command} language="shell" id="..." />` color any other text the same way (the web app's `zeta serve` command, for example).
- sub-agents: a `sub_agent` event renders as `SubAgent`, one fixed 56 px row with the state, `name`, `task`, elapsed time, `toolCount`, and `latestActivity`; waiting on the user (`urgency`) is a warn badge. Long text ends in an ellipsis and stays whole in the row's `title` and accessible name. `subAgentRow(item, navigation, now)` is the pure model behind the row (badge, text, title, accessible name, and whether it can open, or why not), for a custom `sub_agent` renderer. The elapsed time of a live row ticks from one shared 1 s clock that runs only while a live row is on screen (an IntersectionObserver, so virtual overscan rows and clipped rows do not count) and the page is visible. To open child runs, render `RunNavigator` instead of `Timeline`, with a `RunSource` (from `@fulcrum/core`) that maps an opaque child run id to its store:
  ```tsx
  const source: RunSource = {
    // May return a Promise. Stop work and reject when `signal` aborts; a lease that arrives after it is released.
    open: (runId, { signal }) => ({ store: storeFor(runId), release: () => releaseStore(runId) }),
    unavailable: (runId) => (known(runId) ? undefined : "started before child runs were recorded"),
  };
  <RunNavigator store={rootStore} source={source} renderers={renderers} highlight={highlight} />
  ```
  A row the source can open is one button; clicking it swaps the child's store into the same timeline under a breadcrumb (parent > child > grandchild), and focus moves to the breadcrumb. Back, Escape, and a crumb return to the exact item and offset you left, in the follow mode you left, with focus on the row. Approvals inside a child render with your `approval` renderer; read the open path with `useRunNavigation()` to route the decision. Give the navigator a height; it scrolls its own timeline.
- run path: the open path is the child run ids below the root (`[]` is the root). By default it lives in the navigator only, starts at the root when `store` changes (with a notice), and never touches browser history. To control it, pass `path` and `onPathChange(path, { replace })`; `replace` is true when the navigator corrects the path rather than the user moving. A controlled path is yours: when you swap `store`, set the path too. Each open is abortable: a newer path, Escape, or unmount aborts it, only the latest open shows, and a stale success is released at once while a stale failure never shows. A run that cannot open (unavailable, already on the path, or a rejected open) falls back to its deepest valid ancestor with a notice. For browser history, spread `useHistoryRunPath(key)`. It works like a router link: the URL is the only state, as repeated `?<key>=<run id>` parameters, read on every render and on `popstate`, `hashchange`, and Navigation API `currententrychange`, so reload, links, and browser back and forward reopen the path the URL names. Each user move (opening a run, back, Escape, a crumb) pushes one entry; a correction (`replace`) replaces the current one; other parameters, the hash, and `history.state` are kept. It never calls `history.back`, `history.go`, or `navigation.traverseTo`, and unmount does nothing, so a host router's entries and hash entries are never stepped over. Use one key per navigator.
  ```tsx
  <RunNavigator store={rootStore} source={source} {...useHistoryRunPath("run")} />
  ```

- composer: `Composer` is the message box under a run. It imports no transport; the host maps its callbacks to the harness:

  ```tsx
  <Composer
    state={running ? (canSteer ? "steerable" : "running") : "idle"} // or state="read-only" reason="observing"
    onSubmit={(text, { steer }) => (steer ? harness.steer(text) : harness.send(text))} // a promise
    onStop={() => harness.abort()}
  />
  ```

  The rules: Enter submits, Shift+Enter adds a newline, and Enter never submits during IME composition (`isComposing` or keyCode 229). A blank draft does not submit, and nothing calls `onSubmit` again while its promise is pending. A rejected promise keeps the draft and shows `could not send: <message>` in a polite status line; Enter or the button retries. A resolved one clears only what was sent: text appended meanwhile stays exactly as typed (blank lines and indentation included), and a draft edited inside the sent part stays whole. The action reads `send` when idle and `steer` in `steerable`. In `running` (the harness cannot take input mid-turn) the action is disabled and the draft waits; nothing is queued. Stop shows only while a turn runs, with `stopping` and `could not stop: <message>` states. `read-only` hides every action and shows `reason`; a draft stays on screen, read-only, and survives the switch. The field is never disabled, so focus stays in it: a click on the action gives focus back to the field without scrolling the page, and when the turn ends under a focused stop button, focus moves to the field. The text and the actions sit at one even inset, and the field text is 16 px on touch and narrow screens (iOS zooms into smaller fields); send is filled accent, steer outlined accent (it is not a warning), stop danger; it grows to ten lines, then scrolls, and the status line has a fixed height, so an error never moves the layout. `defaultValue` sets the first draft; give the composer a `key` per conversation.

- playground: `make dev` rebuilds every workspace package plus the highlight bundle before it starts every playground page, so a fresh clone cannot use missing or stale `dist` output.

- styles: copy `packages/react/styles.css` (layout, states, markdown and code) and `packages/react/themes.css` (color) into your app and edit them. themes.css has 12 real palettes: gruvbox-dark, gruvbox-light, dracula, nord, tokyo-night, catppuccin-mocha, catppuccin-latte, solarized-dark, solarized-light, github-dark, github-light, one-dark. Set `data-fulcrum-theme="<name>"` on `<html>` or any subtree; with no attribute it follows the OS with github-light or github-dark. Each theme also sets `--fulcrum-tok-*` colors for `<span class="tok-<type>">` syntax tokens and the 16 `--fulcrum-ansi-*` terminal colors (its official terminal palette). UI text (fg, muted, accent, ok, warn, danger) reaches 4.5:1 on bg, surface, and the diff row tints in every theme. Syntax and terminal colors keep the official hex where it reaches 3:1 on the backgrounds they sit on; where it does not, they take the smallest OKLCH lightness change at the same hue that does, and a comment names the official value (`packages/react/test/themes.test.ts`). The type is "JetBrains Mono" with monospace fallbacks; load the font yourself.
- wide blocks: message text keeps an 80ch measure (`--fulcrum-measure`, set on `[data-part="message"]`). A block rendered as a direct child of a message with a `data-wide` attribute takes the message's whole content width instead, and the text around it keeps the measure. `@fulcrum/mermaid` diagrams set it; a host's own renderer (a table, a large code block, an image) can set it the same way. A wide block nested inside a list or quote stays in that container's width.
- gallery: every part in every state, no server or session. Run `make dev`, then open `/gallery.html`.
- performance checks: `bun run bench:check` and `bun run size:check`; run the production browser stress report with `bun run stress`. CI's stress gate runs the base and the candidate on the same runner and fails at a 1.20x median slowdown; it catches one large regression, not several small ones that add up (see `apps/playground/scripts/stress-ab.ts`).


## markdown

```tsx
import { Markdown } from "@fulcrum/markdown/react";
import { Message } from "@fulcrum/react";

<Message id={id} markdown={Markdown} />;
```

The streaming document freezes completed blocks, table rows, and list items. Open fences and plain paragraphs consume only appended text. `Markdown` covers CommonMark and GFM message content: ATX/setext headings, paragraphs, inline/indented/fenced code, nested/task lists, emphasis, reference and literal links, images, blockquotes, tables, rules, entities, and hard breaks. Raw HTML stays escaped. Links and images follow `safeUrl` from `@fulcrum/core`: HTTP(S), `mailto:`, and relative URLs, plus size-capped inline raster images.

Code blocks accept the `Highlight` returned by `createHighlighter()` from `@fulcrum/highlight`. The shared callback receives `(code, language, { id, version, state })` and returns tokens immediately or in a promise. `state` is `streaming` or `done`; stale async results are ignored. Tokens without a `type` render as plain text; styled token classes are `tok-keyword`, `tok-string`, `tok-number`, `tok-comment`, `tok-function`, `tok-type`, `tok-variable`, `tok-constant`, `tok-operator`, `tok-punctuation`, `tok-tag`, `tok-attribute`, `tok-regexp`, `tok-inserted`, and `tok-deleted`. Copy `@fulcrum/react/styles.css` and `@fulcrum/react/themes.css`; also copy `@fulcrum/highlight/styles.css` when code highlighting is enabled. Regenerate the vendored parser with `bun run vendor:markdown-it`.

A fenced block over 40 lines, or with more tokens than one commit should draw, is the same bounded virtual viewer the tool cards use, at the height of 40 lines: it colors its visible 500-character ranges first; once they have colored, a block of at most 10,000 characters is also colored whole in the background, so a comment or string that crosses a range edge settles to the right colors. A larger block keeps each range's own colors, so a construct longer than a range (a long block comment or docstring) can show the wrong colors after a range edge. A streaming fence follows its newest line. Only the visible window is mounted, so browser find-in-page reaches only the visible lines; the copy control copies the whole block.

The headless renderer has no visual styles. Its stable styling hooks are `data-part="md-paragraph"`, `md-heading`, `md-code-inline`, `md-code-block`, `md-list`, `md-list-item`, `md-emphasis`, `md-strong`, `md-strike`, `md-link`, `md-image`, `md-blockquote`, `md-table`, `md-rule`, and `md-break`. Code blocks also expose `data-language`.

## known limits

- TODO: add session eviction before using a client as a persistent multi-session shell.

## virtual

`@fulcrum/virtual` is a zero-dependency, framework-agnostic vertical windowing engine. `createVirtualizer` accepts generic `{ id, kind }` outlines, kind-based estimates, and an optional cache from `snapshotCache()`. Its small interface owns measured per-kind medians, capped overscan ranges, stable or end-relative anchor corrections, deferred momentum-scroll jumps, pinned-bottom decisions, and a bounded structured action log. Callers apply the returned rows, spacers, and scroll decisions in their own renderer; the package does not use React, the DOM, or browser APIs. `setOutline(items, { from, splices })` edits the layout in place when `from` is the outline it last received, keeping measured sizes and the anchor; any other call (no update, or a `from` it did not see) rebuilds.

## render an AI SDK stream

`@fulcrum/ai-sdk` translates the Vercel AI SDK UI message stream into the same `RunEvent` values used by every Fulcrum timeline. It implements the `x-vercel-ai-ui-message-stream: v1` protocol as shipped by `ai@6.0.0`; `ai` is not a runtime dependency.

```tsx
import { createRunStore } from "@fulcrum/core";
import { createAiSdkAdapter } from "@fulcrum/ai-sdk";
import { RunProvider, Timeline } from "@fulcrum/react";
import "@fulcrum/react/styles.css";

const store = createRunStore();
// Use a stable request or user-message id that is unique within this run.
const adapter = createAiSdkAdapter({ streamKey: "chat-request-123" });

// Call this for each parsed `data: {...}` UI message stream part.
export function onAiSdkPart(part: unknown) {
  for (const event of adapter.decode(part)) store.dispatch(event);
}

export function AgentRun() {
  return <RunProvider store={store}><Timeline /></RunProvider>;
}
```

Keep one adapter instance per AI SDK message stream. Its required `streamKey` must be stable across replay and unique within the run; a chat request id or user message id is a good key. Feed it the JSON object from each SSE `data:` record and ignore the final `[DONE]` record. Malformed records become a generic `adapter_invalid_payload` error event; they do not throw from the callback. Source and file parts become harness-neutral message content blocks. Provider and tool protocol details stay in generic `meta` bags. Custom `data-*` parts are preserved in full as generic `unknown` events so a host can render them without changing the adapter.

AI SDK entity ids use disjoint `w:<kind>:<escaped-wire-id>` and `s:<kind>:<escaped-stream-key>:<counter>` namespaces, with `%` and `:` escaped so arbitrary wire ids cannot collide with synthetic ids. Use `decodeAiSdkEntityId` or the original ids in message and tool metadata for any value sent back to the AI SDK; Fulcrum's built-in UI treats encoded ids as internal keys and does not display them.

## verify an adapter

`@fulcrum/adapter-test` is a test-only package, separate from `@fulcrum/core` so production consumers do not ship fixtures or assertions. Its framework-neutral runner owns the canonical behavior list and accepts adapter-owned wire fixtures:

```ts
import { runAdapterConformance } from "@fulcrum/adapter-test";

const failures = runAdapterConformance({
  name: "my-harness",
  fixtures, // records with scenario, sessionId, and harness wire data
  create: (streamKey) => ({ decode: (record) => createAdapter(streamKey).decode(record.wire) }),
  capabilities: {
    approval: false,
    reasoning: true,
    reset: false,
    usage: true,
  }, // the kit requires fixtures and assertions only for declared capabilities
});
if (failures.length) throw new Error(failures.join("\n"));
```

The canonical scenarios cover text stream and commit, tool argument streaming or complete arguments, tool output/end/error, abort, unknown and malformed input, session isolation, adversarial wire/synthetic id collisions and separators, distinct replay-stable ids for independent streams in one run, and stable ids after reconnect replay. Reasoning, approval, reset/retry, and usage are checked only when the adapter declares those capabilities. Both `@fulcrum/zeta` and `@fulcrum/ai-sdk` run this same kit. The AI SDK fixtures are generated by `ai@6.0.0` with its token-free `MockLanguageModelV3`; regenerate them with `bun run --cwd packages/ai-sdk fixtures`.

Virtual mode mounts only the visible window, so native find-in-page can find only mounted rows. A full-session search interface is planned. Until it is available, use `<Timeline virtual={false}>` when native find-in-page must search the complete transcript.

## use fulcrum with another harness

the cards are generic; a harness maps its own tool names to them. a tool map is the middleware layer: it reads a tool call's arguments and returns one of fulcrum's agent-neutral views, defined in `@fulcrum/core`:

| `kind` | fields | card |
| --- | --- | --- |
| `shell` | `command`, `cwd?`, `exitCode?`, `stdout?`, `stderr?` | `$ command`, output, stderr apart, exit code |
| `read` | `path`, `range?: { offset?, limit? }` (offset is lines skipped) | numbered lines |
| `edit` | `path`, `diff` (unified diff) | diff with gutters and line numbers |
| `write` | `path`, `content?`, `bytes?` | numbered written content |
| `search` | `pattern`, `path?`, `matches?` | matches grouped by file |
| `fetch` | `url` or `query`, `status?`, `title?`, `bytes?` | status, url, body |

every view can also carry `durationMs`. a tool with no view gets the generic card (output and json arguments), so nothing is lost. resolvers receive safe argument readers; missing or invalid arguments return no view instead of throwing. `lineDiff(before, after)` writes the unified diff for edit tools that take old and new strings.

zeta's map ships in `@fulcrum/zeta` as `zetaTools`, and its adapter attaches the views for you (plus `exitCode`, `stdout`, and `stderr` from bash's `structured_content`):

| zeta tool | view |
| --- | --- |
| `bash`, `run_background` | `shell` from `command` (or the old `cmd`) and `cwd` |
| `read` | `read` from `path`, `offset`, `limit` |
| `edit` | `edit`: one hunk per `old_string`/`new_string` pair, or per entry of `edits` |
| `write` | `write` from `path` and `content` |
| `fetch` | `fetch` from `url` |
| `websearch` | `fetch` from `query` |
| everything else (`agent`, `todo`, `skill`, ...) | generic |

a second harness writes its own map the same way. this one is for Claude Code's tool names, and has its own test in `packages/core/test/tool-map.test.ts`:

```ts
import { defineToolMap, lineDiff, resolveToolView } from "@fulcrum/core";

const claudeCodeTools = defineToolMap({
  Bash: (args) => {
    const command = args.string("command");
    return command ? { kind: "shell", command } : undefined;
  },
  Read: (args) => {
    const path = args.string("file_path");
    return path ? { kind: "read", path } : undefined;
  },
  Edit: (args) => {
    const path = args.string("file_path");
    const before = args.string("old_string");
    const after = args.string("new_string");
    return path && before !== undefined && after !== undefined ? { kind: "edit", path, diff: lineDiff(before, after) } : undefined;
  },
});

// in your adapter, for tool_start, tool_end, and approval_request:
const event = { type: "tool_start", tool_call: toolCall, view: resolveToolView(claudeCodeTools, toolCall) };
```

`applyToolMap` adds the view to an existing tool item instead. `@fulcrum/core` and `@fulcrum/react` never import a harness package.

an approval ends with `approval_end`, whose `decision` is fulcrum's one vocabulary: `"approve"`, `"deny"`, or `"abort"` (leave it unset when the harness does not say). the adapter maps its harness's words onto it: `@fulcrum/zeta` maps zeta's `allow`/`deny`/`abort`, and `@fulcrum/ai-sdk` sets `deny` on `tool-output-denied` and `approve` once an approved tool returns. the card reads only `decision` (approved in ok, denied in danger) and, for other endings, `data.reason`.
