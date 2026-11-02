import { expect, test } from "bun:test";
import {
  createRunStore,
  RECEIPT_LIMIT,
  type RunEvent,
  type RunItem,
} from "../src/index.js";
import { appendText } from "../src/stream.js";

const message = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const toolCall = { id: "tool-1", name: "read", arguments: { path: "README.md" } };

const replay = (events: RunEvent[]) => {
  const store = createRunStore(() => {});
  for (const event of events) {
    store.dispatch(event);
    store.getState();
  }
  return store;
};
const itemText = (item: RunItem | undefined) => {
  if (item?.type !== "message") return "";
  return (
    item.text ??
    item.message.content
      .filter((block) => block.type === "text")
      .map((block) => String(block.text))
      .join("")
  );
};

test("append branches from one entity independently", () => {
  const append = (prior: RunItem | undefined, delta: string) =>
    appendText<RunItem>(
      {
        id: "message:assistant",
        type: "message",
        message: { role: "assistant", content: [] },
        version: prior?.type === "message" ? prior.version + 1 : 1,
        active: true,
      },
      prior,
      "text",
      () => (prior?.type === "message" ? prior.text ?? "" : ""),
      delta,
    );
  const a = append(undefined, "a");
  const ab = append(a, "b");
  const ac = append(a, "c");

  expect(itemText(a)).toBe("a");
  expect(itemText(ab)).toBe("ab");
  expect(itemText(ac)).toBe("ac");
});

test("all event paths replay through the store", () => {
  const events: RunEvent[] = [
    { type: "run_start" },
    { type: "turn_start" },
    { type: "message_start" },
    { type: "message_delta", delta: "draft" },
    { type: "message_commit", message: message("done") },
    { type: "message_delta", delta: "discard" },
    { type: "message_reset" },
    { type: "retry" },
    { type: "tool_start", tool_call: toolCall },
    { type: "tool_output", tool_call: toolCall, output: "output" },
    {
      type: "tool_end",
      tool_call: toolCall,
      tool_result: { tool_call_id: toolCall.id, content: "output", is_error: false },
    },
    { type: "approval_request", request_id: "approval-1", tool_call: toolCall, delegated: false },
    { type: "approval_end", request_id: "approval-1" },
    { type: "usage", usage: { input_tokens: 1 } },
    { type: "user_message", text: "hello", mode: "normal" },
    { type: "notification", notification_id: "receipt-1" },
    { type: "unknown", name: "future", data: {} },
    { type: "error", error: { code: "failed", message: "failed" } },
    { type: "turn_end" },
    { type: "run_end" },
  ];
  const store = replay(events);
  expect(store.getOutline()).toHaveLength(7);
  expect(store.getState().agent).toBe("idle");
});

test("delta changes only the streaming message identity", () => {
  const store = replay([
    { type: "message_commit", message_id: "other", message: message("old") },
    { type: "tool_start", tool_call: toolCall },
    { type: "message_delta", message_id: "stream", delta: "a" },
  ]);
  const outline = store.getOutline();
  const other = store.getItem("message:other");
  const tool = store.getItem(`tool:${toolCall.id}`);
  const stream = store.getItem("message:stream");
  store.dispatch({ type: "message_delta", message_id: "stream", delta: "b" });

  expect(store.getItem("message:stream")).not.toBe(stream);
  expect(store.getItem("message:other")).toBe(other);
  expect(store.getItem(`tool:${toolCall.id}`)).toBe(tool);
  expect(store.getOutline()).toBe(outline);
});

test("tool output changes only the streamed tool identity", () => {
  const store = replay([
    { type: "message_commit", message_id: "other", message: message("old") },
    { type: "tool_start", tool_call: toolCall },
  ]);
  const outline = store.getOutline();
  const tool = store.getItem(`tool:${toolCall.id}`);
  const other = store.getItem("message:other");
  store.dispatch({ type: "tool_output", tool_call: toolCall, output: "chunk" });

  expect(store.getItem(`tool:${toolCall.id}`)).not.toBe(tool);
  expect(store.getItem("message:other")).toBe(other);
  expect(store.getOutline()).toBe(outline);
});

test("commit replaces streamed text with the final message", () => {
  const store = replay([
    { type: "message_delta", delta: "draft " },
    { type: "message_delta", delta: "text" },
    { type: "message_commit", message: message("final text") },
  ]);
  const item = store.getItem("message:assistant");
  expect(store.getOutline()).toEqual([{ id: "message:assistant", kind: "message" }]);
  expect(item?.type === "message" ? item.message.content : undefined).toEqual(message("final text").content);
  expect(item?.type === "message" ? item.text : undefined).toBeUndefined();
});

test("message_reset discards the in-progress stream", () => {
  const store = replay([
    { type: "message_delta", delta: "discard me" },
    { type: "message_reset" },
  ]);
  expect(store.getState().activeMessageId).toBeUndefined();
  expect(store.getItem("message:assistant")).toBeUndefined();
  expect(store.getOutline()).toEqual([]);
});

test("published snapshots and entities do not change after a delta", () => {
  const store = replay([{ type: "message_delta", delta: "before" }]);
  const snapshot = store.getState();
  const item = store.getItem("message:assistant");
  store.dispatch({ type: "message_delta", delta: " after" });

  expect(itemText(store.getItem("message:assistant"))).toBe("before after");
  expect(itemText(item)).toBe("before");
  expect(store.getState()).not.toBe(snapshot);
  expect(snapshot.outline).toEqual([{ id: "message:assistant", kind: "message" }]);
});

test("run_end clears active assistant and tool streams", () => {
  const store = replay([
    { type: "message_delta", delta: "old" },
    { type: "tool_start", tool_call: toolCall },
    { type: "tool_output", tool_call: toolCall, output: "old" },
    { type: "run_end" },
    { type: "message_delta", delta: "new" },
    { type: "tool_output", tool_call: toolCall, output: "new" },
  ]);
  const messageIds = store.getOutline().filter(({ kind }) => kind === "message").map(({ id }) => id);
  expect(messageIds).toHaveLength(2);
  expect(itemText(store.getItem("message:assistant"))).toBe("old");
  expect(itemText(store.getItem("message:assistant-2"))).toBe("new");
  const tool = store.getItem(`tool:${toolCall.id}`);
  expect(tool?.type === "tool" ? tool.output : undefined).toBe("new");
});

test("handles unknown events and receipt dedupe", () => {
  const store = replay([
    { type: "unknown", name: "future_event", data: { notification_id: "1", value: 1 } },
    { type: "unknown", name: "future_event", data: { notification_id: "1", value: 2 } },
  ]);
  expect(store.getOutline().filter(({ kind }) => kind === "unknown")).toHaveLength(1);
  expect(store.getState().receipts["1"]).toBe(true);
});

test("receipt dedupe is bounded and evicts the oldest receipt", () => {
  const store = createRunStore(() => {});
  for (let i = 0; i <= RECEIPT_LIMIT; i++)
    store.dispatch({ type: "notification", notification_id: String(i) });
  const state = store.getState();
  expect(Object.keys(state.receipts)).toHaveLength(RECEIPT_LIMIT);
  expect(state.receipts["0"]).toBeUndefined();
  expect(state.receipts[String(RECEIPT_LIMIT)]).toBe(true);
});
