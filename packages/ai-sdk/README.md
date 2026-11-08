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

## approvals

A tool with `needsApproval` asks in one stream and finishes in the next. The decision itself is a client step, `addToolApprovalResponse`, that no stream echoes back, so the host that makes it also ends the card. `respondToApproval` does both in one call: it records the decision with the AI SDK, then dispatches the `approval_end`. Pass it the approval's fulcrum id, the value an `Approval` card hands to `onApprove` and `onDeny`.

```tsx
import { useChat } from "@ai-sdk/react";
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { Approval } from "@fulcrum/react";
import { respondToApproval } from "@fulcrum/ai-sdk";

const chat = useChat({ sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses });
const target = { chat, dispatch: store.dispatch };

<Approval
  id={id}
  onApprove={(requestId) => respondToApproval(target, { requestId, approved: true })}
  onDeny={(requestId) => respondToApproval(target, { requestId, approved: false, reason: "not now" })}
/>
```

The AI SDK records first. If `addToolApprovalResponse` throws or rejects, nothing is dispatched and the promise rejects, so the card shows the error and offers its buttons again. The continuation (`sendAutomaticallyWhen`, or `chat.sendMessage()`) is a new stream: give it its own adapter and `streamKey`. Its tool output updates the same tool row, which keeps the name, arguments, and metadata from the request. Preliminary output from a generator `execute` replaces the row's output each time (`tool_output` with `replace`), and the final output replaces it once more.

## reload

`decodeAiSdkMessage(message, { streamKey })` turns one persisted assistant `UIMessage` (what `useChat` keeps in `messages` and a host stores) into the events its streams produced, so a reload needs no host step. Each part replays through the same decoder as a live stream. An approval's decision comes from the tool part's `approval` field, which the AI SDK keeps after the continuation: an approved, denied, or still-pending approval comes back as it was.

```ts
for (const message of messages.filter((message) => message.role === "assistant"))
  for (const event of decodeAiSdkMessage(message, { streamKey: message.id })) store.dispatch(event);
```

One persisted message spans the request and its continuations, so it uses one `streamKey`. Its fulcrum message ids differ from the live ones, which is fine for a store built from scratch. A non-assistant or malformed message becomes `adapter_invalid_payload`; a malformed part becomes one such error and the other parts still decode.
