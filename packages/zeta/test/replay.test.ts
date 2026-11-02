import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { initialState, reduce, type RunState } from "@fulcrum/core";
import {
  createClient,
  fromZetaEvent,
  type EventParams,
  type Transport,
} from "../src/index.js";

interface Frame {
  jsonrpc: "2.0";
  method: "event";
  params: EventParams;
}

const fixtureDir = new URL("./fixtures/", import.meta.url);
const fixtures = Object.fromEntries(
  readdirSync(fixtureDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => [
      name,
      readFileSync(new URL(name, fixtureDir), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Frame),
    ]),
);

const freshState = (): RunState => structuredClone(initialState);

function replay(name: string) {
  const sessions = new Map<string, RunState>();
  for (const frame of fixtures[name]) {
    const id = frame.params.session_id ?? "default";
    let state = sessions.get(id) ?? freshState();
    for (const event of fromZetaEvent(frame.params)) state = reduce(state, event);
    sessions.set(id, state);
  }
  return sessions;
}

const contentText = (state: RunState, id: string) =>
  state.messagesById[id].content
    .filter((block) => block.type === "text")
    .map((block) => String(block.text))
    .join("");

// Copied from /Users/henry/me/fun/zeta/src/zeta/server/event_contract.py.
const eventTypes: Record<string, string> = {
  sub_agent_receipt: "notification",
  child_idle: "notification",
  task_exit_notification: "notification",
  project_inbox_notification: "notification",
  child_question: "notification",
  child_question_withdrawn: "notification",
  memory_updated: "unknown",
  turn_aborted: "error",
  usage: "usage",
  user_message: "user_message",
  agent_start: "run_start",
  turn_start: "turn_start",
  compaction_start: "unknown",
  compaction_end: "unknown",
  message_start: "message_start",
  assistant_delta: "message_delta",
  assistant_message: "message_commit",
  retry: "retry",
  assistant_reset: "message_reset",
  approval_request: "approval_request",
  approval_end: "approval_end",
  tool_start: "tool_start",
  tool_output: "tool_output",
  tool_end: "tool_end",
  notification_by_kind: "notification",
  child_message_delivered: "notification",
  account_limit: "unknown",
  account_state_unknown: "unknown",
  turn_end: "turn_end",
  agent_end: "run_end",
  error: "error",
};
const deliberateUnknown = new Set([
  "memory_updated",
  "compaction_start",
  "compaction_end",
  "account_limit",
  "account_state_unknown",
]);

test("every event name in event_contract.py is mapped explicitly", () => {
  const frames = fixtures["all-events.jsonl"];
  expect(new Set(frames.map((frame) => frame.params.event))).toEqual(new Set(Object.keys(eventTypes)));

  for (const frame of frames) {
    const [event] = fromZetaEvent(frame.params);
    expect(event.type).toBe(eventTypes[frame.params.event]);
    if (event.type === "unknown") expect(deliberateUnknown.has(frame.params.event)).toBe(true);
  }

  expect(replay("all-events.jsonl").get("all")).toBeDefined();
});

test("simple streaming turn commits one assistant message", () => {
  const state = replay("simple.jsonl").get("simple")!;
  expect(state.items.filter((id) => state.itemsById[id]?.type === "message")).toHaveLength(1);
  expect(contentText(state, state.items[0])).toBe("hi there");
  expect(state.messagesById[state.items[0]].chunks).toBeUndefined();
});

test("two assistant turns keep two distinct messages in order", () => {
  const state = replay("two-turns.jsonl").get("turns")!;
  const messageIds = state.items.filter((id) => state.itemsById[id]?.type === "message");
  expect(messageIds).toHaveLength(2);
  expect(messageIds[0]).not.toBe(messageIds[1]);
  expect(messageIds.map((id) => contentText(state, id))).toEqual(["one", "two"]);
});

test("tool call start/output/end with error result", () => {
  const state = replay("tool.jsonl").get("tool")!;
  expect(state.items).toEqual(["tool-call-1"]);
  expect(state.toolCallsById["tool-call-1"].outputs).toEqual(["permission denied"]);
  expect(state.toolCallsById["tool-call-1"].is_error).toBe(true);
  expect(state.toolCallsById["tool-call-1"].result?.content).toBe("permission denied");
});

test("approval request then approval end", () => {
  const state = replay("approval.jsonl").get("approval")!;
  expect(state.items).toEqual(["tool-call-1"]);
  expect(state.approvalsById["tool-call-1"].delegated).toBe(false);
  expect(state.approvalsById["tool-call-1"].ended?.type).toBe("approval_end");
});

test("turn_aborted leaves turn and agent idle", () => {
  const state = replay("terminal.jsonl").get("aborted")!;
  expect(state.agent).toBe("idle");
  expect(state.turn).toBe("idle");
  expect(state.errors.at(-1)?.code).toBe("turn_aborted");
});

test("max_turns error then agent_end leaves run idle", () => {
  const state = replay("terminal.jsonl").get("max-turns")!;
  expect(state.agent).toBe("idle");
  expect(state.turn).toBe("idle");
  expect(state.errors.at(-1)).toEqual({ code: "max_turns", message: "maximum turns reached: 1" });
});

test("reconnect replay of the same notification_id is deduped", () => {
  const state = replay("notifications.jsonl").get("notify")!;
  const receipts = state.childNotifications.filter((event) => event.type === "notification");
  expect(receipts).toHaveLength(1);
  expect(state.receipts["same-id"]).toBe(true);
});

test("two interleaved sessions do not touch each other's state", async () => {
  let receive!: (text: string) => void;
  const transport: Transport = {
    send() {},
    onMessage(callback) { receive = callback; },
    onClose() {},
    close() {},
  };
  const client = createClient(transport);
  for (const frame of fixtures["sessions.jsonl"]) receive(JSON.stringify(frame));

  const alpha = client.stores.get("alpha")!.getState();
  const beta = client.stores.get("beta")!.getState();
  expect(alpha.items.map((id) => contentText(alpha, id))).toEqual(["alpha"]);
  expect(beta.items.map((id) => contentText(beta, id))).toEqual(["beta"]);
  expect(alpha).not.toBe(beta);
  expect(alpha.messagesById).not.toBe(beta.messagesById);
});

test("unknown future event keeps the full wire payload", () => {
  const state = replay("notifications.jsonl").get("notify")!;
  const event = state.childNotifications.find(
    (candidate) => candidate.type === "unknown" && candidate.name === "future_event",
  );
  expect(event?.type).toBe("unknown");
  if (event?.type === "unknown") {
    expect(event.data).toMatchObject({
      event: "future_event",
      session_id: "notify",
      message: "keep me",
      data: { nested: { value: 1 } },
    });
  }
});

test("memory_updated keeps its top-level message", () => {
  const state = replay("notifications.jsonl").get("notify")!;
  const event = state.childNotifications.find(
    (candidate) => candidate.type === "unknown" && candidate.name === "memory_updated",
  );
  expect(event?.type).toBe("unknown");
  if (event?.type === "unknown") expect(event.data.message).toBe("memory saved");
});
