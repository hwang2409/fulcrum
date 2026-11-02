import { expect, test } from "bun:test";
import {
  createRunStore,
  initialState,
  RECEIPT_LIMIT,
  reduce,
  type RunState,
} from "../src/index.js";

const message = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

const toolCall = { id: "tool-1", name: "read", arguments: { path: "README.md" } };

const itemText = (state: RunState, id: string) => {
  const item = state.itemsById[id];
  if (item?.type !== "message") return "";
  return (
    item.text ??
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

  const other = state.itemsById["message:other"];
  const tool = state.itemsById[`tool:${toolCall.id}`];
  const streamItem = state.itemsById["message:stream"];
  const timeline = state.items;

  const next = reduce(state, { type: "message_delta", message_id: "stream", delta: "b" });
  expect(next.itemsById["message:stream"]).not.toBe(streamItem);
  expect(next.itemsById["message:other"]).toBe(other);
  expect(next.itemsById[`tool:${toolCall.id}`]).toBe(tool);
  expect(next.items).toBe(timeline);
});

test("tool output changes only the streamed tool identity", () => {
  let state = reduce(initialState, { type: "message_commit", message_id: "other", message: message("old") });
  state = reduce(state, { type: "tool_start", tool_call: toolCall });

  const toolItem = state.itemsById[`tool:${toolCall.id}`];
  const other = state.itemsById["message:other"];
  const otherItem = state.itemsById["message:other"];
  const timeline = state.items;

  const next = reduce(state, { type: "tool_output", tool_call: toolCall, output: "chunk" });
  expect(next.itemsById[`tool:${toolCall.id}`]).not.toBe(toolItem);
  expect(next.itemsById["message:other"]).toBe(other);
  expect(next.itemsById["message:other"]).toBe(otherItem);
  expect(next.items).toBe(timeline);
});

test("commit replaces streamed text with the final message", () => {
  let state = reduce(initialState, { type: "message_delta", delta: "draft " });
  state = reduce(state, { type: "message_delta", delta: "text" });
  state = reduce(state, { type: "message_commit", message: message("final text") });

  expect(state.items).toEqual(["message:assistant"]);
  const item = state.itemsById["message:assistant"];
  expect(item.type === "message" ? item.message.content : undefined).toEqual(message("final text").content);
  expect(item.type === "message" ? item.text : undefined).toBeUndefined();
});

test("message_reset discards the in-progress stream", () => {
  let state = reduce(initialState, { type: "message_delta", delta: "discard me" });
  state = reduce(state, { type: "message_reset" });

  expect(state.activeMessageId).toBeUndefined();
  expect(state.itemsById["message:assistant"]).toBeUndefined();
  expect(state.items).toEqual([]);
});

test("state snapshots taken before a delta do not change after it", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore(undefined, (job) => jobs.push(job));
  store.dispatch({ type: "message_delta", delta: "before" });
  const snapshot = store.getState();
  expect(store.getState()).toBe(snapshot);

  store.dispatch({ type: "message_delta", delta: " after" });
  const current = store.getState();

  expect(itemText(current, "message:assistant")).toBe("before after");
  expect(itemText(snapshot, "message:assistant")).toBe("before");
});

test("run_end clears active assistant and tool streams", () => {
  let state = reduce(initialState, { type: "message_delta", delta: "old" });
  state = reduce(state, { type: "tool_start", tool_call: toolCall });
  state = reduce(state, {
    type: "tool_output",
    tool_call: toolCall,
    output: "old",
  });
  state = reduce(state, { type: "run_end" });
  state = reduce(state, { type: "message_delta", delta: "new" });
  state = reduce(state, {
    type: "tool_output",
    tool_call: toolCall,
    output: "new",
  });

  expect(state.items.filter((id) => state.itemsById[id].type === "message")).toHaveLength(2);
  expect(itemText(state, "message:assistant")).toBe("old");
  expect(itemText(state, "message:assistant-2")).toBe("new");
  const tool = state.itemsById[`tool:${toolCall.id}`];
  expect(tool.type === "tool" ? tool.output : undefined).toBe("new");
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

test("receipt dedupe is bounded and evicts the oldest receipt", () => {
  let state = structuredClone(initialState);
  for (let i = 0; i <= RECEIPT_LIMIT; i++) {
    state = reduce(state, {
      type: "notification",
      notification_id: String(i),
    });
  }

  expect(Object.keys(state.receipts)).toHaveLength(RECEIPT_LIMIT);
  expect(state.receipts["0"]).toBeUndefined();
  expect(state.receipts[String(RECEIPT_LIMIT)]).toBe(true);
});

test("tool output branches are independent and old snapshots stay unchanged", () => {
  const started = reduce(initialState, { type: "tool_start", tool_call: toolCall });
  const a = reduce(started, { type: "tool_output", tool_call: toolCall, output: "a" });
  const ab = reduce(a, { type: "tool_output", tool_call: toolCall, output: "b" });
  const ac = reduce(a, { type: "tool_output", tool_call: toolCall, output: "c" });
  const output = (state: RunState) => {
    const item = state.itemsById[`tool:${toolCall.id}`];
    return item.type === "tool" ? item.output : undefined;
  };

  expect(output(a)).toBe("a");
  expect(output(ab)).toBe("ab");
  expect(output(ac)).toBe("ac");
});
