# @fulcrum/zeta

`@fulcrum/zeta` adapts zeta serve events to generic Fulcrum events and stores. It exports wire types, `fromZetaEvent`, `fromZetaHistory`, a JSON-RPC `connect(transport)` client, websocket transport, authenticated `connectZeta`, host commands, and `zetaTools`.

## command helpers

`MODEL_INPUT_IDS_FEATURE` is the feature name to request during the hello handshake. `parseSlashList` and `parseSlashRun` validate server results without throwing; malformed command rows are dropped and malformed result discriminators return `{ kind: "malformed" }`. `parseModelInput(value)` validates either the opaque-id or expanded-text `model_input` shape and returns `null` for malformed data; pass `{ requireInputId: true }` as its second argument to require the opaque-id shape used by prepared input.

`CommandClient.features` is required. `runSlashCommand` fails closed when `model_input_ids` was not negotiated: it sends no `slash_run` request and returns `{ kind: "unavailable", feature: "model_input_ids" }`. This prevents an older server from returning the resolved hidden prompt as text. `listSlashCommands` remains available because `slash_list` returns catalog metadata, not model input. `sendModelInput` sends an opaque input ID returned by a negotiated server.

## session grants

`SESSION_GRANTS_FEATURE` is the feature name to request during the hello handshake. `parseSessionGrants`, `parseRevokeSessionGrants`, and `parseSessionGrantsChanged` validate session-grant snapshots and events without throwing; malformed string rows are dropped. `getSessionGrants(client)` reads the active connection's approval policy. `revokeSessionGrant(client, grant)` removes one exact grant, and `clearSessionGrants(client)` removes all session grants. `isSessionGrantError` recognizes the three session-grant error data codes from zeta.

The `session_grants_changed` event stays host-level. Register with `client.onSessionGrantsChanged(handler)` and use the returned function to unsubscribe. The event describes approval policy state, not a generic run event, so the zeta adapter does not map it into `@fulcrum/core`.

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

## approvals

Send a decision with `client.request("approve", { request_id })` or `client.request("deny", { request_id })`. For `Approval`'s `onApproveAlways`, send `approve` with `scope: "always_tool"`: zeta approves the call and lets the same tool run without asking for the rest of the session. Do not offer it for a `delegated` request; zeta rejects that scope there.

## history and recovery

The client retries a desynced history load immediately, then after 0.5, 1, 2, 4, and 8 seconds: 15.5 seconds total. It records the final error in store diagnostics. `retrySession(id)` starts an app-owned retry. The web app passes it to `RunProvider.onRetry`; normal socket reconnect creates a fresh client and rebuilds the open session from history.

The client requests `served_turn_end`. Live `turn_start` then includes `data.turn_id`, and `client.servedTurn(sessionId)` returns the last id. `fromZetaHistory` skips durable `served_turn_end` rows. `servedTurnOutcome(rows, turnId)` maps the newest matching reason: `completed` stays `completed`, `user_stop` becomes `cancelled`, `error` becomes `failed`, and `disconnect` becomes `disconnected`.

The web app marks an outcome only when a session was running at an `output_overflow` close (`-32011`) and is idle after reconnect. It uses zeta's recorded outcome, or `unknown` when an older server or history has no matching end. An ordinary drop, a silent overflow close, another session, or a turn still running after reconnect stays unmarked. A socket that closes within 10 seconds continues reconnect backoff at 0.5, 1, 2, 4, 8, then every 10 seconds.

## listener contract

The client calls host code at the places below. A throwing listener never reaches the socket loop, the recovery loop, or another listener: every other listener still runs, the frame's remaining events and the next frame are still handled, and pending requests still settle. Its error goes to the host's error sink exactly once: `reportError`, or `console.error` where it does not exist, the same sink as the core store. A sink that throws is dropped, since there is nowhere left to report it. Tests: `packages/zeta/test/host-calls.test.ts`.

In `client.ts`, host code runs only through `call()` (one host call) and `deliver()` (every listener of a set), plus the "outside" rows below, each marked `// host code: outside` with its row name. `packages/zeta/test/host-calls-guard.test.ts` parses `client.ts` and `packages/core/src/store.ts` and fails on any call whose callee is not a function declared in the file, a sibling module's function, or a short list of platform functions, unless it runs inside an owner or sits on a marked line. The failure names the owner to use. A function read from a Set, a Map, a parameter, or `options` counts as host code whatever its name, so the client's own resolvers held in a Map carry the marker too.

| callback | status |
| --- | --- |
| `onSessionGrantsChanged` listeners | covered by `deliver()` |
| `onClose` listeners | covered by `deliver()` |
| `closeError`, the third argument of `createClient` | covered by `call()`; on a throw the client still closes, with the default "transport closed" error |
| store listeners reached through the client's `dispatch` (live events, adapter errors, replayed history), `resync`, and `resyncFailed` | covered by `call()`: with a synchronous scheduler these store entries rethrow a listener's error (core rule 4). A resync that delivered still ends recovery, and a failed recovery still rejects `retrySession` with the load failure |
| client functions held as values: pending request resolvers and `settle` callbacks, host command close waiters, the recovery wake, the content reader, and the request that a busy retry repeats | outside: the client's own functions, which the guard sees only as values. A resolver cannot throw, and the caller's reactions run later, as microtasks; the reader and the repeated request reject to their caller |
| abort listeners on a retry delay and the close signal | not host code: the client's own handlers; they only settle the client's promises |
| request signal: a host `requestOptions.signal` | outside: the client reads its `.aborted` getter and calls its `addEventListener` and `removeEventListener`. A throw goes to the caller of `request()`: synchronously from the first `.aborted` check, and as a rejection from inside the request's promise. A throw from `removeEventListener` when a busy-retry delay ends is reported by the platform, and that retry stays waiting |
| `hostCommands(sessionId)` | outside: inside a `try` and `.catch`; a throw or rejection becomes `host_command_supplier_failed`, and its value is never logged |
| `load(signal)` of `replay` | outside: in `replay`, a throw rejects `replay`; in recovery, a throw is a load failure that backs off and retries. The client aborts its own `signal` on eviction and close; a host listener on that signal cannot make `abort()` throw, because the platform reports the listener's error itself |
| `scheduler` | outside: the client passes it to its core stores (core rule 9) |
| store dispose: `dispose()` of an evicted store | outside: core `dispose` calls no listener; it only sends an error it kept to the guarded sink (core rule 11) |
| transport: `send`, `close`, `onMessage`, `onClose`, `ready` | outside: calls into the host's transport, not deliveries; a `send` throw rejects that request, and the others throw or reject to the code that called them |
| `console.warn` when host commands are not offered | outside: runs once in `hello`; a throw rejects `hello` |
