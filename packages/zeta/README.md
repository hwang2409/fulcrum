# @fulcrum/zeta

`@fulcrum/zeta` adapts zeta serve events to the generic Fulcrum store. It includes wire types, a JSON-RPC client, websocket transport, authenticated `connectZeta`, host commands, and zeta tool views.

## connect

```ts
const client = await connectZeta({ url, token, role: "controller" });
```

Tokens use the `zeta.bearer.<token>` websocket subprotocol. A legacy `?token=` query value is removed before opening and is not sent. `ZetaError` codes include `connect_failed`, `busy`, `version_mismatch`, `role_mismatch`, `output_overflow`, and `closed`. Credentials are never included in errors.

## host commands

Pass `hostCommands(sessionId)` to `connectZeta()` to negotiate `session_host_commands`. It runs with a fresh value for every `new_session` and `resume`; `sessionId` is `null` for a new session. After `host_binding_required`, the client resumes with a fresh value and retries once with the same `delivery_id`. Values and failures are not logged.
