# fulcrum core

## packages

- `@fulcrum/core`: agent-agnostic run events, normalized state reducer, and burst-coalescing store.
- `@fulcrum/zeta`: zeta serve wire types, adapter, JSON-RPC client, and websocket transport.

## reducer and store

`reduce(state, event)` accepts generic `RunEvent` values and returns normalized run state. streamed text is kept in `messagesById[id].chunks`; the final commit replaces it. `createRunStore()` exposes `getState`, `subscribe`, and `dispatch`; pass a scheduler in tests to control notification timing. `fromZetaEvent` maps wire events to generic events, and `connect(transport)` adds JSON-RPC request matching.

build with `bun install`, `bun test`, and `bunx tsc -b`.

## known limits

- TODO: add session eviction and bounded notification receipts before using a client as a persistent multi-session shell.
