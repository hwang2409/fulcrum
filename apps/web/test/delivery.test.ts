import { expect, test } from "bun:test";
import { createClient, type Transport } from "@fulcrum/zeta";
import { createDelivery, stopTurn } from "../src/delivery";

type Reply = { result?: unknown; error?: { code: number; message: string; data?: unknown } };

/** A real zeta client over an in-memory transport; `answer` replies to each request by method. */
async function server(answer: (method: string, params: Record<string, unknown>) => Reply, features = ["delivery_id"]) {
  let deliver!: (text: string) => void;
  const calls: Array<[string, Record<string, unknown>]> = [];
  const transport: Transport = {
    onMessage(callback) { deliver = callback; },
    onClose() {},
    close() {},
    send(text) {
      const { id, method, params } = JSON.parse(text);
      if (method !== "hello") calls.push([method, params]);
      queueMicrotask(() => deliver(JSON.stringify({ jsonrpc: "2.0", id, ...(method === "hello" ? { result: { protocol_version: "1.2", capabilities: { features } } } : answer(method, params)) })));
    },
  };
  const client = createClient(transport, (flush) => flush());
  await client.hello(features);
  return { client, calls };
}
const ids = () => { let n = 0; return () => `id-${++n}`; };
const ok = { result: { accepted: true } };

test("send and steer go to their methods with a delivery id when the feature is negotiated", async () => {
  const { client, calls } = await server(() => ok);
  const delivery = createDelivery(ids());
  await delivery.submit(client, "hello", false);
  await delivery.submit(client, "also this", true);
  expect(calls).toEqual([["send", { text: "hello", delivery_id: "id-1" }], ["steer", { text: "also this", delivery_id: "id-2" }]]);
});

test("without the feature no delivery id is sent", async () => {
  const { client, calls } = await server(() => ok, []);
  await createDelivery(ids()).submit(client, "hello", false);
  expect(calls).toEqual([["send", { text: "hello" }]]);
});

test("a retry of the same text after a failure reuses its id; the next message after success gets a new one", async () => {
  let fail = true;
  const { client, calls } = await server(() => (fail ? { error: { code: -32000, message: "unexpected server failure" } } : ok));
  const delivery = createDelivery(ids());
  await expect(delivery.submit(client, "hello", false)).rejects.toThrow("unexpected server failure");
  fail = false;
  await delivery.submit(client, "hello", false);
  await delivery.submit(client, "hello", false);
  expect(calls.map(([, params]) => params.delivery_id)).toEqual(["id-1", "id-1", "id-2"]);
});

test("a turn that ends before a steer lands sends it instead, and one that starts before a send steers, with the same id", async () => {
  const { client, calls } = await server((method) => (method === "steer" ? { error: { code: -32005, message: "no turn is running" } } : ok));
  await createDelivery(ids()).submit(client, "late steer", true);
  const busy = await server((method) => (method === "send" ? { error: { code: -32004, message: "a turn is already running" } } : ok));
  await createDelivery(ids()).submit(busy.client, "early send", false);
  expect(calls).toEqual([["steer", { text: "late steer", delivery_id: "id-1" }], ["send", { text: "late steer", delivery_id: "id-1" }]]);
  expect(busy.calls).toEqual([["send", { text: "early send", delivery_id: "id-1" }], ["steer", { text: "early send", delivery_id: "id-1" }]]);
});

test("a dropped steer is an error and the retry gets a fresh id; an evicted id reports its outcome", async () => {
  let reply: Reply = { result: { accepted: false, duplicate: true, status: "dropped" } };
  const { client, calls } = await server(() => reply);
  const delivery = createDelivery(ids());
  await expect(delivery.submit(client, "steer me", true)).rejects.toThrow("dropped");
  reply = { error: { code: -32010, message: "evicted", data: { outcome: "delivered" } } };
  await delivery.submit(client, "steer me", true);
  reply = { error: { code: -32010, message: "evicted", data: { outcome: "dropped" } } };
  await expect(delivery.submit(client, "again", true)).rejects.toThrow("dropped");
  expect(calls.map(([, params]) => params.delivery_id)).toEqual(["id-1", "id-2", "id-3"]);
});

test("a steer the turn dropped at its end is resent as a new message, in order; delivered ones are not", async () => {
  const status: Record<string, string> = { "id-1": "delivered", "id-2": "dropped", "id-3": "dropped" };
  const { client, calls } = await server((method, params) => (method === "delivery_status" ? { result: { delivery_id: params.delivery_id, status: status[params.delivery_id as string] } } : ok));
  const delivery = createDelivery(ids());
  await delivery.submit(client, "read first", true);
  await delivery.submit(client, "then this", true);
  await delivery.submit(client, "and this", true);
  calls.length = 0;
  await delivery.turnEnded(client, { stopped: false });
  expect(calls).toEqual([
    ["delivery_status", { delivery_id: "id-1" }],
    ["delivery_status", { delivery_id: "id-2" }],
    ["send", { text: "then this", delivery_id: "id-4" }],
    ["delivery_status", { delivery_id: "id-3" }],
    ["send", { text: "and this", delivery_id: "id-5" }],
  ]);
  calls.length = 0;
  await delivery.turnEnded(client, { stopped: false });
  expect(calls).toEqual([]);
});

test("after a stop, dropped steers stay dropped", async () => {
  const { client, calls } = await server((method) => (method === "delivery_status" ? { result: { status: "dropped" } } : ok));
  const delivery = createDelivery(ids());
  await delivery.submit(client, "never mind", true);
  calls.length = 0;
  await delivery.turnEnded(client, { stopped: true });
  expect(calls).toEqual([]);
});

test("stop is a session abort", async () => {
  const { client, calls } = await server(() => ({ result: { aborted: true } }));
  expect(await stopTurn(client)).toEqual({ aborted: true });
  expect(calls).toEqual([["abort", {}]]);
});
