import { describe, expect, test } from "bun:test";
import { initialState, reduce } from "../src/index.js";

test("replays streaming text and preserves unrelated identity", () => {
  let state = reduce(initialState, { type: "tool_start", tool_call: { id: "t", name: "x", arguments: {} }, data: {} });
  const tool = state.toolCallsById.t;
  state = reduce(state, { type: "message_delta", delta: "a" });
  expect(state.toolCallsById.t).toBe(tool);
  state = reduce(state, { type: "message_delta", delta: "b" });
  expect(state.messagesById.assistant?.chunks).toEqual(["a", "b"]);
});

test("handles unknown events and receipt dedupe", () => {
  let state = reduce(initialState, { type: "unknown", name: "future_event", data: { notification_id: "1", value: 1 } });
  state = reduce(state, { type: "unknown", name: "future_event", data: { notification_id: "1", value: 2 } });
  expect(state.childNotifications).toHaveLength(1);
  expect(state.receipts["1"]).toBe(true);
});
