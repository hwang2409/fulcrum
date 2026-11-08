# fulcrum

fulcrum is a fast react component library for agent runs. zeta is the first adapter, not the only target.

## packages

| package | purpose |
| --- | --- |
| `@fulcrum/core` | generic run events, reducer, store, and tool views |
| `@fulcrum/react` | react hooks and headless run and timeline parts |
| `@fulcrum/virtual` | framework-free virtual scrolling engine |
| `@fulcrum/zeta` | zeta wire adapter, client, transport, and tool map |
| `@fulcrum/highlight` | worker-first syntax highlighting |
| `@fulcrum/markdown` | streaming markdown document and react renderer |
| `@fulcrum/mermaid` | lazy mermaid diagrams for markdown |
| `@fulcrum/ai-sdk` | Vercel AI SDK UI stream adapter |
| `@fulcrum/adapter-test` | framework-free adapter conformance tests |

## quick start

`make dev` installs dependencies, rebuilds packages, and starts the playground. Open `/gallery.html` in the playground. `make test` builds and tests; `make clean` removes builds.

```sh
make dev
```

The smallest react view uses the public store and parts:

```tsx
import { createRunStore } from "@fulcrum/core";
import { RunProvider, Timeline } from "@fulcrum/react";
import "@fulcrum/react/styles.css";

const store = createRunStore();

export function AgentRun() {
  return (
    <RunProvider store={store}>
      <Timeline />
    </RunProvider>
  );
}
```

Dispatch `RunEvent` values to `store`. Add renderers for custom item kinds. See the [react guide](packages/react/README.md).

## zeta web client

`apps/web` is a complete zeta client. It includes sessions, live runs, markdown, tools, approvals, highlighting, and themes.

```sh
zeta serve --ws 8765 --ws-origin http://localhost:5180
make web
```

Open <http://localhost:5180>. For another harness, map its events to `@fulcrum/core` events and its tools with `defineToolMap`. See [using another harness](docs/other-harnesses.md).

## docs

- [core store](packages/core/README.md)
- [react parts and data attributes](packages/react/README.md)
- [virtual scrolling](packages/virtual/README.md)
- [zeta adapter and connection](packages/zeta/README.md)
- [syntax highlighting](packages/highlight/README.md)
- [streaming markdown](packages/markdown/README.md)
- [mermaid diagrams](packages/mermaid/README.md)
- [AI SDK streams](packages/ai-sdk/README.md)
- [adapter verification](packages/adapter-test/README.md)
- [repository apps and checks](docs/apps.md)
- [other harnesses](docs/other-harnesses.md)

## development

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
```

`bun run typecheck` is the same command CI runs.

contributors need Bun 1.4.4 or newer.
