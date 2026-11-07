# @fulcrum/zeta

`@fulcrum/zeta` adapts zeta serve events to generic Fulcrum events and stores. It exports wire types, `fromZetaEvent`, `fromZetaHistory`, a JSON-RPC `connect(transport)` client, websocket transport, authenticated `connectZeta`, host commands, and `zetaTools`.

## command helpers

`MODEL_INPUT_IDS_FEATURE` is the feature name to request during the hello handshake. `parseSlashList` and `parseSlashRun` validate server results without throwing; malformed command rows are dropped and malformed result discriminators return `{ kind: "malformed" }`. `parseModelInput(value)` validates either the opaque-id or expanded-text `model_input` shape and returns `null` for malformed data; pass `{ requireInputId: true }` as its second argument to require the opaque-id shape used by prepared input. `parseSlashRun` accepts the legacy `{ kind: "text" }` result from `/mcp status` and normalizes it to `{ kind: "output" }`; the protocol document omits this released-server shape. `listSlashCommands`, `runSlashCommand`, and `sendModelInput` are thin typed wrappers over the JSON-RPC client.

## connect

Start zeta with the browser origin, then start the playground:

```sh
zeta serve --ws 8765 --ws-origin http://localhost:5173
make dev
```

Open the live zeta panel. Use the loopback websocket URL and token from `$ZETA_HOME/run/serve.ws.json`; the dev helper fills them when available. Tokens use the `zeta.bearer.<token>` websocket subprotocol. `connectZeta` removes a legacy `?token=` value before opening the socket and never sends query credentials.

```ts
import { connectZeta } from "@fulcrum/zeta";

const client = await connectZeta({ url, token, role: "controller" });
```

`connectZeta` rejects with `ZetaError`:

| code | meaning |
| --- | --- |
| `connect_failed` | the socket or hello request failed |
| `busy` | zeta already has a controller, or observer capacity is full |
| `version_mismatch` | the protocol version is unsupported |
| `role_mismatch` | the credential cannot use the requested role |
| `output_overflow` | zeta dropped queued output because this client fell behind |
| `closed` | the socket closed after hello |

Overflow errors preserve the controller- or observer-specific server message. Role mismatch uses `zeta credential and requested role do not match`. Credentials never appear in errors.

## host commands

Hosts can negotiate `session_host_commands` with a supplier:

```ts
import { connectZeta } from "@fulcrum/zeta";

const client = await connectZeta({
  url,
  token: controller_token,
  role: "controller",
  hostCommands: async (sessionId) => [{
    name: "render",
    executable: "/opt/my-host/bin/render",
    summary: "render a file in the host",
    environment: await environmentFor(sessionId),
  }],
});
```

`hostCommands(sessionId)` supplies a fresh binding for each `new_session` and `resume`; `sessionId` is `null` for a new session. If `send` or `send_images` returns `host_binding_required`, the client resumes that request's `session_id` with a fresh binding and retries once with the same `delivery_id`. Supplier values and failures are not logged or copied into errors. A server that does not negotiate the feature never calls the supplier.

`new_session` and `resume` retry zeta's transient `-32004` busy error three times after 250, 500, and 1000 ms. The delays follow the request signal and are canceled when the client closes. After the last retry, busy is surfaced to the caller.

## history and recovery

The client retries a desynced history load immediately, then after 0.5, 1, 2, 4, and 8 seconds: 15.5 seconds total. It records the final error in store diagnostics. `retrySession(id)` starts an app-owned retry. The web app passes it to `RunProvider.onRetry`; normal socket reconnect creates a fresh client and rebuilds the open session from history.

The client requests `served_turn_end`. Live `turn_start` then includes `data.turn_id`, and `client.servedTurn(sessionId)` returns the last id. `fromZetaHistory` skips durable `served_turn_end` rows. `servedTurnOutcome(rows, turnId)` maps the newest matching reason: `completed` stays `completed`, `user_stop` becomes `cancelled`, `error` becomes `failed`, and `disconnect` becomes `disconnected`.

The web app marks an outcome only when a session was running at an `output_overflow` close (`-32011`) and is idle after reconnect. It uses zeta's recorded outcome, or `unknown` when an older server or history has no matching end. An ordinary drop, a silent overflow close, another session, or a turn still running after reconnect stays unmarked. A socket that closes within 10 seconds continues reconnect backoff at 0.5, 1, 2, 4, 8, then every 10 seconds.
