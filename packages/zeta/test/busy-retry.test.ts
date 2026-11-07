import { expect, jest, test } from "bun:test";
import { createClient, type Transport } from "../src/index.js";

function fakeTransport() {
  let onMessage!: (text: string) => void;
  const sent: Array<Record<string, unknown>> = [];
  const transport: Transport = { send(text) { sent.push(JSON.parse(text)); }, onMessage(callback) { onMessage = callback; }, close() {} };
  return { transport, sent, receive: (message: unknown) => onMessage(JSON.stringify(message)) };
}
async function hello(fake: ReturnType<typeof fakeTransport>, client: ReturnType<typeof createClient>) {
  const ready = client.hello();
  fake.receive({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.2" } });
  await ready;
}

test.serial("resume retries busy once and then succeeds", async () => {
  const fake = fakeTransport();
  const client = createClient(fake.transport);
  await hello(fake, client);
  const opening = client.request("resume", { session_id: "s1" });
  await Promise.resolve();
  fake.receive({ jsonrpc: "2.0", id: 2, error: { code: -32004, message: "busy" } });
  await Bun.sleep(260);
  expect(fake.sent.at(-1)?.id).toBe(3);
  fake.receive({ jsonrpc: "2.0", id: 3, result: { session: { session_id: "s1" } } });
  await expect(opening).resolves.toEqual({ session: { session_id: "s1" } });
});

test.serial("resume gives up after three busy retries", async () => {
  const fake = fakeTransport();
  const client = createClient(fake.transport);
  await hello(fake, client);
  const opening = client.request("resume", { session_id: "s1" });
  for (const [index, delay] of [0, 260, 510, 1_010].entries()) {
    if (delay) await Bun.sleep(delay);
    const id = index + 2;
    fake.receive({ jsonrpc: "2.0", id, error: { code: -32004, message: "busy" } });
  }
  await expect(opening).rejects.toMatchObject({ code: -32004 });
  expect(fake.sent.filter((message) => message.method === "resume")).toHaveLength(4);
});

test.serial("close cancels busy backoff without leaving a timer", async () => {
  jest.useFakeTimers();
  try {
    const fake = fakeTransport();
    const client = createClient(fake.transport);
    await hello(fake, client);
    const opening = client.request("resume", { session_id: "s1" });
    await Promise.resolve();
    fake.receive({ jsonrpc: "2.0", id: 2, error: { code: -32004, message: "busy" } });
    await Promise.resolve();
    expect(jest.getTimerCount()).toBe(1);
    client.close();
    await expect(opening).rejects.toBeDefined();
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

test.serial("attach does not retry other errors or after abort", async () => {
  const other = fakeTransport();
  const otherClient = createClient(other.transport);
  await hello(other, otherClient);
  const failed = otherClient.request("resume", { session_id: "s1" });
  await Promise.resolve();
  other.receive({ jsonrpc: "2.0", id: 2, error: { code: -32602, message: "bad" } });
  await expect(failed).rejects.toMatchObject({ code: -32602 });
  expect(other.sent.filter((message) => message.method === "resume")).toHaveLength(1);

  const aborted = fakeTransport();
  const abortedClient = createClient(aborted.transport);
  await hello(aborted, abortedClient);
  const controller = new AbortController();
  const opening = abortedClient.request("resume", { session_id: "s1" }, { signal: controller.signal });
  await Promise.resolve();
  aborted.receive({ jsonrpc: "2.0", id: 2, error: { code: -32004, message: "busy" } });
  controller.abort();
  await expect(opening).rejects.toMatchObject({ name: "AbortError" });
  await Bun.sleep(260);
  expect(aborted.sent.filter((message) => message.method === "resume")).toHaveLength(1);
});

