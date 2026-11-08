# @fulcrum/ai-sdk

`@fulcrum/ai-sdk` translates the Vercel AI SDK `x-vercel-ai-ui-message-stream: v1` protocol from `ai@6.0.0` into generic `RunEvent` values. `ai` is not a runtime dependency.

```tsx
import { createRunStore } from "@fulcrum/core";
import { createAiSdkAdapter } from "@fulcrum/ai-sdk";

const store = createRunStore();
const adapter = createAiSdkAdapter({ streamKey: "chat-request-123" });

for (const event of adapter.decode(part)) store.dispatch(event);
```

Use one adapter per stream. `streamKey` must be stable across replay and unique within the run. Feed each parsed SSE `data:` object and ignore `[DONE]`. Malformed records become `adapter_invalid_payload`; `decode()` does not throw for input data. Source and file parts become generic content blocks; provider details stay in `meta`; custom `data-*` parts become `unknown` events.

One UI message can become several fulcrum messages. Content after a new tool row, an `abort`, or an `error` starts the next one, so the timeline reads text, tool, text in order. A fulcrum message commits when a new tool row ends it, so it shows as finished while the tool runs and stays if the stream drops; the last one commits at `finish`, `abort`, or `error`. An approval continuation (`toUIMessageStream({ originalMessages })`) reuses the UI message id; give it its own adapter and `streamKey`, and its content becomes new rows below the approved tool instead of replacing the text from before the approval. Use a per-request id as `streamKey`, not the UI message id: a continuation reuses the message id, so its rows would replace the earlier ones. Message ids are therefore stream-keyed (`s:message:<streamKey>:<n>`), and each committed message keeps the UI message id in `metadata.wireId`. A text or reasoning part that never streams text opens no row.

Entity ids use disjoint `w:<kind>:<escaped-wire-id>` and `s:<kind>:<escaped-stream-key>:<counter>` namespaces. `%` and `:` are escaped, so arbitrary wire ids cannot collide with synthetic ids. Use `decodeAiSdkEntityId()` or original metadata ids when sending values back to the AI SDK.
