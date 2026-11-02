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

  `item` is the normalized core tool item, including the agent-neutral `item.view` hint when the adapter set one. `output` is the streamed output plus a final result that adds to it. Approvals pass the requested call, with the `view` an adapter may put on `approval_request`, as an active tool item with no output and state `pending` or `submitting`. With a view, the header summary reads from it (`$ command` for shell, the path for read, edit, and write, the pattern for search, the url or query for fetch) and the part sets `data-tool-view="<kind>"`. With no view, it shows the first string argument. `summary` overrides either.

- playground: `bunx tsc -b`, then `bun run --cwd apps/playground dev`

- styles: copy `packages/react/styles.css` (layout, states, markdown and code) and `packages/react/themes.css` (color) into your app and edit them. themes.css has 12 real palettes: gruvbox-dark, gruvbox-light, dracula, nord, tokyo-night, catppuccin-mocha, catppuccin-latte, solarized-dark, solarized-light, github-dark, github-light, one-dark. Set `data-fulcrum-theme="<name>"` on `<html>` or any subtree; with no attribute it follows the OS with github-light or github-dark. Each theme also sets `--fulcrum-tok-*` colors for `<span class="tok-<type>">` syntax tokens. The type is "JetBrains Mono" with monospace fallbacks; load the font yourself.
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

Keep one adapter instance per AI SDK message stream. Feed it the JSON object from each SSE `data:` record and ignore the final `[DONE]` record. Malformed records become a generic `adapter_invalid_payload` error event; they do not throw from the callback. Source and file parts become harness-neutral message content blocks. Provider and tool protocol details stay in generic `meta` bags. Custom `data-*` parts are preserved in full as generic `unknown` events so a host can render them without changing the adapter.

## verify an adapter

`@fulcrum/adapter-test` is a test-only package, separate from `@fulcrum/core` so production consumers do not ship fixtures or assertions. Its framework-neutral runner owns the canonical behavior list and accepts adapter-owned wire fixtures:

```ts
import { runAdapterConformance } from "@fulcrum/adapter-test";

const failures = runAdapterConformance({
  name: "my-harness",
  fixtures, // records with scenario, sessionId, and harness wire data
  create: () => ({ decode: (record) => adapter.decode(record.wire) }),
  capabilities: {
    approval: false,
    reasoning: true,
    reset: false,
    usage: true,
  }, // the kit requires fixtures and assertions only for declared capabilities
});
if (failures.length) throw new Error(failures.join("\n"));
```

The canonical scenarios cover text stream and commit, tool argument streaming or complete arguments, tool output/end/error, abort, unknown and malformed input, session isolation, and stable ids after reconnect replay. Reasoning, approval, reset/retry, and usage are checked only when the adapter declares those capabilities. Both `@fulcrum/zeta` and `@fulcrum/ai-sdk` run this same kit. The AI SDK fixtures are generated by `ai@6.0.0` with its token-free `MockLanguageModelV3`; regenerate them with `bun run --cwd packages/ai-sdk fixtures`.
