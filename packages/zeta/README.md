# @fulcrum/zeta

zeta serve types and helpers for connecting agent-run components to Zeta.

## command helpers

`MODEL_INPUT_IDS_FEATURE` is the feature name to request during the hello handshake. `parseSlashList` and `parseSlashRun` validate server results without throwing; malformed command rows are dropped and malformed result discriminators return `{ kind: "malformed" }`. `listSlashCommands`, `runSlashCommand`, and `sendModelInput` are thin typed wrappers over the JSON-RPC client.
