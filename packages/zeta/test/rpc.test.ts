import { expect, test } from "bun:test";
import { connect, createClient, type Transport } from "../src/index.js";

function fakeTransport() {
  let onMessage!: (text: string) => void;
  const sent: Array<Record<string, unknown>> = [];
  const transport: Transport = {
    send(text) { sent.push(JSON.parse(text)); },
    onMessage(callback) { onMessage = callback; },
    onClose() {},
    close() {},
  };
  return { transport, sent, receive: (message: unknown) => onMessage(JSON.stringify(message)) };
}

test("requests before hello are rejected", async () => {
  const fake = fakeTransport();
  const client = connect(fake.transport);

  const request = client.request("status");
  await Promise.resolve();
  client.close();
  await expect(request).rejects.toThrow("hello required");
  expect(fake.sent).toEqual([]);
});

test("features are used only when echoed by the server", async () => {
  const fake = fakeTransport();
  const client = connect(fake.transport);
  const hello = client.hello(["projects", "list_sessions_paging"]);
  fake.receive({
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocol_version: "1.2",
      capabilities: { features: ["projects"] },
    },
  });

  await hello;
  expect(client.features).toEqual(["projects"]);
  expect(client.features).not.toContain("list_sessions_paging");
});

test("hello, responses, errors, and events", async () => {
  const fake = fakeTransport();
  const client = connect(fake.transport);
  const hello = client.hello();
  fake.receive({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.0" } });
  expect(await hello).toEqual({ protocol_version: "1.0" });
  expect((fake.sent[0].params as Record<string, unknown>).protocol_version).toBe("1.0");

  const bad = client.request("status");
  fake.receive({ jsonrpc: "2.0", id: 2, error: { code: -32602, message: "bad" } });
  await expect(bad).rejects.toThrow("bad");

  fake.receive({
    jsonrpc: "2.0",
    method: "event",
    params: { event: "usage", usage: { input_tokens: 2 } },
  });
  expect(client.store.getState().usage.input_tokens).toBe(2);
});

test("onClose reports a dropped transport once, with the close error, and can unsubscribe", async () => {
  let closeTransport!: (code?: number) => void;
  const transport: Transport = { send() {}, onMessage() {}, onClose(callback) { closeTransport = callback; }, close() {} };
  const client = createClient(transport, undefined, (_handshaken, code) => new Error(`closed ${code}`));
  const seen: unknown[] = [];
  const kept = client.onClose((error) => seen.push(error));
  const dropped = client.onClose(() => seen.push("unsubscribed listener ran"));
  dropped();
  closeTransport(1006);
  closeTransport(1006);
  expect(seen.map(String)).toEqual(["Error: closed 1006"]);
  kept();
});
