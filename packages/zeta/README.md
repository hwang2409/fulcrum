# @fulcrum/zeta

zeta serve types and helpers for connecting agent-run components to Zeta.

## command helpers

`MODEL_INPUT_IDS_FEATURE` is the feature name to request during the hello handshake. `parseSlashList` and `parseSlashRun` validate server results without throwing; malformed command rows are dropped and malformed result discriminators return `{ kind: "malformed" }`. `parseSlashRun` accepts the legacy `{ kind: "text" }` result from `/mcp status` and normalizes it to `{ kind: "output" }`; the protocol document omits this released-server shape. `listSlashCommands`, `runSlashCommand`, and `sendModelInput` are thin typed wrappers over the JSON-RPC client.
