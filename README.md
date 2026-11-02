# fulcrum core

## packages

- `@fulcrum/core`: agent-agnostic run events and a burst-coalescing run store.
- `@fulcrum/zeta`: zeta serve wire types, adapter, JSON-RPC client, websocket transport, and authenticated `connectZeta`.
- `@fulcrum/react`: react 19 hooks and headless timeline parts over `@fulcrum/core`. It does not depend on `@fulcrum/zeta`.
- `apps/playground` (private): replays the zeta fixtures, runs a stress test, or connects to a live zeta server in a browser.

## connect to zeta

start a local websocket server with an origin allowlist, then start the playground:

```sh
zeta serve --ws 8765 --ws-origin http://localhost:5173
bun run dev
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
- parts: `Timeline`, `Message`, `ToolCall`, `Approval`, and `Fallback` for other kinds. Parts have no styles. They take `className` and expose `data-part`, `data-kind`, `data-state` (`streaming`, `done`, `error`, `pending`), `data-role`, and `data-tool`. Text is plain text with `white-space: pre-wrap`.
- tool body slot: `ToolCall` and `Approval` own the one header row (`tool-name`, `tool-summary`, `tool-status`), the disclosure, the state rail, and the approval actions. A per-tool card passes only what goes inside `data-part="tool-body"`, so it never draws a second header:

  ```tsx
  type ToolBodyProps = { item: ToolItem; output: string; state: ItemState };
  type ToolViewProps = { summary?: (item: ToolItem) => string; body?: ComponentType<ToolBodyProps> };

  const ShellBody = ({ output }: ToolBodyProps) => <pre data-part="tool-output">{output}</pre>;
  const renderers: Renderers = { "tool:bash": ({ id }) => <ToolCall id={id} body={ShellBody} /> };
  ```

  `item` is the normalized core tool item, including the agent-neutral `item.view` hint when the adapter set one. `output` is the streamed output plus a final result that adds to it. Approvals pass the requested call, with the `view` an adapter may put on `approval_request`, as an active tool item with no output and state `pending` or `submitting`. The default `body` is `ToolBody`, which picks the card for `item.view.kind` (`ShellBody`, `ReadBody`, `EditBody`, `WriteBody`, `SearchBody`, `FetchBody`) or `GenericBody` with no view; each is exported for reuse in your own body. The default `summary` is `toolSummary`: `$ ls`, `src/a.ts:1-40`, `src/a.ts +3 -1`, `"TODO" packages/`, `example.com/docs`, or the first string argument with no view. `view.durationMs`, when set, shows next to the status word. With a view the part sets `data-tool-view="<kind>"`.
- tool cards: shell shows stdout, then stderr apart when the view has the split streams, and the exit code; read numbers lines from the range start; edit renders a unified diff with old and new line numbers and the changed span marked; write numbers the written content; search groups `path:line:text` matches by file; fetch shows the HTTP status, the full url, and the body. Every card ends in a row of copy buttons (command, path, output). Long output shows its first 40 and last 20 lines until "show all", and no body ever puts more than 100 kB of text in the DOM; copy still copies all of it.

- playground: `bunx tsc -b`, then `bun run --cwd apps/playground dev`

- styles: copy `packages/react/styles.css` (layout, states, markdown and code) and `packages/react/themes.css` (color) into your app and edit them. themes.css has 12 real palettes: gruvbox-dark, gruvbox-light, dracula, nord, tokyo-night, catppuccin-mocha, catppuccin-latte, solarized-dark, solarized-light, github-dark, github-light, one-dark. Set `data-fulcrum-theme="<name>"` on `<html>` or any subtree; with no attribute it follows the OS with github-light or github-dark. Each theme also sets `--fulcrum-tok-*` colors for `<span class="tok-<type>">` syntax tokens. The type is "JetBrains Mono" with monospace fallbacks; load the font yourself.
- playground: `bunx tsc -b`, then `bun run --cwd apps/playground dev`.
- gallery: every part in every state, no server or session. Run `bun run dev` in `apps/playground`, then open `/gallery.html`.
- performance checks: `bun run bench:check` and `bun run size:check`; run the production browser stress report with `bun run stress`.


## known limits

- TODO: add session eviction before using a client as a persistent multi-session shell.

## virtual

`@fulcrum/virtual` is a zero-dependency, framework-agnostic vertical windowing engine. `createVirtualizer` accepts generic `{ id, kind }` outlines, kind-based estimates, and an optional cache from `snapshotCache()`. Its small interface owns measured per-kind medians, capped overscan ranges, stable or end-relative anchor corrections, deferred momentum-scroll jumps, pinned-bottom decisions, and a bounded structured action log. Callers apply the returned rows, spacers, and scroll decisions in their own renderer; the package does not use React, the DOM, or browser APIs.

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
