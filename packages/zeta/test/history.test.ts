import { expect, test } from "bun:test";
import { createRunStore } from "@fulcrum/core";
import { fromZetaHistory } from "../src/index.js";

// Shapes from zeta's `session_history` (src/zeta/server/ergonomics.py): tool_use arguments are emptied and results are bounded.
const rows = [
  { id: "e1", role: "user", content: [{ type: "text", text: "list files" }, { type: "attachment", name: "shot.png", size: 12 }], tool_result: null },
  { id: "e2", role: "assistant", content: [{ type: "thinking", text: "" }, { type: "text", text: "running ls" }, { type: "tool_use", tool_call: { id: "t1", name: "bash", arguments: {} } }], tool_result: null },
  { id: "e3", role: "tool_result", content: [{ type: "text", text: "a\nb" }], tool_result: { tool_call_id: "t1", content: "a\nb", is_error: false, content_blocks: [], structured_content: null } },
  { id: "e4", role: "assistant", content: [{ type: "text", text: "done" }], tool_result: null, failed_turn: { code: "backend_error", message: "provider failed", provider_error: true } },
  { id: "e5", role: "system", content: [{ type: "text", text: "agent finished" }], tool_result: null, notification: { notification_id: "n1", kind: "agent_completion" } },
];

test("maps history rows into one ordered transcript", () => {
  const store = createRunStore((flush) => flush());
  for (const event of fromZetaHistory(rows)) store.dispatch(event);
  expect(store.getOutline().map((entry) => entry.kind)).toEqual(["user", "message", "tool", "message", "error", "notification"]);
  const tool = store.getItem(store.getOutline()[2]!.id);
  expect(tool).toMatchObject({ type: "tool", active: false, output: "", result: { content: "a\nb" }, tool_call: { name: "bash" } });
  const message = store.getItem(store.getOutline()[1]!.id);
  expect(message).toMatchObject({ type: "message", message: { content: [{ type: "text", text: "running ls" }] } });
});

test("a repeated page replaces messages by id instead of adding rows", () => {
  const store = createRunStore((flush) => flush());
  const assistant = fromZetaHistory([rows[3]]).filter((event) => event.type === "message_commit");
  for (const event of [...assistant, ...assistant]) store.dispatch(event);
  expect(store.getOutline()).toHaveLength(1);
});

test("one invalid row becomes an error and the rest still map", () => {
  const events = fromZetaHistory([{ id: "x", role: "assistant", content: "nope" }, rows[0]]);
  expect(events.map((event) => event.type)).toEqual(["error", "user_message"]);
});
