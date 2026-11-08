# @fulcrum/ai-sdk

`@fulcrum/ai-sdk` translates the Vercel AI SDK `x-vercel-ai-ui-message-stream: v1` protocol from `ai@6.0.0` into generic `RunEvent` values. `ai` is not a runtime dependency.

```tsx
import { createRunStore } from "@fulcrum/core";
import { createAiSdkAdapter } from "@fulcrum/ai-sdk";

const store = createRunStore();
// one adapter per stream: a key for the request, and the messages it sent (the server's originalMessages)
const adapter = createAiSdkAdapter({ streamKey: "chat-request-123", originalMessages: messages });

for (const event of adapter.decode(part)) store.dispatch(event);
```

Use one adapter per stream. `streamKey` must be stable across replay and unique within the run. Feed each parsed SSE `data:` object and ignore `[DONE]`. Malformed records become `adapter_invalid_payload`; `decode()` does not throw for input data. Source and file parts become generic content blocks; provider details stay in `meta`; custom `data-*` parts become `unknown` events.

One UI message can become several fulcrum messages. Content after a new tool row, a new step, an `abort`, or an `error` starts the next one, so the timeline reads text, tool, text in order. A fulcrum message commits when a new tool row or step ends it, so it shows as finished while the tool runs and stays if the stream drops; the last one commits at `finish`, `abort`, or `error`. A text or reasoning part that never streams text opens no row.

### message ids

The nth fulcrum message of a UI message is `m:message:<UI message id>:<n>`, live and on reload. The split uses only what the UI message persists (its parts in order, with one `step-start` part per step), so a reloaded message gets the ids its live streams gave it. A store can hold reloaded messages and keep streaming into them, and decoding a persisted message again replaces its rows instead of doubling them. Each committed message also keeps the UI message id in `metadata.wireId`. Tools and approvals keep their wire ids.

- **Continuations:** after an approval or a client-side tool, the next request continues the same UI message, and the server sends its id again (`toUIMessageStream({ originalMessages })` takes it from the last assistant message). Give the continuation's adapter the messages that request sent as `originalMessages`. The adapter counts the fulcrum messages the last one already has, so the continuation's text becomes the next message below the tool instead of replacing the text from before it. With `useChat`, that is the `messages` your transport's `sendMessages` receives.
- **No message id:** a server that sets neither `originalMessages` nor `generateMessageId` sends `start` with no message id, and the client makes up an id the stream never carries. The adapter then names the stream's messages `s:message:<streamKey>:<n>`. They never collide with another stream, but a reload names the persisted message by its real id, so a re-sync from persisted messages into that store doubles those rows. Set `generateMessageId` on the server (the AI SDK's advice for persisted chats) to avoid it.
- **Not persisted:** an `error` chunk in the middle of a step splits the live rows, but the persisted message keeps no trace of it, so a reload shows that step's text as one message.

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

The AI SDK records a decision only for an approval still pending in the chat's last message, and resolves silently otherwise. So `respondToApproval` rejects before calling it when the approval is not pending there: a card left behind after the user sent a new prompt, a second answer, or an id the chat never asked about. The AI SDK records first: if `addToolApprovalResponse` throws or rejects, nothing is dispatched. Either way the promise rejects, so the card shows the error and offers its buttons again. The continuation (`sendAutomaticallyWhen`, or `chat.sendMessage()`) is a new stream: give it its own adapter, a new `streamKey`, and the messages it sent as `originalMessages`. Its tool output updates the same tool row, which keeps the name, arguments, and metadata from the request. Preliminary output from a generator `execute` replaces the row's output each time (`tool_output` with `replace`), and the final output replaces it once more.

## reload

`decodeAiSdkMessage(message)` turns one persisted assistant `UIMessage` (what `useChat` keeps in `messages` and a host stores) into the events its streams produced, so a reload needs no host step. Each part replays through the same decoder as a live stream. An approval's decision comes from the tool part's `approval` field, which the AI SDK keeps after the continuation: an approved, denied, or still-pending approval comes back as it was.

```ts
for (const message of messages.filter((message) => message.role === "assistant"))
  for (const event of decodeAiSdkMessage(message)) store.dispatch(event);
```

The rows get the live ids, so the chat can go on in the same store: answer a reloaded approval with `respondToApproval`, then decode the continuation with `originalMessages`, and it continues the reloaded message. A non-assistant or malformed message becomes `adapter_invalid_payload`; a malformed part, or a malformed `approval` decision, becomes one such error and the rest still decodes.
