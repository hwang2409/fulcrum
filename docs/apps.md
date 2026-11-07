# repository apps

## playground

`apps/playground` is private. It replays zeta fixtures, runs stress cases, provides the component gallery, and can connect to live zeta in a browser. `make dev` rebuilds every workspace package and the highlight bundle before Vite starts, so a fresh clone cannot use missing or stale `dist` output. Open `/gallery.html` for every part in every state without a server or session.

For live mode:

```sh
zeta serve --ws 8765 --ws-origin http://localhost:5173
make dev
```

The live panel reads the loopback websocket URL and token from `$ZETA_HOME/run/serve.ws.json`; the development helper fills them when available.

## zeta web client

`apps/web` is a zeta client built only from public `@fulcrum/*` exports. It has a session list, a drawer at phone widths, live runs, markdown, highlighting, tool cards, approvals, and 12 themes. The development server hands off discovery details, and the app reconnects automatically.

```sh
zeta serve --ws 8765 --ws-origin http://localhost:5180
make web
```

The app shows distinct states when zeta is absent, rejects the origin or token, is busy with another client, or disconnects. Without zeta, `bun run --cwd apps/web fake-zeta` starts a scripted server and prints the matching app command. `bun run --cwd apps/web gate` checks 1440 px and 390 px layouts, every theme, and every connection state. See [`apps/web/GAPS.md`](../apps/web/GAPS.md) for library gaps found by the app.

## checks

- `make test` builds packages and runs tests.
- `make clean` removes package and app builds and TypeScript build metadata.
- `bun run bench:check` runs performance benchmarks.
- `bun run size:check` checks package-size ceilings.
- `bun run stress` runs the production browser stress report.

The CI stress gate compares the base and candidate on one runner. It fails at a 1.20x median slowdown. It detects one large regression, not several smaller regressions that add up; see `apps/playground/scripts/stress-ab.ts`.

## known limit

Add session eviction before using a client as a persistent multi-session shell.
