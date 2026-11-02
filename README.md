# fulcrum core
# fulcrum core

start: `make dev` installs, builds every package, and runs the playground (then open `/gallery.html`). `make test` builds and runs the tests; `make clean` removes builds.

## packages

- `@fulcrum/core`: agent-agnostic run events and a burst-coalescing run store.
- `@fulcrum/zeta`: zeta serve wire types, adapter, JSON-RPC client, websocket transport, and authenticated `connectZeta`.
- `@fulcrum/react`: react 19 hooks and headless timeline parts over `@fulcrum/core`. It does not depend on `@fulcrum/zeta`.
- `@fulcrum/markdown`: zero-dependency streaming markdown with a framework-free document core and an optional `@fulcrum/markdown/react` renderer.
- `apps/playground` (private): replays the zeta fixtures, runs a stress test, or connects to a live zeta server in a browser.

## connect to zeta

start a local websocket server with an origin allowlist, then start the playground:

```sh
zeta serve --ws 8765 --ws-origin http://localhost:5173
make dev
```

open the live zeta panel and paste the discovery url from `$ZETA_HOME/run/serve.ws.json` (the dev helper can fill it in when available).

## store

`createRunStore()` owns one run. Dispatch generic `RunEvent` values, read ordered `{ id, kind }` entries with `getOutline()`, and read the current entity with `getItem(id)`. The store batches reduction and subscriber notification through its scheduler; synchronous reads flush pending events. Use keyed subscriptions for entity rows and `subscribeOutline()` for the ordered timeline. `fromZetaEvent` maps Zeta wire events to generic events, and `connect(transport)` adds JSON-RPC request matching.

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
- parts: `Timeline`, `Message`, `ToolCall`, `Approval`, and `Fallback` for other kinds. Parts have no styles. They take `className` and expose `data-part`, `data-kind`, `data-state` (`streaming`, `done`, `error`, `pending`), `data-role`, and `data-tool`. Message text stays plain unless a markdown renderer is supplied. The renderer is used for assistant messages by default; set `markdownFor="all"` for user messages or `markdown={false}` for explicit plain text.
- tool body slot: `ToolCall` and `Approval` own the one header row (`tool-name`, `tool-summary`, `tool-status`), the disclosure, the state rail, and the approval actions. A per-tool card passes only what goes inside `data-part="tool-body"`, so it never draws a second header:

  ```tsx
  type ToolBodyProps = { item: ToolItem; output: string; state: ItemState };
  type ToolViewProps = { summary?: (item: ToolItem) => string; body?: ComponentType<ToolBodyProps> };

  const ShellBody = ({ output }: ToolBodyProps) => <pre data-part="tool-output">{output}</pre>;
  const renderers: Renderers = { "tool:bash": ({ id }) => <ToolCall id={id} body={ShellBody} /> };
  ```

  `item` is the normalized core tool item, including the agent-neutral `item.view` hint when the adapter set one. `output` is the streamed output plus a final result that adds to it. Approvals pass the requested call, with the `view` an adapter may put on `approval_request`, as an active tool item with no output and state `pending` or `submitting`. The default `body` is `ToolBody`, which picks the card for `item.view.kind` (`ShellBody`, `ReadBody`, `EditBody`, `WriteBody`, `SearchBody`, `FetchBody`) or `GenericBody` with no view; each is exported for reuse in your own body. The default `summary` is `toolSummary`: `$ ls`, `src/a.ts:1-40`, `src/a.ts +3 -1`, `"TODO" packages/`, `example.com/docs`, or the first string argument with no view. `view.durationMs`, when set, shows next to the status word. With a view the part sets `data-tool-view="<kind>"`.
- tool cards: shell shows stdout, then stderr apart when the view has the split streams, and the exit code; read numbers lines from the range start; edit renders a unified diff with old and new line numbers and the changed span marked; write numbers the written content; search groups `path:line:text` matches by file; fetch shows the HTTP status, the full url, and the body. Every card ends in a row of copy buttons (command, path, output). Large output, arguments, file bodies, search results, and diffs show a short preview and open in one fixed-height virtual text viewer. The viewer splits giant lines into 2,000-character segments and mounts at most 200 rows, while copy still returns the complete value. Because only the visible window is mounted, browser find-in-page searches only that window; use the copy control when the complete value must be searched.

- playground: `make dev` rebuilds every workspace package plus the highlight bundle before it starts every playground page, so a fresh clone cannot use missing or stale `dist` output.

- styles: copy `packages/react/styles.css` (layout, states, markdown and code) and `packages/react/themes.css` (color) into your app and edit them. themes.css has 12 real palettes: gruvbox-dark, gruvbox-light, dracula, nord, tokyo-night, catppuccin-mocha, catppuccin-latte, solarized-dark, solarized-light, github-dark, github-light, one-dark. Set `data-fulcrum-theme="<name>"` on `<html>` or any subtree; with no attribute it follows the OS with github-light or github-dark. Each theme also sets `--fulcrum-tok-*` colors for `<span class="tok-<type>">` syntax tokens. The type is "JetBrains Mono" with monospace fallbacks; load the font yourself.
- gallery: every part in every state, no server or session. Run `make dev`, then open `/gallery.html`.
- performance checks: `bun run bench:check` and `bun run size:check`; run the production browser stress report with `bun run stress`.


## markdown

```tsx
import { Markdown } from "@fulcrum/markdown/react";
import { Message } from "@fulcrum/react";

<Message id={id} markdown={Markdown} />;
```

The streaming document freezes completed blocks, table rows, and list items. Open fences and plain paragraphs consume only appended text. `Markdown` covers CommonMark and GFM message content: ATX/setext headings, paragraphs, inline/indented/fenced code, nested/task lists, emphasis, reference and literal links, images, blockquotes, tables, rules, entities, and hard breaks. Raw HTML stays escaped. Link and image protocols are limited to HTTP(S), `mailto:`, and relative URLs.

Code blocks accept the `Highlight` returned by `createHighlighter()` from `@fulcrum/highlight`. The shared callback receives `(code, language, { id, version, state })` and returns tokens immediately or in a promise. `state` is `streaming` or `done`; stale async results are ignored. Tokens without a `type` render as plain text; styled token classes are `tok-keyword`, `tok-string`, `tok-number`, `tok-comment`, `tok-function`, `tok-type`, `tok-variable`, `tok-constant`, `tok-operator`, `tok-punctuation`, `tok-tag`, `tok-attribute`, `tok-regexp`, `tok-inserted`, and `tok-deleted`. Copy `@fulcrum/react/styles.css` and `@fulcrum/react/themes.css`; also copy `@fulcrum/highlight/styles.css` when code highlighting is enabled. Regenerate the vendored parser with `bun run vendor:markdown-it`.

The headless renderer has no visual styles. Its stable styling hooks are `data-part="md-paragraph"`, `md-heading`, `md-code-inline`, `md-code-block`, `md-list`, `md-list-item`, `md-emphasis`, `md-strong`, `md-strike`, `md-link`, `md-image`, `md-blockquote`, `md-table`, `md-rule`, and `md-break`. Code blocks also expose `data-language`.

## known limits

- TODO: add session eviction before using a client as a persistent multi-session shell.

## virtual

`@fulcrum/virtual` is a zero-dependency, framework-agnostic vertical windowing engine. `createVirtualizer` accepts generic `{ id, kind }` outlines, kind-based estimates, and an optional cache from `snapshotCache()`. Its small interface owns measured per-kind medians, capped overscan ranges, stable or end-relative anchor corrections, deferred momentum-scroll jumps, pinned-bottom decisions, and a bounded structured action log. Callers apply the returned rows, spacers, and scroll decisions in their own renderer; the package does not use React, the DOM, or browser APIs.

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
