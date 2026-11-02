import { expect, test } from "bun:test";
import { createRunStore, initialState, reduce } from "../src/index.js";

const message = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

const toolCall = { id: "tool-1", name: "read", arguments: { path: "README.md" } };

const itemText = (state: typeof initialState, id: string) => {
  const item = state.itemsById[id];
  if (item?.type !== "message") return "";
  return (
    item.chunks?.join("") ??
    item.message.content
      .filter((block) => block.type === "text")
      .map((block) => String(block.text))
      .join("")
  );
};

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

test("reduce is pure: branching one state gives independent results", () => {
  const a = reduce(initialState, { type: "message_delta", delta: "a" });
  const ab = reduce(a, { type: "message_delta", delta: "b" });
  const ac = reduce(a, { type: "message_delta", delta: "c" });

  expect(itemText(a, "message:assistant")).toBe("a");
  expect(itemText(ab, "message:assistant")).toBe("ab");
  expect(itemText(ac, "message:assistant")).toBe("ac");
});

test("reduce never mutates its input", () => {
  const events = [
    { type: "run_start" as const },
    { type: "turn_start" as const },
    { type: "message_start" as const },
    { type: "message_delta" as const, delta: "draft" },
    { type: "message_commit" as const, message: message("done") },
    { type: "message_delta" as const, delta: "discard" },
    { type: "message_reset" as const },
    { type: "retry" as const },
    { type: "tool_start" as const, tool_call: toolCall },
    { type: "tool_output" as const, tool_call: toolCall, output: "output" },
    {
      type: "tool_end" as const,
      tool_call: toolCall,
      tool_result: { tool_call_id: toolCall.id, content: "output", is_error: false },
    },
    { type: "approval_request" as const, request_id: "approval-1", tool_call: toolCall, delegated: false },
    { type: "approval_end" as const, request_id: "approval-1" },
    { type: "usage" as const, usage: { input_tokens: 1 } },
    { type: "user_message" as const, text: "hello", mode: "normal" },
    { type: "notification" as const, notification_id: "receipt-1" },
    { type: "unknown" as const, name: "future", data: {} },
    { type: "error" as const, error: { code: "failed", message: "failed" } },
    { type: "turn_end" as const },
    { type: "run_end" as const },
  ];
  let state = structuredClone(initialState);

  for (const event of events) state = reduce(deepFreeze(state), event);
});

test("delta changes only the streaming message identity", () => {
  let state = reduce(initialState, { type: "message_commit", message_id: "other", message: message("old") });
  state = reduce(state, { type: "tool_start", tool_call: toolCall });
  state = reduce(state, { type: "message_delta", message_id: "stream", delta: "a" });

  const stream = state.messagesById.stream;
  const other = state.messagesById.other;
  const tool = state.toolCallsById[toolCall.id];
  const streamItem = state.itemsById["message:stream"];
  const timeline = state.items;

  const next = reduce(state, { type: "message_delta", message_id: "stream", delta: "b" });
  expect(next.messagesById.stream).not.toBe(stream);
  expect(next.itemsById["message:stream"]).not.toBe(streamItem);
  expect(next.messagesById.other).toBe(other);
  expect(next.toolCallsById[toolCall.id]).toBe(tool);
  expect(next.items).toBe(timeline);
});

test("tool output changes only the streamed tool identity", () => {
  let state = reduce(initialState, { type: "message_commit", message_id: "other", message: message("old") });
  state = reduce(state, { type: "tool_start", tool_call: toolCall });

  const tool = state.toolCallsById[toolCall.id];
  const toolItem = state.itemsById[`tool:${toolCall.id}`];
  const other = state.messagesById.other;
  const otherItem = state.itemsById["message:other"];
  const timeline = state.items;

  const next = reduce(state, { type: "tool_output", tool_call: toolCall, output: "chunk" });
  expect(next.toolCallsById[toolCall.id]).not.toBe(tool);
  expect(next.itemsById[`tool:${toolCall.id}`]).not.toBe(toolItem);
  expect(next.messagesById.other).toBe(other);
  expect(next.itemsById["message:other"]).toBe(otherItem);
  expect(next.items).toBe(timeline);
});

test("commit replaces streamed chunks with the final message", () => {
  let state = reduce(initialState, { type: "message_delta", delta: "draft " });
  state = reduce(state, { type: "message_delta", delta: "text" });
  state = reduce(state, { type: "message_commit", message: message("final text") });

  expect(state.items).toEqual(["message:assistant"]);
  expect(state.messagesById.assistant.content).toEqual(message("final text").content);
  expect(state.messagesById.assistant.chunks).toBeUndefined();
});

test("message_reset discards the in-progress stream", () => {
  let state = reduce(initialState, { type: "message_delta", delta: "discard me" });
  state = reduce(state, { type: "message_reset" });

  expect(state.activeMessageId).toBeUndefined();
  expect(state.messagesById.assistant).toBeUndefined();
  expect(state.items).toEqual([]);
});

test("state snapshots taken before a delta do not change after it", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore(undefined, (job) => jobs.push(job));
  store.dispatch({ type: "message_delta", delta: "before" });
  const snapshot = store.getState();
  expect(store.getState()).toBe(snapshot);

  store.dispatch({ type: "message_delta", delta: " after" });

  expect(snapshot.messagesById.assistant.chunks?.join("")).toBe("before");
});

test("handles unknown events and receipt dedupe", () => {
  let state = reduce(initialState, {
    type: "unknown",
    name: "future_event",
    data: { notification_id: "1", value: 1 },
  });
  state = reduce(state, {
    type: "unknown",
    name: "future_event",
    data: { notification_id: "1", value: 2 },
  });
  expect(state.items.filter((id) => state.itemsById[id].type === "unknown")).toHaveLength(1);
  expect(state.receipts["1"]).toBe(true);
});
