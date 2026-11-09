import { expect, jest, test } from "bun:test";
import { createClient, fromZetaHistory, type Transport } from "@fulcrum/zeta";
import { createDelivery, stopTurn, visibleDeliveryNotice } from "../src/delivery";
import { composerMethods } from "../scripts/fake-zeta";

type Reply = { result?: unknown; error?: { code: number; message: string; data?: unknown } };

/** A real zeta client over an in-memory transport; `answer` replies to each request by method. */
async function server(answer: (method: string, params: Record<string, unknown>) => Reply, features = ["delivery_id", "user_message_event", "user_message_delivery_id"], echo = true) {
  let deliver!: (text: string) => void;
  const calls: Array<[string, Record<string, unknown>]> = [];
  const transport: Transport = {
    onMessage(callback) { deliver = callback; },
    onClose() {},
    close() {},
    send(text) {
      const { id, method, params } = JSON.parse(text);
      if (method !== "hello") calls.push([method, params]);
      queueMicrotask(() => {
        // As zeta does, an accepted send or steer is echoed to the session before the reply.
        const reply = method === "hello" ? { result: { protocol_version: "1.2", capabilities: { features } } } : answer(method, params);
        if (echo && (method === "send" || method === "steer") && (reply.result as { accepted?: boolean } | undefined)?.accepted)
          deliver(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { event: "user_message", session_id: "s", text: params.text, mode: method, attachments: [], ...(params.delivery_id === undefined ? {} : { delivery_id: params.delivery_id }) } }));
        deliver(JSON.stringify({ jsonrpc: "2.0", id, ...reply }));
      });
    },
  };
  const client = createClient(transport, (flush) => flush());
  await client.hello(features);
  return { client, calls, emit: (event: Record<string, unknown>) => deliver(JSON.stringify({ jsonrpc: "2.0", method: "event", params: event })) };
}
const ids = () => { let n = 0; return () => `id-${++n}`; };
const ok = { result: { accepted: true } };

test("fake turn end emits and persists zeta's dropped steer shape with its original text", async () => {
  let active = false;
  const fake = composerMethods(async () => {}, { get: () => active, set: (value) => { active = value; } });
  const before = fake.history.length;
  const events: Record<string, unknown>[] = [];
  fake.handle("send", { text: "start", delivery_id: "fake-send" }, "s-reconnect", (event) => events.push(event));
  await Promise.resolve();
  active = true;
  fake.handle("steer", { text: "drop me", delivery_id: "fake-steer" }, "s-reconnect", (event) => events.push(event));
  for (let i = 0; i < 100; i++) await Promise.resolve();
  const expected = { role: "system", event: "delivery_status", delivery_id: "fake-steer", method: "steer", status: "dropped", reason: "turn_end", content: [{ type: "text", text: "drop me" }] };
  expect(events).toContainEqual({ ...expected, session_id: "s-reconnect", id: "delivery-fake-steer" });
  expect(fake.history.slice(before)).toContainEqual({ ...expected, id: "delivery-fake-steer" });
});

test("fake abort emits and persists zeta's dropped steer shape with its original text", async () => {
  let active = false;
  const fake = composerMethods(async () => {}, { get: () => active, set: (value) => { active = value; } });
  const before = fake.history.length;
  const events: Record<string, unknown>[] = [];
  fake.handle("send", { text: "start", delivery_id: "fake-send" }, "s-reconnect", (event) => events.push(event));
  await Promise.resolve();
  fake.handle("steer", { text: "stop this", delivery_id: "fake-steer" }, "s-reconnect", (event) => events.push(event));
  fake.handle("abort", {}, "s-reconnect", (event) => events.push(event));
  const expected = { role: "system", event: "delivery_status", delivery_id: "fake-steer", method: "steer", status: "dropped", reason: "abort", content: [{ type: "text", text: "stop this" }] };
  expect(events).toContainEqual({ ...expected, session_id: "s-reconnect", id: "delivery-fake-steer" });
  expect(fake.history.slice(before)).toContainEqual({ ...expected, id: "delivery-fake-steer" });
});

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

test("a later live delivery outcome retires an older not-confirmed note", () => {
  expect(visibleDeliveryNotice("unknown", undefined)).toBe("unknown");
  expect(visibleDeliveryNotice("unknown", "delivered")).toBeUndefined();
  expect(visibleDeliveryNotice("unknown", "dropped")).toBeUndefined();
});

test("a late echo after an unknown reply spends the saved id before the same text is sent again", async () => {
  let fail = true;
  const { client, calls, emit } = await server(() => fail ? { error: { code: -32000, message: "reply lost" } } : ok, fullFeatures, false);
  const lease = client.forSession("s");
  const delivery = createDelivery(ids(), undefined, lease.store);
  await expect(delivery.submit(client, "hello", false)).rejects.toThrow("reply lost");
  emit({ event: "user_message", session_id: "s", text: "hello", mode: "send", attachments: [], delivery_id: "id-1" });
  fail = false;
  await delivery.submit(client, "hello", false);
  expect(calls.map(([, params]) => params.delivery_id)).toEqual(["id-1", "id-2"]);
  lease.release();
});

test("submit names its delivery id to the composer; a failure after zeta's echo spends the id, so the same text later is a new message", async () => {
  let echoThenFail = true;
  const { client, calls, emit } = await server((method, params) => {
    if (method !== "send" || !echoThenFail) return ok;
    emit({ event: "user_message", session_id: "s", text: params.text, mode: "send", attachments: [], delivery_id: params.delivery_id });
    return { error: { code: -32000, message: "reply lost" } };
  }, fullFeatures, false);
  const lease = client.forSession("s");
  const tracked: string[] = [];
  const delivery = createDelivery(ids(), undefined, lease.store);
  await expect(delivery.submit(client, "hello", false, (id: string) => tracked.push(id))).rejects.toThrow("reply lost");
  echoThenFail = false;
  await delivery.submit(client, "hello", false, (id: string) => tracked.push(id));
  expect(calls.map(([, params]) => params.delivery_id)).toEqual(["id-1", "id-2"]);
  expect(tracked).toEqual(["id-1", "id-2"]);
  lease.release();
});

test("a turn that ends before a steer lands sends it instead, and one that starts before a send steers, with the same id", async () => {
  const { client, calls } = await server((method) => (method === "steer" ? { error: { code: -32005, message: "no turn is running" } } : ok));
  await createDelivery(ids()).submit(client, "late steer", true);
  const busy = await server((method) => (method === "send" ? { error: { code: -32004, message: "a turn is already running" } } : ok));
  await createDelivery(ids()).submit(busy.client, "early send", false);
  expect(calls).toEqual([["steer", { text: "late steer", delivery_id: "id-1" }], ["send", { text: "late steer", delivery_id: "id-1" }]]);
  expect(busy.calls).toEqual([["send", { text: "early send", delivery_id: "id-1" }], ["steer", { text: "early send", delivery_id: "id-1" }]]);
});

test("live dropped status resends without polling when fidelity is negotiated", async () => {
  const { client, calls, emit } = await server((method) => method === "delivery_status" ? { result: { status: "dropped" } } : ok, ["delivery_id", "session_history_fidelity"]);
  const lease = client.forSession("s");
  const delivery = createDelivery(ids(), undefined, lease.store);
  await delivery.submit(client, "start", false);
  await delivery.submit(client, "try again", true);
  emit({ event: "delivery_status", session_id: "s", id: "drop-1", role: "system", delivery_id: "id-2", method: "steer", status: "dropped", content: [{ type: "text", text: "try again" }] });
  calls.length = 0;
  await delivery.turnEnded(client);
  expect(calls).toEqual([["send", { text: "try again", delivery_id: "id-3" }]]);
  lease.release();
});

const fullFeatures = ["delivery_id", "user_message_event", "user_message_delivery_id", "session_history_fidelity"];

test("a restart snapshot after the drop rebuilds the steer's row from history; its status is read there, without polling", async () => {
  const { client, calls } = await server((method) => method === "delivery_status" ? { result: { status: "delivered" } } : ok, fullFeatures);
  const lease = client.forSession("s");
  const delivery = createDelivery(ids(), undefined, lease.store);
  await delivery.submit(client, "start", false);
  await delivery.submit(client, "try again", true);
  lease.store.resync(fromZetaHistory([
    { id: "u1", role: "user", content: [{ type: "text", text: "start" }], tool_result: null, delivery_id: "id-1" },
    { id: "drop-1", role: "system", event: "delivery_status", delivery_id: "id-2", method: "steer", status: "dropped", reason: "turn_end", content: [{ type: "text", text: "try again" }] },
  ]));
  expect(lease.store.getItem("user:delivery:id-2")?.type).toBe("user"); // history names the row by its delivery id, not the intent
  calls.length = 0;
  await delivery.turnEnded(client);
  expect(calls).toEqual([["send", { text: "try again", delivery_id: "id-3" }]]);
  lease.release();
});

test("a drop after a restart rebuilds one row and resends once without a redundant status poll", async () => {
  jest.useFakeTimers();
  try {
    const { client, calls, emit } = await server((method) => method === "delivery_status" ? { result: { status: "dropped" } } : ok, fullFeatures);
    const lease = client.forSession("s");
    const delivery = createDelivery(ids(), undefined, lease.store);
    await delivery.submit(client, "start", false);
    await delivery.submit(client, "survive restart", true);
    lease.store.resync([]); // the snapshot's history has no row for the queued steer yet
    emit({ event: "delivery_status", session_id: "s", id: "drop-1", role: "system", delivery_id: "id-2", method: "steer", status: "dropped", reason: "turn_end", content: [{ type: "text", text: "survive restart" }] });
    calls.length = 0;
    let result: Awaited<ReturnType<typeof delivery.turnEnded>> | undefined;
    void delivery.turnEnded(client).then((value) => { result = value; });
    await Promise.resolve();
    jest.advanceTimersByTime(1_000);
    for (let i = 0; i < 20 && !result; i++) await Promise.resolve();
    expect(result).toEqual([]);
    expect(lease.store.getItem("user:delivery:id-2")).toMatchObject({ event: { text: "", text_omitted: true, delivery_status: "dropped" } });
    expect(lease.store.getOutline().filter(({ id }) => id === "user:delivery:id-2")).toHaveLength(1);
    expect(calls).toEqual([["send", { text: "survive restart", delivery_id: "id-3" }]]);
    lease.release();
  } finally {
    jest.useRealTimers();
  }
});

test("live dropped status may arrive after turn end starts", async () => {
  const { client, calls, emit } = await server(() => ok, ["delivery_id", "session_history_fidelity"]);
  const lease = client.forSession("s");
  const delivery = createDelivery(ids(), undefined, lease.store);
  await delivery.submit(client, "start", false);
  await delivery.submit(client, "late event", true);
  calls.length = 0;
  const ended = delivery.turnEnded(client);
  queueMicrotask(() => emit({ event: "delivery_status", session_id: "s", id: "drop-1", role: "system", delivery_id: "id-2", method: "steer", status: "dropped", content: [{ type: "text", text: "late event" }] }));
  await ended;
  expect(calls.map(([method]) => method)).toEqual(["send"]);
  lease.release();
});

test("live dropped status after stop marks not delivered without polling", async () => {
  const { client, calls, emit } = await server((method) => method === "delivery_status" ? { result: { status: "dropped" } } : ok, ["delivery_id", "session_history_fidelity"]);
  const lease = client.forSession("s");
  const delivery = createDelivery(ids(), undefined, lease.store);
  await delivery.submit(client, "start", false);
  await delivery.submit(client, "cancel this", true);
  await delivery.stop(client);
  emit({ event: "delivery_status", session_id: "s", id: "drop-1", role: "system", delivery_id: "id-2", method: "steer", status: "dropped", content: [{ type: "text", text: "cancel this" }] });
  calls.length = 0;
  expect(await delivery.turnEnded(client)).toEqual([{ intent: "id-2", outcome: "dropped" }]);
  expect(calls).toEqual([]);
  lease.release();
});

test("fake abort event marks its queued steer not delivered through the real client", async () => {
  let active = false;
  const fake = composerMethods(async () => {}, { get: () => active, set: (value) => { active = value; } });
  let emitFake = (_event: Record<string, unknown>) => {};
  const connection = await server((method, params) => fake.handle(method, params, "s", emitFake) ?? ok, ["delivery_id", "session_history_fidelity"], false);
  emitFake = connection.emit;
  const lease = connection.client.forSession("s");
  const delivery = createDelivery(ids(), undefined, lease.store);
  await delivery.submit(connection.client, "start", false);
  await delivery.submit(connection.client, "stop this", true);
  await delivery.stop(connection.client);
  connection.calls.length = 0;
  expect(await delivery.turnEnded(connection.client)).toEqual([{ intent: "id-2", outcome: "dropped" }]);
  expect(connection.calls).toEqual([]);
  lease.release();
});

test("the store is watched only while a turn end waits for live drops, and the watch is removed after", async () => {
  jest.useFakeTimers();
  try {
    const { client, calls, emit } = await server((method) => method === "delivery_status" ? { result: { status: "delivered" } } : ok, ["delivery_id", "session_history_fidelity"]);
    const lease = client.forSession("s");
    let listeners = 0;
    let notices = 0;
    const store = { ...lease.store, subscribe: (listener: () => void) => {
      listeners++;
      const stop = lease.store.subscribe(() => { notices++; listener(); });
      return () => { listeners--; stop(); };
    } } as typeof lease.store;
    const delivery = createDelivery(ids(), undefined, store);
    await delivery.submit(client, "start", false);
    await delivery.submit(client, "dropped one", true);
    await delivery.submit(client, "delivered one", true);
    expect(listeners).toBe(0);
    calls.length = 0;
    let result: Awaited<ReturnType<typeof delivery.turnEnded>> | undefined;
    void delivery.turnEnded(client).then((value) => { result = value; });
    await Promise.resolve();
    expect(listeners).toBe(1);
    emit({ event: "delivery_status", session_id: "s", id: "drop-1", role: "system", delivery_id: "id-2", method: "steer", status: "dropped", content: [{ type: "text", text: "dropped one" }] });
    expect(listeners).toBe(1); // the delivered steer still waits
    jest.advanceTimersByTime(1_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(listeners).toBe(0);
    expect(result).toEqual([]);
    expect(calls).toEqual([["delivery_status", { delivery_id: "id-3" }], ["send", { text: "dropped one", delivery_id: "id-4" }]]);
    const seen = notices;
    emit({ event: "user_message", session_id: "s", text: "later", mode: "send", attachments: [] });
    expect(notices).toBe(seen);
    lease.release();
  } finally {
    jest.useRealTimers();
  }
});

test("negotiated turn end without a drop event asks zeta once and does not resend a delivered steer", async () => {
  jest.useFakeTimers();
  try {
    const { client, calls } = await server((method) => method === "delivery_status" ? { result: { status: "delivered" } } : ok, ["delivery_id", "session_history_fidelity"]);
    const lease = client.forSession("s");
    const delivery = createDelivery(ids(), undefined, lease.store);
    await delivery.submit(client, "start", false);
    await delivery.submit(client, "already delivered", true);
    calls.length = 0;
    let result: Awaited<ReturnType<typeof delivery.turnEnded>> | undefined;
    void delivery.turnEnded(client).then((value) => { result = value; });
    await Promise.resolve();
    jest.advanceTimersByTime(1_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(result).toEqual([]);
    expect(calls).toEqual([["delivery_status", { delivery_id: "id-2" }]]); // no live status after the wait: asked once, not resent
    lease.release();
  } finally {
    jest.useRealTimers();
  }
});

test.each([
  ["delivered", true, []],
  ["dropped", false, []],
  ["unknown", false, [{ intent: "id-1", outcome: "unknown" }]],
  ["future-outcome", false, [{ intent: "id-1", outcome: "unknown" }]],
] as const)("an evicted %s outcome has the same meaning during submit and turn end", async (outcome, accepted, notices) => {
  let path: "submit" | "turn-end" = "submit";
  const { client, calls } = await server((method) => {
    if (method === "delivery_status") return { result: { status: "evicted", outcome } };
    if (path === "submit") return { error: { code: -32010, message: "evicted", data: { outcome } } };
    return ok;
  });

  const submit = createDelivery(ids());
  const submitAccepted = await submit.submit(client, "keep me", false).then(() => true, () => false);
  await submit.submit(client, "keep me", false).catch(() => {});
  const submitIds = calls.slice(0, 2).map(([, params]) => params.delivery_id);

  path = "turn-end";
  calls.length = 0;
  const turnEnd = createDelivery(ids());
  await turnEnd.submit(client, "steer me", true);
  calls.length = 0;
  const actualNotices = await turnEnd.turnEnded(client);
  const turnMethods = calls.map(([method]) => method);
  expect({ submitAccepted, submitIds, notices: actualNotices, turnMethods }).toEqual({
    submitAccepted: accepted,
    submitIds: accepted ? ["id-1", "id-2"] : ["id-1", "id-1"],
    notices,
    turnMethods: outcome === "dropped" ? ["delivery_status", "send"] : ["delivery_status"],
  });
});

test("a steer the turn dropped at its end is resent as a new message, in order; delivered ones are not", async () => {
  const status: Record<string, string> = { "id-1": "delivered", "id-2": "dropped", "id-3": "dropped" };
  const { client, calls } = await server((method, params) => (method === "delivery_status" ? { result: { delivery_id: params.delivery_id, status: status[params.delivery_id as string] } } : ok));
  const delivery = createDelivery(ids());
  await delivery.submit(client, "read first", true);
  await delivery.submit(client, "then this", true);
  await delivery.submit(client, "and this", true);
  calls.length = 0;
  await delivery.turnEnded(client);
  expect(calls).toEqual([
    ["delivery_status", { delivery_id: "id-1" }],
    ["delivery_status", { delivery_id: "id-2" }],
    ["delivery_status", { delivery_id: "id-3" }], // the turn has ended: every status is final, so they are read at once
    ["send", { text: "then this", delivery_id: "id-4" }],
    ["send", { text: "and this", delivery_id: "id-5" }],
  ]);
  calls.length = 0;
  await delivery.turnEnded(client);
  expect(calls).toEqual([]);
});

test("a dropped steer and its resend are one user row, which becomes the sent message in place", async () => {
  const { client } = await server((method, params) => (method === "delivery_status" ? { result: { delivery_id: params.delivery_id, status: "dropped" } } : ok));
  const delivery = createDelivery(ids());
  await delivery.submit(client, "run the tests", false);
  await delivery.submit(client, "also windows", true);
  await delivery.turnEnded(client);
  const { store } = client.forSession("s");
  const users = store.getOutline().filter((entry) => entry.kind === "user").map((entry) => store.getItem(entry.id));
  expect(users.map((item) => item?.type === "user" && item.event.type === "user_message" && `${item.event.mode}:${item.event.text}`)).toEqual(["send:run the tests", "send:also windows"]);
});

test("after a stop, dropped steers stay dropped and are reported by intent; delivered ones are not", async () => {
  const status: Record<string, string> = { "id-1": "dropped", "id-2": "delivered" };
  const { client, calls } = await server((method, params) => (method === "delivery_status" ? { result: { status: status[params.delivery_id as string] } } : ok));
  const delivery = createDelivery(ids());
  await delivery.submit(client, "never mind", true);
  await delivery.submit(client, "this one landed", true);
  await delivery.stop(client);
  calls.length = 0;
  expect(await delivery.turnEnded(client)).toEqual([{ intent: "id-1", outcome: "dropped" }]);
  expect(calls).toEqual([["delivery_status", { delivery_id: "id-1" }], ["delivery_status", { delivery_id: "id-2" }]]);
});

test("one failed delivery_status query keeps the marks the other queries found", async () => {
  const { client } = await server((method, params) => method !== "delivery_status" ? ok
    : params.delivery_id === "id-1" ? { error: { code: -32003, message: "socket dropped" } } : { result: { status: "dropped" } });
  const delivery = createDelivery(ids());
  await delivery.submit(client, "first", true);
  await delivery.submit(client, "second", true);
  await delivery.stop(client);
  expect(await delivery.turnEnded(client)).toEqual([{ intent: "id-2", outcome: "dropped" }]);
});

test("a stop that failed, or found no turn, is not a stop: steers the turn's own end dropped are resent", async () => {
  for (const abort of [{ error: { code: -32003, message: "socket dropped" } }, { result: { aborted: false } }]) {
    const { client, calls } = await server((method) => method === "abort" ? abort : method === "delivery_status" ? { result: { status: "dropped" } } : ok);
    const delivery = createDelivery(ids());
    await delivery.submit(client, "keep going", true);
    await delivery.stop(client).catch(() => {});
    calls.length = 0;
    expect(await delivery.turnEnded(client)).toEqual([]);
    expect(calls.map(([method]) => method)).toEqual(["delivery_status", "send"]);
  }
});

test("stop is a session abort", async () => {
  const { client, calls } = await server(() => ({ result: { aborted: true } }));
  expect(await stopTurn(client)).toEqual({ aborted: true });
  expect(calls).toEqual([["abort", {}]]);
});

test("accepted delivery without an echo reconciles one synthetic user event", async () => {
  const { client } = await server(() => ok, ["delivery_id", "user_message_event", "user_message_delivery_id"], false);
  const events: unknown[] = [];
  const delivery = createDelivery(ids(), (event) => events.push(event));
  await delivery.submit(client, "hello", false);
  expect(events).toEqual([{ type: "user_message", text: "hello", mode: "send", intent: "id-1", delivery_id: "id-1" }]);
});
