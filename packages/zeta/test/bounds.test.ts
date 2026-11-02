import { expect, test } from "bun:test";
import { createClient, fromZetaEvent, type Transport } from "../src/index.js";
import { eventTypes } from "../src/event-types.js";

test("every named event survives random, truncated, and wrong-typed payloads", () => {
  let cases = 0;
  for (const event of Object.keys(eventTypes)) {
    for (const value of [null, [], { event }, { event, delta: 4 }, { event, data: "bad" }, { event, tool_call: "bad" }]) {
      expect(() => fromZetaEvent(value)).not.toThrow();
      cases++;
    }
  }
  expect(cases).toBe(Object.keys(eventTypes).length * 6);
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

test("child events produce a parent item and route child sessions", () => {
  const client = createClient({ send() {}, onMessage() {}, onClose() {}, close() {} });
  const [event] = fromZetaEvent({ event: "sub_agent_receipt", session_id: "parent", data: { agent_instance_id: "child", result: "done" } } as any);
  expect(event.type).toBe("notification");
  client.forSession("parent").dispatch(event);
  expect(client.forSession("parent").getItem("sub-agent:child")).toMatchObject({ type: "notification", event: { type: "sub_agent", child_id: "child" } });
});
