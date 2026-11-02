# fulcrum core

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
- parts: `Timeline`, `Message`, `ToolCall`, `Approval`, and `Fallback` for other kinds. Parts have no styles. They take `className` and expose `data-part`, `data-kind`, `data-state` (`streaming`, `done`, `error`, `pending`), `data-role`, and `data-tool`. Message text stays plain unless a markdown renderer is supplied. The renderer is used for assistant messages by default; set `markdownFor="all"` for user messages or `markdown={false}` for explicit plain text.

- playground: `bunx tsc -b`, then `bun run --cwd apps/playground dev`

- styles: copy `packages/react/styles.css` into your app and edit the `--fulcrum-*` variables. It follows the OS light or dark mode (set `data-fulcrum-theme="light"` or `"dark"` on `<html>` to force one) and uses `content-visibility: auto` for long timelines.
- playground: `bunx tsc -b`, then `bun run --cwd apps/playground dev`.
- gallery: every part in every state, no server or session. Run `bun run dev` in `apps/playground`, then open `/gallery.html`.
- performance checks: `bun run bench:check` and `bun run size:check`; run the production browser stress report with `bun run stress`.


## markdown

```tsx
import { Markdown } from "@fulcrum/markdown/react";
import { Message } from "@fulcrum/react";

<Message id={id} markdown={Markdown} />;
```

The streaming document freezes completed blocks and reparses only its open tail. `Markdown` renders headings, paragraphs, inline and fenced code, nested/task lists, emphasis, safe links, blockquotes, GFM tables, rules, and hard breaks. Raw HTML stays escaped. Link protocols are limited to HTTP(S), `mailto:`, and relative URLs.

Code blocks accept `highlight(code, language, context?)`. Existing two-argument callbacks still work. `context` contains a stable block `id`, a monotonic complete-line `version`, and the opaque `state` returned by the prior call. Return a token array, `{ tokens, state? }`, a promise of either, or `null`. Tokens without a `type` render as plain text; styled token classes are `tok-keyword`, `tok-string`, `tok-number`, `tok-comment`, `tok-function`, `tok-type`, `tok-variable`, `tok-constant`, `tok-operator`, `tok-punctuation`, `tok-tag`, `tok-attribute`, `tok-regexp`, `tok-inserted`, and `tok-deleted`.

The headless renderer has no visual styles. Its stable styling hooks are `data-part="md-paragraph"`, `md-heading`, `md-code-inline`, `md-code-block`, `md-list`, `md-list-item`, `md-emphasis`, `md-strong`, `md-strike`, `md-link`, `md-blockquote`, `md-table`, `md-rule`, and `md-break`. Code blocks also expose `data-language`.

## known limits

- TODO: add session eviction before using a client as a persistent multi-session shell.

## virtual

`@fulcrum/virtual` is a zero-dependency, framework-agnostic vertical windowing engine. `createVirtualizer` accepts generic `{ id, kind }` outlines, kind-based estimates, and an optional cache from `snapshotCache()`. Its small interface owns measured per-kind medians, capped overscan ranges, stable or end-relative anchor corrections, deferred momentum-scroll jumps, pinned-bottom decisions, and a bounded structured action log. Callers apply the returned rows, spacers, and scroll decisions in their own renderer; the package does not use React, the DOM, or browser APIs.
