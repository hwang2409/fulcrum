import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createClient, fromZetaEvent, type Transport } from "../src/index.js";
import { eventTypes } from "../src/event-types.js";

const allEvents = readFileSync(new URL("./fixtures/all-events.jsonl", import.meta.url), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line).params as Record<string, unknown>);

const fields: Record<string, string[]> = {
  sub_agent_receipt: ["event", "data", "data.kind", "data.child_instance_id", "data.status", "data.notification_id", "data.summary", "data.question", "data.description", "data.text", "data.preview", "data.started_at", "data.updated_at", "data.completed_at", "data.sequence"],
  child_idle: ["event", "data", "data.child_instance_id", "data.notification_id", "data.summary", "data.question", "data.description", "data.text", "data.preview", "data.started_at", "data.updated_at", "data.completed_at", "data.sequence"],
  task_exit_notification: ["event", "data", "data.notification_id"],
  project_inbox_notification: ["event", "data", "data.notification_id"],
  child_question: ["event", "data", "data.child_instance_id", "data.notification_id", "data.summary", "data.question", "data.description", "data.text", "data.preview", "data.started_at", "data.updated_at", "data.completed_at", "data.sequence"],
  child_question_withdrawn: ["event", "data", "data.child_instance_id", "data.notification_id", "data.summary", "data.question", "data.description", "data.text", "data.preview", "data.started_at", "data.updated_at", "data.completed_at", "data.sequence"],
  memory_updated: ["event", "data"],
  turn_aborted: ["event", "data", "message"],
  usage: ["event", "data", "usage", "usage.input_tokens"],
  user_message: ["event", "data", "text", "mode", "attachments"],
  agent_start: ["event", "data"],
  turn_start: ["event", "data", "data.turn"],
  compaction_start: ["event", "data"],
  compaction_end: ["event", "data"],
  message_start: ["event", "data"],
  assistant_delta: ["event", "data", "data.message_id", "delta", "kind"],
  assistant_message: ["event", "data", "data.message_id", "message", "message.role", "message.content", "message.content.0", "message.content.0.type", "message.content.0.text", "message.content.1", "message.content.1.type", "message.content.1.text", "message.content.1.signature", "message.content.2", "message.content.2.type", "message.content.2.data", "message.content.2.mimeType", "message.content.3", "message.content.3.type", "message.content.3.data", "message.content.4", "message.content.4.type", "message.content.4.tool_call", "message.content.4.tool_call.id", "message.content.4.tool_call.name", "message.content.4.tool_call.arguments", "message.tool_result", "message.tool_result.tool_call_id", "message.tool_result.content", "message.tool_result.is_error", "message.tool_result.is_canceled", "message.metadata"],
  retry: ["event", "data"],
  assistant_reset: ["event", "data"],
  approval_request: ["event", "data", "request_id", "tool_call", "tool_call.id", "tool_call.name", "tool_call.arguments", "delegated", "agent_instance_id", "data.summary", "data.question", "data.text", "data.preview", "data.notification_id", "data.started_at", "data.updated_at", "data.completed_at", "data.sequence"],
  approval_end: ["event", "data", "request_id", "data.agent_instance_id", "data.status", "data.notification_id", "data.summary", "data.question", "data.description", "data.text", "data.preview", "data.started_at", "data.updated_at", "data.completed_at", "data.sequence"],
  tool_start: ["event", "data", "tool_call", "tool_call.id", "tool_call.name", "tool_call.arguments"],
  tool_output: ["event", "data", "tool_call", "tool_call.id", "tool_call.name", "tool_call.arguments", "output"],
  tool_end: ["event", "data", "tool_call", "tool_call.id", "tool_call.name", "tool_call.arguments", "tool_result", "tool_result.tool_call_id", "tool_result.content", "tool_result.is_error", "tool_result.is_canceled", "tool_result.structured_content", "tool_result.structured_content.exit_code", "tool_result.structured_content.stdout", "tool_result.structured_content.stderr"],
  notification_by_kind: ["event", "data", "data.kind", "data.child_instance_id", "data.status", "data.notification_id", "data.summary", "data.question", "data.description", "data.text", "data.preview", "data.started_at", "data.updated_at", "data.completed_at", "data.sequence"],
  child_message_delivered: ["event", "data", "data.agent_instance_id", "data.summary", "data.question", "data.description", "data.text", "data.preview", "data.notification_id", "data.started_at", "data.updated_at", "data.completed_at", "data.sequence"],
  account_limit: ["event", "data"],
  account_state_unknown: ["event", "data"],
  turn_end: ["event", "data", "data.turn"],
  agent_end: ["event", "data"],
  error: ["event", "data", "error", "error.code", "error.message", "data.agent_instance_id", "data.summary", "data.question", "data.description", "data.text", "data.preview", "data.notification_id", "data.started_at", "data.updated_at", "data.completed_at", "data.sequence"],
};

const setPath = (source: Record<string, unknown>, path: string, value: unknown, remove = false) => {
  const result = structuredClone(source);
  const parts = path.split(".");
  let target: any = result;
  for (const part of parts.slice(0, -1)) {
    if (target[part] === undefined) target[part] = {};
    target = target[part];
  }
  const key = parts.at(-1)!;
  if (remove) delete target[key];
  else Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
  return result;
};

const assertCoreShape = (events: ReturnType<typeof fromZetaEvent>) => {
  expect(events.length).toBeGreaterThan(0);
  if (events[0]?.type === "error" && events[0].error.code === "adapter_invalid_payload") return;
  for (const event of events) {
    if (event.type === "message_commit") {
      expect(typeof event.message.role).toBe("string");
      for (const block of event.message.content) expect(typeof block.type).toBe("string");
    }
    if (event.type === "tool_start" || event.type === "tool_output" || event.type === "tool_end" || event.type === "approval_request") {
      expect(typeof event.tool_call.id).toBe("string");
      expect(typeof event.tool_call.name).toBe("string");
      expect(event.tool_call.arguments).toBeObject();
    }
    if (event.type === "tool_end" && event.tool_result) {
      expect(typeof event.tool_result.tool_call_id).toBe("string");
      expect(typeof event.tool_result.content).toBe("string");
      expect(typeof event.tool_result.is_error).toBe("boolean");
    }
    if (event.type === "sub_agent") {
      expect(typeof event.childRunId).toBe("string");
      expect(["running", "waiting_approval", "waiting_input", "idle", "done", "error", "canceled"]).toContain(event.status);
    }
  }
};

test("every consumed field is decoded or becomes a typed adapter error", () => {
  const baseByName = Object.fromEntries(allEvents.map((event) => [event.event, event]));
  baseByName.assistant_message = {
    ...baseByName.assistant_message,
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "hello" },
        { type: "thinking", text: "think", signature: "signed" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "redacted_thinking", data: "redacted" },
        { type: "tool_use", tool_call: { id: "tool-2", name: "read", arguments: {} } },
      ],
      tool_result: { tool_call_id: "tool-1", content: "ok", is_error: false, is_canceled: false },
      metadata: {},
    },
    data: { message_id: "message" },
  };
  baseByName.tool_end = {
    ...baseByName.tool_end,
    tool_call: { id: "tool-1", name: "bash", arguments: { command: "ls" } },
    tool_result: { tool_call_id: "tool-1", content: "ok", is_error: false, is_canceled: false, structured_content: { exit_code: 0, stdout: "ok", stderr: "" } },
  };
  baseByName.approval_request = { ...baseByName.approval_request, agent_instance_id: "child" };
  baseByName.error = { ...baseByName.error, data: { agent_instance_id: "child" } };
  for (const [name, eventFields] of Object.entries(fields)) {
    const base = baseByName[name]!;
    for (const path of ["session_id", ...eventFields]) {
      for (const mutation of [
        setPath(base, path, 42),
        setPath(base, path, undefined, true),
        setPath(base, path, null),
        setPath(base, path, "x".repeat(1_000_001)),
        setPath(base, path, JSON.parse('{"__proto__":{"polluted":true}}')),
      ]) {
        expect(() => fromZetaEvent(mutation)).not.toThrow();
        assertCoreShape(fromZetaEvent(mutation));
      }
    }
  }
  expect(Object.keys(fields)).toEqual(Object.keys(eventTypes));
  expect((Object.prototype as any).polluted).toBeUndefined();
});

test("malformed named events become adapter errors", () => {
  expect(fromZetaEvent({ event: "assistant_delta", delta: 4 } as any)[0]).toMatchObject({ type: "error", error: { code: "adapter_invalid_payload" } });
});

test("client supports abort and timeout", async () => {
  let receive!: (text: string) => void;
  const transport: Transport = { send() {}, onMessage(cb) { receive = cb; }, onClose() {}, close() {} };
  const client = createClient(transport);
  const hello = client.hello();
  receive(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.0" } }));
  await hello;
  const controller = new AbortController();
  const aborted = client.request("slow", {}, { signal: controller.signal });
  controller.abort();
  await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
  await expect(client.request("slow", {}, { timeoutMs: 1 })).rejects.toThrow("timed out");
});

test("held sessions survive churn, then become evictable after release", () => {
  let receive!: (text: string) => void;
  const client = createClient({ send() {}, onMessage(callback) { receive = callback; }, onClose() {}, close() {} }, () => {}, undefined, { maxSessions: 2 });
  const held = client.forSession("viewed");
  const event = (session: string) => receive(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { event: "agent_start", session_id: session, data: {} } }));

  for (let index = 0; index < 10_000; index++) event(`churn-${index}`);
  event("viewed");
  expect(held.store.getState().agent).toBe("running");
  expect(client.stores.get("viewed")).toBe(held.store);
  expect(client.stores.size).toBe(3);

  held.release();
  event("new-1");
  event("new-2");
  expect(client.stores.has("viewed")).toBe(false);
  expect(client.stores.size).toBe(2);
  expect(client.evictionCount).toBe(10_001);
});

test("a stale lease cannot release a replacement store", () => {
  let receive!: (text: string) => void;
  const client = createClient({ send() {}, onMessage(callback) { receive = callback; }, onClose() {}, close() {} }, () => {}, undefined, { maxSessions: 1 });
  const stale = client.forSession("viewed");
  expect(client.evictSession("viewed")).toBe(true);
  const replacement = client.forSession("viewed");
  const second = client.forSession("viewed");
  stale.release();
  replacement.release();
  receive(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { event: "agent_start", session_id: "churn", data: {} } }));
  expect(client.stores.get("viewed")).toBe(second.store);
  second.release();
});

test("frame limit measures utf-8 bytes", () => {
  let receive!: (text: string) => void;
  const client = createClient({ send() {}, onMessage(callback) { receive = callback; }, onClose() {}, close() {} });
  const frame = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { event: "assistant_delta", delta: `${"€".repeat(400_000)}${"x".repeat(19)}` } });
  expect(new TextEncoder().encode(frame)).toHaveLength(1_200_101);
  receive(frame);
  expect(client.store.getItem("error:1")).toMatchObject({ event: { error: { code: "adapter_invalid_frame" } } });
});

test("nested message blocks and tool results are decoded", () => {
  expect(fromZetaEvent({ event: "assistant_message", message: { role: "assistant", content: [null] } })[0]).toMatchObject({ type: "error", error: { code: "adapter_invalid_payload" } });
  expect(fromZetaEvent({ event: "tool_end", tool_call: { id: "t", name: "bash", arguments: {} }, tool_result: { tool_call_id: 3, content: {}, is_error: "yes" } })[0]).toMatchObject({ type: "error", error: { code: "adapter_invalid_payload" } });
});

test("zeta child transitions clear urgency and preserve terminal state", () => {
  const client = createClient({ send() {}, onMessage() {}, onClose() {}, close() {} });
  const held = client.forSession("parent");
  const dispatch = (payload: Record<string, unknown>) => {
    for (const event of fromZetaEvent(payload)) held.store.dispatch(event);
    return held.store.getItem("sub-agent:child");
  };

  expect(dispatch({ event: "child_question", data: { child_instance_id: "child", question: "continue?" } })).toMatchObject({ status: "waiting_input", urgency: "input" });
  expect(dispatch({ event: "child_message_delivered", data: { agent_instance_id: "child", preview: "answered" } })).toMatchObject({ status: "running" });
  expect(dispatch({ event: "approval_request", request_id: "approval", delegated: true, agent_instance_id: "child", tool_call: { id: "tool", name: "bash", arguments: {} } })).toMatchObject({ status: "waiting_approval", urgency: "approval" });
  expect(dispatch({ event: "approval_end", request_id: "approval", data: { agent_instance_id: "child" } })).toMatchObject({ status: "running" });
  expect(dispatch({ event: "notification_by_kind", data: { child_instance_id: "child", kind: "agent_completion", status: "completed", summary: "finished" } })).toMatchObject({ status: "done" });
  expect(dispatch({ event: "child_idle", data: { child_instance_id: "child", description: "late idle" } })).toMatchObject({ status: "done" });
  expect(held.store.getItem("sub-agent:child")?.type === "sub_agent" ? held.store.getItem("sub-agent:child")?.urgency : undefined).toBeUndefined();
});

test("valid child delivery without an id remains a parent notification", () => {
  const [event] = fromZetaEvent({ event: "child_message_delivered", data: { child_label: "worker", preview: "check the retry" } });
  expect(event).toMatchObject({ type: "notification", data: { child_label: "worker", preview: "check the retry" } });
});
