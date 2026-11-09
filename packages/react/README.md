# @fulcrum/react

`@fulcrum/react` provides React 19 hooks and headless parts over `@fulcrum/core`. It does not import `@fulcrum/zeta`.

## basic usage

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

## Timeline

`Timeline` has two scroll modes:

| mode | interface | layout contract |
| --- | --- | --- |
| owned (default) | omit `scrollRef` | `Timeline` renders `timeline-frame`, an inner `timeline-scroll`, and, in virtual mode only, a permanent jump-control lane. Give the host a definite height, such as `height: 600px` or a bounded flex child with `min-height: 0`. The lane always reserves the control's space, so the control never covers transcript text or shifts it when it appears. |
| host-owned | pass `scrollRef` and `renderJumpToLatest` | `scrollRef.current` is the existing scroll element. `Timeline` reads it and never overwrites the ref. It renders no frame, inner scroller, or lane. Put the jump control in host layout that does not cover transcript text; a portal to a permanent sibling lane is the usual shape. |

Outlines above 200 rows use virtual mode by default. Set `virtual={false}` when native find-in-page must search every row. Virtual mode mounts only the visible window. `initialViewport` restores a reading position, and `onViewport` receives it when the store changes or the timeline unmounts. Non-virtual timelines have no jump lane.

A scroll-host change is one atomic transfer: the engine owns the reader's position intent (follow-bottom or anchor) until a measured layout on the current host confirms it. A pinned reader lands at the new bottom, and an unpinned reader keeps the same anchor and offset, including when the outline changes in the transfer commit. A pending correction folds into that anchor instead of remaining as separate work. A null gap keeps the intent until the next host attaches. Old-host measurements are dropped for the new host to measure again, and touch, timer, and correction ownership never remains attached to the old element.

In development, an owned virtual timeline warns once if more than 200 rows all mount and its inner scroll height equals its client height. This means the frame is unconstrained. Give the host a definite height, or use host-owned mode. The browser-safe default keeps this diagnostic enabled. Vite strips the branch with `define: { "globalThis.__FULCRUM_DEV__": "false" }`. Webpack strips it with `new DefinePlugin({ "globalThis.__FULCRUM_DEV__": false })`. Esbuild 0.25 keeps the unreachable warning body from an imported package; use `pure: ["console.warn"]` (or `--pure:console.warn`) to remove it. Bun 1.4.4 also keeps the imported body; use `bun build --drop console.warn`. The esbuild and Bun settings remove other `console.warn` calls too. Production mode alone does not promise removal. Real tiny-consumer builds verified all four forms.

```tsx
import { useRef } from "react";
import { createPortal } from "react-dom";

const scrollRef = useRef<HTMLDivElement>(null);
const jumpLaneRef = useRef<HTMLDivElement>(null);

<div ref={scrollRef} style={{ height: 600, overflow: "auto" }}>
  <Timeline
    scrollRef={scrollRef}
    renderJumpToLatest={(control) =>
      jumpLaneRef.current ? createPortal(control, jumpLaneRef.current) : null
    }
  />
</div>
<div ref={jumpLaneRef} className="permanent-jump-lane" />
```

Migration: before, `Timeline` scrolled its outer element; now owned mode scrolls its inner `timeline-scroll`. For a Gamma-style app that lets the library own scrolling, remove the outer scroll behavior and `scrollRef`, give the host a definite height, and target `timeline-frame` for column layout. If the outer element must remain the scroller, keep its ref, pass it as `scrollRef`, and supply `renderJumpToLatest`; the ref remains owned by the host.

When a host accepts a local send or steer, increment `followRequest` on `Timeline` to follow that message to the bottom even if the reader was previously scrolled up. Do not bump it for replayed history or remote user messages; those are new content and must preserve the reader's position.

## hooks, parts, and content

- hooks: `useRun(selector)` (return a primitive or a reference from state), `useTimeline()` (stable ordered `{ id, kind }` entries), `useItem(id)`, and `useItemSelector(id, selector)`. They use `useSyncExternalStore`, so a text delta re-renders only the item that changed.
- parts: `Timeline`, `Message`, `ToolCall`, `Approval`, `SubAgent`, `Notification`, `RunNavigator`, and `Fallback` for other kinds. `RunStatus` (`data-part="run-status"`, `data-status` of `idle`, `running`, `approval`, or `unknown`) is a compact header status, and `useRunStatus()` returns the same value. `RunEndMarker` (`run-end-marker`, `data-outcome`) renders only when the host reported an outcome: "run completed", "run stopped", "run failed", "run stopped: client disconnected", or "? outcome unknown" with screen-reader text "run ended while disconnected; outcome unknown". The next run start removes it. Place it outside the scroll box (the web app puts it between the timeline and the composer), so it stays in view and does not change the timeline's bottom. Parts have no styles. They take `className` and expose `data-part`, `data-kind`, `data-state` (`streaming`, `done`, `error`, `pending`), `data-role`, and `data-tool`. While a store is desynced, `Timeline` keeps its last good rows and shows an agent-neutral `resyncing…` status. Pass `onRetry` to `RunProvider` to show a retry button after resync fails. Message text stays plain unless a markdown renderer is supplied. The renderer is used for assistant messages by default; set `markdownFor="all"` for user messages or `markdown={false}` for explicit plain text. A user message has an aria-hidden `message-prompt` beside one `message-content` wrapper. Style these parts directly; the old message `::before` prompt no longer exists.
- notifications: `Notification` renders a `notification` item as one quiet line. It reads only these string keys of `event.data`, the first present one in each list: text from `text`, `message`, `summary`, `title`, `preview`, `description`, `content`; kind from `kind`, `type`; status from `status`, `level`; time from `timestamp`, `time`, `created_at`. Nested objects, arrays, other keys, and getters that throw are never read into the DOM. The line is the first non-empty text line, flattened and cut to 240 characters (`notification` when there is no text). When the data also has a kind, status, or time, or the line cut its text, the row is a native `<details>` disclosure (collapsed preview at most two lines in the default styles) whose body lists those facts and the full text, cut at 10,000 characters; kind and status are cut at 120. A time is an ISO string or a number: below `1e11` it is seconds since the epoch, from `1e11` milliseconds, so a millisecond time before 1973-03-03 must be sent as an ISO string. The row shows the local clock time (`<time>` with the full ISO instant as `datetime` and `title`). `notificationModel(data)` returns the same `NotificationModel` (`summary`, and optional `text`, `kind`, `status`, `time: { iso, label }`) for a custom `notification` renderer.
- content blocks: a message renders its `content` in order, then its streaming text. Text is markdown (or plain); `reasoning` is a closed disclosure that says "thinking" while it streams and announces "reasoning finished" once; `source` links out; `file` shows name, media type, and size; `image` reserves its box (`width`/`height` when known) and opens on click; any other type is an "unsupported block" with copyable json. Adapters stream a whole block with `{ type: "message_block", block }` and reasoning with `message_delta` `kind: "reasoning"`. Override one type with `blocks`, and open files and images with `onOpen`; the defaults (`ReasoningBlock`, `SourceBlock`, `FileBlock`, `ImageBlock`, `UnknownBlock`) are exported to wrap:

  ```tsx
  type ContentBlockProps = { block: ContentBlock; id: string; streaming: boolean; markdown?: ComponentType<MarkdownContentProps>; onOpen?: (block: FileContentBlock | ImageContentBlock) => void };
  const blocks: BlockRenderers = { source: ({ block }) => <Citation href={safeUrl(block.url)} /> }; // module scope: a stable object
  const renderers: Renderers = { message: ({ id }) => <Message id={id} markdown={Markdown} blocks={blocks} onOpen={openInPanel} /> };
  ```

  Every URL goes through `safeUrl` from `@fulcrum/core`: links are http, https, mailto, or relative; images may also be inline png, jpeg, gif, webp, avif, or bmp `data:` URLs. Any URL longer than `MAX_URL_CHARS` (8 MiB) is refused before any other work. Addresses never become labels, titles, or data attributes.
- delivery note: a user row whose message was dropped shows a `data-part="delivery-note"` line under its text: "not delivered", plus why in words for the known reasons (`turn_end` "the turn ended first", `abort` "the run was stopped", `clear` "the pending steers were cleared", `disconnect` "the connection was lost", `failed` "the turn failed", `restart` "the server restarted"). An unknown reason shows only "not delivered", never the raw token. The note is plain text after the message, so a screen reader reads it right after the message text. Pass `renderDeliveryNote` to `Fallback` to show your own note (for example with a resend button). It gets every user message row as a `UserMessageItem` (read `item.event.delivery_status` and `delivery_reason`); return a node to put in the note, or `null` for no note. Pass a stable function:

  ```tsx
  const note = (item: UserMessageItem) => item.event.delivery_status === "dropped" ? <>not sent <ResendButton id={item.id} /></> : null;
  const renderers: Renderers = { user: ({ id }) => <Fallback id={id} renderDeliveryNote={note} /> }; // module scope
  ```
- approval actions: `Approval` takes `onApprove` and `onDeny`, each called with the request id. Return a promise to keep the card busy (`approving` or `denying`, every action `aria-disabled`) until it settles; reject to show the error and re-enable the actions. Pass `onApproveAlways` to offer a third action between them (`data-action="approve-always"`, text `approveAlwaysLabel`, default `always allow`) for a host that can approve this call and remember the grant. It shares approve's busy word, error, and disabled states; without it the card renders exactly as before. The decided card still reads `approved`, because `approval_end` does not say whether the grant was remembered. `disabledReason` disables every action and shows the reason.
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
- notifications: a `notification` item renders as `Notification` (`data-part="notification"`, `aria-label="notification"`). A notification's `data` has no fixed shape, so the part reads only a few keys and only string values: the summary is the first nonblank `text`, `message`, `summary`, `title`, `preview`, `description`, or `content` (else "notification"), as one line of at most 240 characters. It also reads `kind` (or `type`), `status` (or `level`, also set as `data-status`), and a time from `timestamp`, `time`, or `created_at` (an ISO string, or seconds or milliseconds since the epoch; shown as a `<time>`). With none of these and a short one-line text, the row is a `div` with role `group`. Otherwise it is a `<details>` whose `summary` is the line and whose body holds a `notification-meta` list and, when the line cut or flattened the text, the full text (`notification-text`, at most 10,000 characters). Nested objects, arrays, other keys, and values whose read throws never render, so an adapter's private payload stays out of the DOM. `notificationModel(data)` is the pure model behind the row, for a custom `notification` renderer.
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

- styles: copy `packages/react/styles.css` (layout, states, markdown and code) and `packages/react/themes.css` (color) into your app and edit them. themes.css has 12 real palettes: gruvbox-dark, gruvbox-light, dracula, nord, tokyo-night, catppuccin-mocha, catppuccin-latte, solarized-dark, solarized-light, github-dark, github-light, one-dark. Set `data-fulcrum-theme="<name>"` on `<html>` or any subtree; with no attribute it follows the OS with github-light or github-dark. Each theme also sets `--fulcrum-tok-*` colors for `<span class="tok-<type>">` syntax tokens and the 16 `--fulcrum-ansi-*` terminal colors (its official terminal palette). UI text (fg, muted, accent, ok, warn, danger) reaches 4.5:1 on bg, surface, and the diff row tints in every theme. Status text (ok, warn, danger) keeps a floor of 4.6:1 there and on its run-end-marker tint, and 3.1:1 as a mark (rails, squares, borders): a color that passes 4.5:1 or 3:1 only by rounding can drop below AA under another blend, gamma, or subpixel rendering. Syntax colors keep the official hex where it reaches 4.5:1 on bg, surface, and the diff row tints, and terminal colors where it reaches 3:1 on bg and surface; where it does not, they take the smallest OKLCH lightness change at the same hue that does, and a comment names the official value (`packages/react/test/themes.test.ts`). The type is "JetBrains Mono" with monospace fallbacks; load the font yourself.
- streaming cursor: a streaming message ends its last text line with a block cursor in `--fulcrum-cursor` (default `--fulcrum-fg`; CanvasText under forced colors). Set it on `[data-part="message"]` or any ancestor to recolor it.
- wide blocks: message text keeps an 80ch measure (`--fulcrum-measure`, set on `[data-part="message"]`). A block rendered as a direct child of a message with a `data-wide` attribute takes the message's whole content width instead, and the text around it keeps the measure. `@fulcrum/mermaid` diagrams set it; a host's own renderer (a table, a large code block, an image) can set it the same way. A wide block nested inside a list or quote stays in that container's width.
- gallery: every part in every state, no server or session. Run `make dev`, then open `/gallery.html`.
- performance checks: `bun run bench:check` and `bun run size:check`; run the production browser stress report with `bun run stress`. CI's stress gate runs the base and the candidate on the same runner and fails at a 1.20x median slowdown; it catches one large regression, not several small ones that add up (see `apps/playground/scripts/stress-ab.ts`).
