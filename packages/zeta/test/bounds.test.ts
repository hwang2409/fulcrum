import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createClient, fromZetaEvent, type Transport } from "../src/index.js";
import { eventTypes } from "../src/event-types.js";

const allEvents = readFileSync(new URL("./fixtures/all-events.jsonl", import.meta.url), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line).params as Record<string, unknown>);

const fields: Record<string, string[]> = {
  sub_agent_receipt: ["event", "data", "data.kind", "data.child_instance_id", "data.status", "data.notification_id", "data.summary", "data.question", "data.description", "data.text", "data.preview", "data.started_at", "data.updated_at", "data.completed_at"],
  child_idle: ["event", "data", "data.child_instance_id", "data.notification_id", "data.summary", "data.question", "data.description", "data.text", "data.preview", "data.started_at", "data.updated_at", "data.completed_at"],
  task_exit_notification: ["event", "data", "data.notification_id"],
  project_inbox_notification: ["event", "data", "data.notification_id"],
  child_question: ["event", "data", "data.child_instance_id", "data.notification_id", "data.summary", "data.question", "data.description", "data.text", "data.preview", "data.started_at", "data.updated_at", "data.completed_at"],
  child_question_withdrawn: ["event", "data", "data.child_instance_id", "data.notification_id", "data.summary", "data.question", "data.description", "data.text", "data.preview", "data.started_at", "data.updated_at", "data.completed_at"],
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
  approval_request: ["event", "data", "request_id", "tool_call", "tool_call.id", "tool_call.name", "tool_call.arguments", "delegated", "agent_instance_id", "data.summary", "data.question", "data.text", "data.preview", "data.notification_id", "data.started_at", "data.updated_at", "data.completed_at"],
  approval_end: ["event", "data", "request_id"],
  tool_start: ["event", "data", "tool_call", "tool_call.id", "tool_call.name", "tool_call.arguments"],
  tool_output: ["event", "data", "tool_call", "tool_call.id", "tool_call.name", "tool_call.arguments", "output"],
  tool_end: ["event", "data", "tool_call", "tool_call.id", "tool_call.name", "tool_call.arguments", "tool_result", "tool_result.tool_call_id", "tool_result.content", "tool_result.is_error", "tool_result.is_canceled"],
  notification_by_kind: ["event", "data", "data.kind", "data.child_instance_id", "data.status", "data.notification_id", "data.summary", "data.question", "data.description", "data.text", "data.preview", "data.started_at", "data.updated_at", "data.completed_at"],
  child_message_delivered: ["event", "data", "data.agent_instance_id", "data.summary", "data.question", "data.description", "data.text", "data.preview", "data.notification_id", "data.started_at", "data.updated_at", "data.completed_at"],
  account_limit: ["event", "data"],
  account_state_unknown: ["event", "data"],
  turn_end: ["event", "data", "data.turn"],
  agent_end: ["event", "data"],
  error: ["event", "data", "error", "error.code", "error.message", "data.agent_instance_id", "data.summary", "data.question", "data.description", "data.text", "data.preview", "data.notification_id", "data.started_at", "data.updated_at", "data.completed_at"],
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
    tool_result: { tool_call_id: "tool-1", content: "ok", is_error: false, is_canceled: false },
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

test("automatic eviction deletes, disposes, and safely recreates a session", () => {
  let receive!: (text: string) => void;
  const client = createClient({ send() {}, onMessage(callback) { receive = callback; }, onClose() {}, close() {} }, () => {}, undefined, { maxSessions: 2 });
  const evicted = client.forSession("a");
  client.forSession("b");
  client.forSession("c");

  expect([...client.stores.keys()]).toEqual(["b", "c"]);
  expect(client.evictionCount).toBe(1);
  expect(() => evicted.dispatch({ type: "run_start" })).toThrow("store is disposed");
  expect(() => receive(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { event: "agent_start", session_id: "a", data: {} } }))).not.toThrow();
  expect([...client.stores.keys()]).toEqual(["c", "a"]);
  expect(client.forSession("a")).not.toBe(evicted);
  expect(client.evictSession("c")).toBe(true);
  expect(client.evictionCount).toBe(3);
  expect(client.stores.has("c")).toBe(false);
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

test("child transitions update one generic parent item keyed by child run", () => {
  const client = createClient({ send() {}, onMessage() {}, onClose() {}, close() {} });
  const store = client.forSession("parent");
  const expectTransition = (payload: Record<string, unknown>, status: string, urgency?: string) => {
    for (const event of fromZetaEvent(payload)) store.dispatch(event);
    const item = store.getItem("sub-agent:child");
    expect(item).toMatchObject({ type: "sub_agent", childRunId: "child", status, ...(urgency ? { urgency } : {}) });
    if (!urgency) expect(item?.type === "sub_agent" ? item.urgency : undefined).toBeUndefined();
  };
  expectTransition({ event: "sub_agent_receipt", data: { child_instance_id: "child", kind: "agent_completion", status: "completed", text: "done", summary: "done" } }, "done");
  expectTransition({ event: "child_idle", data: { child_instance_id: "child", kind: "child_idle", status: "child_idle", text: "idle", description: "worker" } }, "idle");
  expectTransition({ event: "child_question", data: { child_instance_id: "child", question_id: "q", kind: "child_question", status: "pending", question: "continue?", text: "question", description: "child question" } }, "waiting_input", "input");
  expectTransition({ event: "approval_request", request_id: "approval", delegated: true, agent_instance_id: "child", tool_call: { id: "tool", name: "bash", arguments: {} } }, "waiting_approval", "approval");
  expectTransition({ event: "notification_by_kind", data: { child_instance_id: "child", kind: "agent_completion", status: "completed", text: "done", summary: "finished" } }, "done");
  expectTransition({ event: "notification_by_kind", data: { child_instance_id: "child", kind: "agent_completion", status: "error", text: "failed", summary: "failed" } }, "error", "error");
  expect(store.getItem("sub-agent:q")).toBeUndefined();
});
