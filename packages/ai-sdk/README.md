# @fulcrum/ai-sdk

`@fulcrum/ai-sdk` translates the Vercel AI SDK UI message stream (`ai@6.0.0`) into generic `RunEvent` values. `ai` is not a runtime dependency.

```tsx
import { createRunStore } from "@fulcrum/core";
import { createAiSdkAdapter } from "@fulcrum/ai-sdk";

const store = createRunStore();
const adapter = createAiSdkAdapter({ streamKey: "chat-request-123" });

for (const event of adapter.decode(part)) store.dispatch(event);
```

Use one adapter per stream. `streamKey` must be stable across replay and unique within the run. Feed each parsed SSE `data:` object and ignore `[DONE]`. Malformed records become `adapter_invalid_payload`. Source and file parts become generic content blocks; provider details stay in `meta`; custom `data-*` parts become `unknown` events.

Entity ids use disjoint wire and synthetic namespaces. Use `decodeAiSdkEntityId()` or original metadata ids when sending values back to the AI SDK.
