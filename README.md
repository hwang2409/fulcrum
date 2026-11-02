# fulcrum core

## packages

- `@fulcrum/core`: agent-agnostic run events, normalized state reducer, and burst-coalescing store.
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

## reducer and store

`reduce(state, event)` accepts generic `RunEvent` values and returns normalized run state. `items` orders the canonical entities in `itemsById`; active assistant and tool text is stored as a plain string on its entity. `createRunStore()` batches reduction and subscriber notification through its scheduler while `getState()` flushes pending events for synchronous reads. `fromZetaEvent` maps wire events to generic events, and `connect(transport)` adds JSON-RPC request matching.

build with `bun install`, `bun test`, and `bunx tsc -b`.

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

- hooks: `useRun(selector)` (return a primitive or a reference from state), `useTimeline()` (the `items` ids), `useItem(id)`. They use `useSyncExternalStore`, so a text delta re-renders only the item that changed.
- parts: `Timeline`, `Message`, `ToolCall`, `Approval`, and `Fallback` for other kinds. Parts have no styles. They take `className` and expose `data-part`, `data-kind`, `data-state` (`streaming`, `done`, `error`, `pending`), `data-role`, and `data-tool`. Text is plain text with `white-space: pre-wrap`.
- styles: copy `packages/react/styles.css` into your app and edit the `--fulcrum-*` variables. It supports light and dark mode and uses `content-visibility: auto` for long timelines.
- playground: `bunx tsc -b`, then `bun run --cwd apps/playground dev`.

## known limits

- TODO: add session eviction and bounded notification receipts before using a client as a persistent multi-session shell.
