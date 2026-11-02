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

- playground: `bunx tsc -b`, then `bun run --cwd apps/playground dev`

- styles: copy `packages/react/styles.css` into your app and edit the `--fulcrum-*` variables. It follows the OS light or dark mode (set `data-fulcrum-theme="light"` or `"dark"` on `<html>` to force one) and uses `content-visibility: auto` for long timelines.
- playground: `bunx tsc -b`, then `bun run --cwd apps/playground dev`.
- gallery: every part in every state, no server or session. Run `bun run dev` in `apps/playground`, then open `/gallery.html`.
- performance checks: `bun run bench:check` and `bun run size:check`; run the production browser stress report with `bun run stress`.


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
const adapter = createAiSdkAdapter();

// Call this for each parsed `data: {...}` UI message stream part.
export function onAiSdkPart(part: unknown) {
  for (const event of adapter.decode(part)) store.dispatch(event);
}

export function AgentRun() {
  return <RunProvider store={store}><Timeline /></RunProvider>;
}
```

Keep one adapter instance per AI SDK message stream. Feed it the JSON object from each SSE `data:` record and ignore the final `[DONE]` record. Malformed records become a generic `adapter_invalid_payload` error event; they do not throw from the callback. Custom `data-*` parts are preserved as generic `unknown` events so a host can render them without changing the adapter.

## verify an adapter

`@fulcrum/adapter-test` is a test-only package, separate from `@fulcrum/core` so production consumers do not ship fixtures or assertions. Its framework-neutral runner owns the canonical behavior list and accepts adapter-owned wire fixtures:

```ts
import { runAdapterConformance } from "@fulcrum/adapter-test";

const failures = runAdapterConformance({
  name: "my-harness",
  fixtures, // records with scenario, sessionId, and harness wire data
  create: () => ({ decode: (record) => adapter.decode(record.wire) }),
  capabilities: { approval: false }, // omit only when the wire cannot express approval
});
if (failures.length) throw new Error(failures.join("\n"));
```

The canonical scenarios cover text stream and commit, reasoning, tool argument streaming or complete arguments, tool output/end/error, optional approval, reset/retry/abort, usage, unknown and malformed input, session isolation, and stable ids after reconnect replay. Both `@fulcrum/zeta` and `@fulcrum/ai-sdk` run this same kit.
