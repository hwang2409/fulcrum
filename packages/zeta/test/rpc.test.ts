import { expect, jest, test } from "bun:test";
import type { RunEvent } from "@fulcrum/core";
import { connect, createClient, type Transport } from "../src/index.js";

function fakeTransport() {
  let onMessage!: (text: string) => void;
  let onClose = (_code?: number) => {};
  const sent: Array<Record<string, unknown>> = [];
  const transport: Transport = {
    send(text) { sent.push(JSON.parse(text)); },
    onMessage(callback) { onMessage = callback; },
    onClose(callback) { onClose = callback; },
    close() {},
  };
  return {
    transport,
    sent,
    receive: (message: unknown) => onMessage(JSON.stringify(message)),
    drop: (code?: number) => onClose(code),
  };
}

async function hello(fake: ReturnType<typeof fakeTransport>, client: ReturnType<typeof createClient>) {
  const ready = client.hello(["session_history_fidelity", "content_read"]);
  fake.receive({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.2", capabilities: { features: ["session_history_fidelity", "content_read"] } } });
  await ready;
}

test("session stores use the session id across clients and replay replacements", async () => {
  const first = connect(fakeTransport().transport, (flush) => flush());
  const second = connect(fakeTransport().transport, (flush) => flush());
  const firstLease = first.forSession("session-a");
  const secondLease = second.forSession("session-a");
  const otherLease = second.forSession("session-b");
  const replayed = await first.replay("session-a", async () => []);
  try {
    expect(firstLease.store.runId).toBe("session-a");
    expect(secondLease.store.runId).toBe(firstLease.store.runId);
    expect(replayed.store.runId).toBe("session-a");
    expect(otherLease.store.runId).toBe("session-b");
  } finally {
    firstLease.release();
    secondLease.release();
    otherLease.release();
    replayed.release();
    first.close();
    second.close();
  }
});

test("content_read joins chunks, accepts a short final chunk, and sends no session id", async () => {
  const fake = fakeTransport();
  const client = createClient(fake.transport);
  await hello(fake, client);
  const reading = client.readContent("opaque");
  fake.receive({ jsonrpc: "2.0", id: 2, result: { handle: "opaque", media_type: "image/png", title: "x", size: 7, offset: 0, data: btoa("abc"), next_offset: 3, eof: false } });
  await Promise.resolve();
  fake.receive({ jsonrpc: "2.0", id: 3, result: { handle: "opaque", media_type: "image/png", title: "x", size: 7, offset: 3, data: btoa("def"), next_offset: 6, eof: false } });
  await Promise.resolve();
  fake.receive({ jsonrpc: "2.0", id: 4, result: { handle: "opaque", media_type: "image/png", title: "x", size: 7, offset: 6, data: btoa("g"), next_offset: 7, eof: true } });
  const blob = await reading;
  expect(await blob.text()).toBe("abcdefg");
  expect(blob.type).toBe("image/png");
  expect(fake.sent.slice(1).map((message) => message.params)).toEqual([
    { handle: "opaque", offset: 0 }, { handle: "opaque", offset: 3 }, { handle: "opaque", offset: 6 },
  ]);
});

test("content_read rejects declared sizes over the cap and is abortable", async () => {
  const fake = fakeTransport();
  const client = createClient(fake.transport);
  await hello(fake, client);
  const tooLarge = client.readContent("large", { maxBytes: 2 });
  fake.receive({ jsonrpc: "2.0", id: 2, result: { handle: "large", media_type: "image/png", size: 3, offset: 0, data: "", next_offset: 0, eof: false } });
  await expect(tooLarge).rejects.toMatchObject({ kind: "too_large" });
  const controller = new AbortController();
  const aborted = client.readContent("slow", { signal: controller.signal });
  controller.abort();
  await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
});

test("content_not_found has a typed not-available error", async () => {
  const fake = fakeTransport();
  const client = createClient(fake.transport);
  await hello(fake, client);
  const reading = client.readContent("gone");
  fake.receive({ jsonrpc: "2.0", id: 2, error: { code: -32012, message: "content not found", data: { code: "content_not_found" } } });
  await expect(reading).rejects.toMatchObject({ name: "ContentReadError", kind: "not_available" });
});

const validChunk = { handle: "opaque", media_type: "image/png", title: "image", size: 1, offset: 0, data: btoa("a"), next_offset: 1, eof: true };

test("content_read rejects malformed single-chunk replies", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["wrong handle", { handle: "other" }],
    ["wrong offset", { offset: 1 }],
    ["invalid title", { title: 7 }],
    ["malformed base64", { data: "%%%" }],
    ["inconsistent byte count", { next_offset: 0 }],
    ["early eof", { size: 2 }],
  ];
  for (const [name, change] of cases) {
    const fake = fakeTransport();
    const client = createClient(fake.transport);
    await hello(fake, client);
    const reading = client.readContent("opaque");
    fake.receive({ jsonrpc: "2.0", id: 2, result: { ...validChunk, ...change } });
    await expect(reading, name).rejects.toMatchObject({ kind: "invalid_response" });
  }
});

test("content_read rejects metadata changes and non-advancing chunks", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["size", { size: 3 }],
    ["media type", { media_type: "image/jpeg" }],
    ["title", { title: "other" }],
    ["offset", { offset: 0 }],
  ];
  for (const [name, change] of cases) {
    const fake = fakeTransport();
    const client = createClient(fake.transport);
    await hello(fake, client);
    const reading = client.readContent("opaque");
    fake.receive({ jsonrpc: "2.0", id: 2, result: { ...validChunk, size: 2, data: btoa("a"), next_offset: 1, eof: false } });
    await Promise.resolve();
    fake.receive({ jsonrpc: "2.0", id: 3, result: { ...validChunk, size: 2, offset: 1, data: btoa("b"), next_offset: 2, ...change } });
    await expect(reading, name).rejects.toMatchObject({ kind: "invalid_response" });
  }
  const fake = fakeTransport();
  const client = createClient(fake.transport);
  await hello(fake, client);
  const stalled = client.readContent("opaque");
  fake.receive({ jsonrpc: "2.0", id: 2, result: { ...validChunk, size: 1, data: "", next_offset: 0, eof: false } });
  await expect(stalled).rejects.toMatchObject({ kind: "invalid_response" });
});

test("content_read maps protocol and request rpc errors", async () => {
  for (const [code, kind] of [[-32601, "not_negotiated"], [-32602, "invalid_request"]] as const) {
    const fake = fakeTransport();
    const client = createClient(fake.transport);
    await hello(fake, client);
    const reading = client.readContent("opaque");
    fake.receive({ jsonrpc: "2.0", id: 2, error: { code, message: "no" } });
    await expect(reading).rejects.toMatchObject({ kind });
  }
});

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
  expect(client.protocolVersion).toBe("1.2");
  expect(client.features).not.toContain("list_sessions_paging");
});

test("malformed feature lists are treated as empty", async () => {
  for (const features of ["approval_history", ["approval_history", 4]]) {
    const fake = fakeTransport();
    const client = connect(fake.transport);
    const hello = client.hello(["approval_history"]);
    fake.receive({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.2", capabilities: { features } } });
    await hello;
    expect(client.features).toEqual([]);
  }
});

test("an older negotiated version disables features", async () => {
  const fake = fakeTransport();
  const client = connect(fake.transport);
  const hello = client.hello(["approval_history"]);
  fake.receive({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.0" } });
  await hello;
  expect(client.protocolVersion).toBe("1.0");
  expect(client.features).toEqual([]);
});

test("hello, responses, errors, and events", async () => {
  const fake = fakeTransport();
  const client = connect(fake.transport);
  const hello = client.hello();
  fake.receive({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.0" } });
  expect(await hello).toEqual({ protocol_version: "1.0" });
  expect((fake.sent[0].params as Record<string, unknown>).protocol_version).toBe("1.2");

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

test("replay drops ambiguous live events and starts routing only after the snapshot boundary", async () => {
  const fake = fakeTransport();
  const client = createClient(fake.transport, (flush) => flush());
  const event = (delta: string) => ({ jsonrpc: "2.0", method: "event", params: { event: "assistant_delta", session_id: "s1", delta, kind: "assistant" } });
  fake.receive(event("stale"));
  const stale = client.forSession("s1");
  stale.release();
  let finish!: () => void;
  const loaded = new Promise<void>((resolve) => { finish = resolve; });
  const opening = client.replay("s1", async () => {
    await loaded;
    return [{ type: "user_message", text: "from history", mode: "send" }];
  }, true);
  fake.receive(event("live"));
  finish();
  const lease = await opening;
  expect(lease.store).not.toBe(stale.store);
  const items = lease.store.getOutline().map(({ id }) => lease.store.getItem(id));
  expect(items.map((item) => item?.type === "user" ? "user" : item?.type === "message" ? item.text : item?.type)).toEqual(["user"]);
  expect(client.finishReplay("s1", client.replayRevision("s1"))).toBe(true);
  fake.receive(event("after snapshot"));
  expect(lease.store.getItem(lease.store.getOutline()[1]!.id)).toMatchObject({ text: "after snapshot" });
  lease.release();
});

test("replay drops an event that arrives while history is being committed", async () => {
  const fake = fakeTransport();
  let inject = true;
  const client = createClient(fake.transport, (flush) => {
    flush();
    if (inject) {
      inject = false;
      fake.receive({ jsonrpc: "2.0", method: "event", params: { event: "agent_start", session_id: "s1" } });
    }
  });
  const lease = await client.replay("s1", async () => [{ type: "run_start" }, { type: "run_end" }]);
  expect(lease.store.getState().agent).toBe("idle");
});

test("a desynced session store reloads its history and keeps its lease", async () => {
  const fake = fakeTransport();
  const client = connect(fake.transport, (flush) => flush());
  let loads = 0;
  const lease = await client.replay("s1", async () => [{
    type: "user_message" as const,
    text: `history ${++loads}`,
    mode: "send",
    delivery_id: `d${loads}`,
  }]);
  let reads = 0;
  lease.store.dispatch(new Proxy({ type: "retry" }, {
    get(target, key, receiver) {
      if (key === "type" && ++reads > 3) throw new Error("boom");
      return Reflect.get(target, key, receiver);
    },
  }) as RunEvent);
  for (let attempt = 0; attempt < 10 && lease.store.getDiagnostics().desynced; attempt++) await Promise.resolve();

  expect(loads).toBe(2);
  expect(lease.store.getDiagnostics().desynced).toBe(false);
  expect(lease.store.getOutline()).toEqual([{ id: "user:delivery:d2", kind: "user" }]);
});

test("desync history reload recovers automatically after transient failures", async () => {
  jest.useFakeTimers();
  try {
    const fake = fakeTransport();
    const client = connect(fake.transport, (flush) => flush());
    let loads = 0;
    let failures = 0;
    const lease = await client.replay("transient", async () => {
      loads++;
      if (failures-- > 0) throw new Error("history unavailable");
      return [{ type: "user_message" as const, text: `history ${loads}`, mode: "send", delivery_id: `d${loads}` }];
    });
    failures = 3;
    let reads = 0;
    lease.store.dispatch(new Proxy({ type: "retry" }, {
      get(target, key, receiver) {
        if (key === "type" && ++reads > 3) throw new Error("reducer failed");
        return Reflect.get(target, key, receiver);
      },
    }) as RunEvent);
    await Promise.resolve();
    for (const delay of [500, 1_000, 2_000]) {
      jest.advanceTimersByTime(delay);
      await Promise.resolve();
    }

    expect(loads).toBe(5);
    expect(lease.store.getDiagnostics()).toEqual({ ignoredEvents: 0, sanitizedFields: 0, desynced: false });
    expect(lease.store.getOutline()).toEqual([{ id: "user:delivery:d5", kind: "user" }]);
  } finally {
    jest.useRealTimers();
  }
});

test("desync history reload uses bounded exponential backoff", async () => {
  jest.useFakeTimers();
  try {
    const fake = fakeTransport();
    const client = connect(fake.transport, (flush) => flush());
    let loads = 0;
    let fail = false;
    const lease = await client.replay("backoff", async () => {
      loads++;
      if (fail) throw new Error("history unavailable");
      return [];
    });
    fail = true;
    let reads = 0;
    lease.store.dispatch(new Proxy({ type: "retry" }, {
      get(target, key, receiver) {
        if (key === "type" && ++reads > 3) throw new Error("reducer failed");
        return Reflect.get(target, key, receiver);
      },
    }) as RunEvent);
    await Promise.resolve();
    expect(loads).toBe(2);

    for (const [elapsed, expectedLoads] of [[499, 2], [1, 3], [999, 3], [1, 4], [2000, 5], [4000, 6], [8000, 7]] as const) {
      jest.advanceTimersByTime(elapsed);
      await Promise.resolve();
      expect(loads).toBe(expectedLoads);
    }
    expect(lease.store.getDiagnostics().resyncError).toBe("history unavailable");
  } finally {
    jest.useRealTimers();
  }
});

test("failed desync history reloads are bounded, visible, and manually retryable", async () => {
  jest.useFakeTimers();
  try {
    const fake = fakeTransport();
    const client = connect(fake.transport, (flush) => flush());
    let loads = 0;
    let fail = false;
    const lease = await client.replay("retryable", async () => {
      loads++;
      if (fail) throw new Error("history unavailable");
      return [{ type: "user_message" as const, text: `history ${loads}`, mode: "send", delivery_id: `d${loads}` }];
    });
    fail = true;
    let reads = 0;
    lease.store.dispatch(new Proxy({ type: "retry" }, {
      get(target, key, receiver) {
        if (key === "type" && ++reads > 3) throw new Error("reducer failed");
        return Reflect.get(target, key, receiver);
      },
    }) as RunEvent);
    await Promise.resolve();
    for (const delay of [500, 1_000, 2_000, 4_000, 8_000]) {
      jest.advanceTimersByTime(delay);
      await Promise.resolve();
    }
    await Promise.resolve();

    expect(loads).toBe(7);
    expect(lease.store.getDiagnostics()).toEqual({
      ignoredEvents: 0,
      sanitizedFields: 0,
      desynced: true,
      reason: "reducer failed",
      resyncError: "history unavailable",
    });
    expect(lease.store.getOutline()).toEqual([{ id: "user:delivery:d1", kind: "user" }]);

    fail = false;
    await client.retrySession("retryable");
    expect(loads).toBe(8);
    expect(lease.store.getDiagnostics()).toEqual({ ignoredEvents: 0, sanitizedFields: 0, desynced: false });
    expect(lease.store.getOutline()).toEqual([{ id: "user:delivery:d8", kind: "user" }]);
  } finally {
    jest.useRealTimers();
  }
});

const forceDesync = (store: ReturnType<ReturnType<typeof connect>["forSession"]>["store"]) => {
  let reads = 0;
  store.dispatch(new Proxy({ type: "retry" }, {
    get(target, key, receiver) {
      if (key === "type" && ++reads > 3) throw new Error("reducer failed");
      return Reflect.get(target, key, receiver);
    },
  }) as RunEvent);
};

for (const action of ["evict", "close"] as const) {
  test(`${action} aborts an in-flight replay load`, async () => {
    const fake = fakeTransport();
    const client = connect(fake.transport, (flush) => flush());
    let aborted = false;
    const opening = client.replay(action, (signal) => new Promise<RunEvent[]>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(Object.assign(new Error("request aborted"), { name: "AbortError" }));
      }, { once: true });
    }));
    if (action === "evict") client.evictSession(action);
    else client.close();
    expect(aborted).toBe(true);
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
  });

  test(`${action} cancels a pending resync backoff`, async () => {
    jest.useFakeTimers();
    try {
      const fake = fakeTransport();
      const client = connect(fake.transport, (flush) => flush());
      let loads = 0;
      let fail = false;
      const lease = await client.replay(action, async () => {
        loads++;
        if (fail) throw new Error("history unavailable");
        return [];
      });
      fail = true;
      forceDesync(lease.store);
      await Promise.resolve();
      expect(loads).toBe(2);

      if (action === "evict") client.evictSession(action);
      else client.close();
      jest.advanceTimersByTime(20_000);
      await Promise.resolve();
      await Promise.resolve();
      expect(loads).toBe(2);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
}

test("transport close kills the old recovery before a fresh client recovers once", async () => {
  jest.useFakeTimers();
  try {
    const oldTransport = fakeTransport();
    const oldClient = connect(oldTransport.transport, (flush) => flush());
    let oldLoads = 0;
    let oldFail = false;
    const oldLease = await oldClient.replay("s", async () => {
      oldLoads++;
      if (oldFail) throw new Error("history unavailable");
      return [];
    });
    oldFail = true;
    forceDesync(oldLease.store);
    await Promise.resolve();
    expect(oldLoads).toBe(2);
    oldTransport.drop(1006);

    const freshTransport = fakeTransport();
    const freshClient = connect(freshTransport.transport, (flush) => flush());
    let freshLoads = 0;
    const freshLease = await freshClient.replay("s", async () => {
      freshLoads++;
      return [];
    });
    forceDesync(freshLease.store);
    await Promise.resolve();
    expect(freshLoads).toBe(2);

    jest.advanceTimersByTime(20_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(oldLoads).toBe(2);
    expect(freshLoads).toBe(2);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

test("successful resync clears its pending backoff timer", async () => {
  jest.useFakeTimers();
  try {
    const fake = fakeTransport();
    const client = connect(fake.transport, (flush) => flush());
    let loads = 0;
    let failures = 0;
    const lease = await client.replay("success", async () => {
      loads++;
      if (failures-- > 0) throw new Error("history unavailable");
      return [];
    });
    failures = 1;
    forceDesync(lease.store);
    await Promise.resolve();
    expect(loads).toBe(2);
    expect(jest.getTimerCount()).toBe(1);

    jest.advanceTimersByTime(500);
    await Promise.resolve();
    await Promise.resolve();
    expect(loads).toBe(3);
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(20_000);
    await Promise.resolve();
    expect(loads).toBe(3);
  } finally {
    jest.useRealTimers();
  }
});

test("negotiated delivery ids match echoes by id, not text", async () => {
  const fake = fakeTransport();
  const client = connect(fake.transport);
  const hello = client.hello(["delivery_id", "user_message_event", "user_message_delivery_id"]);
  fake.receive({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.2", capabilities: { features: ["delivery_id", "user_message_event", "user_message_delivery_id"] } } });
  await hello;
  const first = client.request("send", { text: "same", delivery_id: "d-1" }, { intent: "first" });
  const second = client.request("steer", { text: "same", delivery_id: "d-2" }, { intent: "second" });
  fake.receive({ jsonrpc: "2.0", method: "event", params: { event: "user_message", session_id: "s", text: "same", mode: "steer", delivery_id: "d-2" } });
  fake.receive({ jsonrpc: "2.0", method: "event", params: { event: "user_message", session_id: "s", text: "same", mode: "send", delivery_id: "unknown" } });
  fake.receive({ jsonrpc: "2.0", method: "event", params: { event: "user_message", session_id: "s", text: "same", mode: "send", delivery_id: "d-1" } });
  fake.receive({ jsonrpc: "2.0", id: 2, result: { accepted: true } });
  fake.receive({ jsonrpc: "2.0", id: 3, result: { accepted: true } });
  await Promise.all([first, second]);
  const users = client.forSession("s").store.getOutline().filter((entry) => entry.kind === "user");
  expect(users.map(({ id }) => id)).toEqual(["user:intent:second", "user:delivery:unknown", "user:intent:first"]);
});

test("send_images keeps delivery ids only when its feature is negotiated", async () => {
  const fake = fakeTransport();
  const client = connect(fake.transport);
  const hello = client.hello(["delivery_id", "user_message_event", "user_message_delivery_id"]);
  expect(fake.sent[0]?.params.features).toContain("send_images_delivery_id");
  fake.receive({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.2", capabilities: { features: ["delivery_id", "user_message_event", "user_message_delivery_id", "send_images_delivery_id"] } } });
  await hello;
  const sending = client.request("send_images", { text: "with id", delivery_id: "image-delivery", images: [] }, { intent: "image-intent" });
  expect(fake.sent.at(-1)?.params).toMatchObject({ delivery_id: "image-delivery" });
  fake.receive({ jsonrpc: "2.0", method: "event", params: { event: "user_message", session_id: "s", text: "with id", mode: "send", delivery_id: "image-delivery", attachments: [{ name: "x.png" }] } });
  fake.receive({ jsonrpc: "2.0", id: 2, result: { accepted: true } });
  await sending;
  expect(client.forSession("s").store.getOutline().filter((entry) => entry.kind === "user").map(({ id }) => id)).toEqual(["user:intent:image-intent"]);
});

test("an id-less send_images echo uses text intent fallback without duplicating delivery", async () => {
  const fake = fakeTransport();
  const client = connect(fake.transport);
  const hello = client.hello(["delivery_id", "user_message_event", "user_message_delivery_id"]);
  fake.receive({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.2", capabilities: { features: ["delivery_id", "user_message_event", "user_message_delivery_id"] } } });
  await hello;
  const sending = client.request("send_images", { text: "look", images: [], delivery_id: "image-delivery" }, { intent: "image-intent" });
  expect(fake.sent.at(-1)?.params).not.toHaveProperty("delivery_id");
  fake.receive({ jsonrpc: "2.0", method: "event", params: { event: "user_message", session_id: "s", text: "look", mode: "send", attachments: [{ name: "x.png" }] } });
  fake.receive({ jsonrpc: "2.0", id: 2, result: { accepted: true } });
  await sending;
  expect(client.forSession("s").store.getOutline().filter((entry) => entry.kind === "user").map(({ id }) => id)).toEqual(["user:intent:image-intent"]);
});

test("an id-less image echo selects send_images over a same-text send", async () => {
  const fake = fakeTransport();
  const client = connect(fake.transport);
  const hello = client.hello(["delivery_id", "user_message_event", "user_message_delivery_id"]);
  fake.receive({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.2", capabilities: { features: ["delivery_id", "user_message_event", "user_message_delivery_id"] } } });
  await hello;
  const text = client.request("send", { text: "same", delivery_id: "text-delivery" }, { intent: "text-intent" });
  const image = client.request("send_images", { text: "same", delivery_id: "image-delivery", images: [] }, { intent: "image-intent" });
  fake.receive({ jsonrpc: "2.0", method: "event", params: { event: "user_message", session_id: "s", text: "same", mode: "send", attachments: [{ name: "x.png", mime_type: "image/png", size: 1 }] } });
  fake.receive({ jsonrpc: "2.0", method: "event", params: { event: "user_message", session_id: "s", text: "same", mode: "send", delivery_id: "text-delivery" } });
  fake.receive({ jsonrpc: "2.0", id: 2, result: { accepted: true } });
  fake.receive({ jsonrpc: "2.0", id: 3, result: { accepted: true } });
  await Promise.all([text, image]);
  expect(client.forSession("s").store.getOutline().filter((entry) => entry.kind === "user").map(({ id }) => id)).toEqual(["user:intent:image-intent", "user:intent:text-intent"]);
});

test("a late id-less image echo merges into its reconciled delivery row", async () => {
  const fake = fakeTransport();
  const client = connect(fake.transport);
  const hello = client.hello(["delivery_id", "user_message_event", "user_message_delivery_id"]);
  fake.receive({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.2", capabilities: { features: ["delivery_id", "user_message_event", "user_message_delivery_id", "send_images_delivery_id"] } } });
  await hello;
  const sending = client.request("send_images", { text: "late", delivery_id: "late-delivery", images: [] }, { intent: "late-intent" });
  fake.receive({ jsonrpc: "2.0", method: "event", params: { event: "user_message", session_id: "s", text: "late", mode: "send", delivery_id: "late-delivery" } });
  fake.receive({ jsonrpc: "2.0", id: 2, result: { accepted: true } });
  await sending;
  const echo = { jsonrpc: "2.0", method: "event", params: { event: "user_message", session_id: "s", text: "late", mode: "send", attachments: [{ name: "x.png", mime_type: "image/png", size: 1 }] } };
  fake.receive(echo);
  fake.receive(echo);
  const users = client.forSession("s").store.getOutline().filter((entry) => entry.kind === "user");
  expect(users.map(({ id }) => id)).toEqual(["user:intent:late-intent"]);
  expect(client.forSession("s").store.getItem("user:intent:late-intent")).toMatchObject({ event: { attachments: [{ filename: "x.png" }] } });
});

test("send_images delivery ids require both negotiated request features", async () => {
  for (const features of [["delivery_id"], ["send_images_delivery_id"]]) {
    const fake = fakeTransport();
    const client = connect(fake.transport);
    const ready = client.hello(features);
    expect(fake.sent[0]?.params.features).toEqual([...(features.includes("delivery_id") ? ["delivery_id", "send_images_delivery_id"] : features), "served_turn_end"]);
    fake.receive({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.2", capabilities: { features } } });
    await ready;
    const sending = client.request("send_images", { session_id: "s", text: "partial", images: [], delivery_id: "partial-id" });
    expect(fake.sent.at(-1)?.params).not.toHaveProperty("delivery_id");
    fake.receive({ jsonrpc: "2.0", id: 2, result: { accepted: true } });
    await sending;
  }
});

test("default hello does not request send_images delivery ids", async () => {
  const fake = fakeTransport();
  const client = connect(fake.transport);
  const ready = client.hello();
  expect(fake.sent[0]?.params.features).toEqual(["served_turn_end"]);
  fake.receive({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.2", capabilities: { features: [] } } });
  await ready;
});

test("send_images keeps delivery ids with the two request features", async () => {
  const fake = fakeTransport();
  const client = connect(fake.transport);
  const features = ["delivery_id", "send_images_delivery_id"];
  const ready = client.hello(features);
  fake.receive({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.2", capabilities: { features } } });
  await ready;
  const sending = client.request("send_images", { session_id: "s", text: "minimal", images: [], delivery_id: "minimal-id" });
  expect(fake.sent.at(-1)?.params).toMatchObject({ delivery_id: "minimal-id" });
  fake.receive({ jsonrpc: "2.0", id: 2, result: { accepted: true } });
  await sending;
});

test("delivery echo ids pair requests only when the echo carries an id", async () => {
  const fake = fakeTransport();
  const client = connect(fake.transport);
  const features = ["delivery_id", "user_message_event", "user_message_delivery_id"];
  const ready = client.hello(features);
  fake.receive({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.2", capabilities: { features } } });
  await ready;
  const first = client.request("send", { session_id: "s", text: "same", delivery_id: "first-id" }, { intent: "first" });
  const second = client.request("send", { session_id: "s", text: "same", delivery_id: "second-id" }, { intent: "second" });
  fake.receive({ jsonrpc: "2.0", method: "event", params: { event: "user_message", session_id: "s", text: "same", mode: "send", delivery_id: "second-id" } });
  fake.receive({ jsonrpc: "2.0", method: "event", params: { event: "user_message", session_id: "s", text: "same", mode: "send" } });
  fake.receive({ jsonrpc: "2.0", id: 2, result: { accepted: true } });
  fake.receive({ jsonrpc: "2.0", id: 3, result: { accepted: true } });
  await Promise.all([first, second]);
  expect(client.forSession("s").store.getOutline().filter((entry) => entry.kind === "user").map(({ id }) => id)).toEqual([
    "user:intent:second", "user:intent:first",
  ]);
});

const imageEcho = (sessionId: string, text: string, deliveryId?: string) => ({
  jsonrpc: "2.0", method: "event", params: {
    event: "user_message", session_id: sessionId, text, mode: "send",
    ...(deliveryId === undefined ? {} : { delivery_id: deliveryId }),
    attachments: [{ name: "x.png", mime_type: "image/png", size: 1 }],
  },
});

async function settleImage(fake: ReturnType<typeof fakeTransport>, client: ReturnType<typeof createClient>, id: number, sessionId: string, text: string, deliveryId: string) {
  const sending = client.request("send_images", { session_id: sessionId, text, images: [], delivery_id: deliveryId }, { intent: `${sessionId}-intent` });
  fake.receive(imageEcho(sessionId, text, deliveryId));
  fake.receive({ jsonrpc: "2.0", id, result: { accepted: true } });
  await sending;
}

test("pending image fallback is isolated between sessions with the same text", async () => {
  const fake = fakeTransport();
  const client = connect(fake.transport);
  const features = ["delivery_id", "user_message_event", "user_message_delivery_id"];
  const ready = client.hello(features);
  fake.receive({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.2", capabilities: { features } } });
  await ready;
  const a = client.request("send_images", { session_id: "a", text: "same", images: [] }, { intent: "a-intent" });
  const b = client.request("send_images", { session_id: "b", text: "same", images: [] }, { intent: "b-intent" });
  fake.receive(imageEcho("b", "same"));
  fake.receive(imageEcho("a", "same"));
  fake.receive({ jsonrpc: "2.0", id: 2, result: { accepted: true } });
  fake.receive({ jsonrpc: "2.0", id: 3, result: { accepted: true } });
  await Promise.all([a, b]);
  expect(client.forSession("a").store.getOutline().filter((entry) => entry.kind === "user").map(({ id }) => id)).toEqual(["user:intent:a-intent"]);
  expect(client.forSession("b").store.getOutline().filter((entry) => entry.kind === "user").map(({ id }) => id)).toEqual(["user:intent:b-intent"]);
});

test("late image fallback is isolated between sessions with the same text", async () => {
  const fake = fakeTransport();
  const client = connect(fake.transport);
  const features = ["delivery_id", "user_message_event", "user_message_delivery_id", "send_images_delivery_id"];
  const ready = client.hello(features);
  fake.receive({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.2", capabilities: { features } } });
  await ready;
  await settleImage(fake, client, 2, "a", "same", "a-id");
  await settleImage(fake, client, 3, "b", "same", "b-id");
  fake.receive(imageEcho("b", "same"));
  expect(client.forSession("b").store.getOutline().filter((entry) => entry.kind === "user").map(({ id }) => id)).toEqual(["user:intent:b-intent"]);
});

test("evicting a session prevents reuse of its settled image delivery", async () => {
  const fake = fakeTransport();
  const client = connect(fake.transport);
  const features = ["delivery_id", "user_message_event", "user_message_delivery_id", "send_images_delivery_id"];
  const ready = client.hello(features);
  fake.receive({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.2", capabilities: { features } } });
  await ready;
  await settleImage(fake, client, 2, "s", "reuse", "old-id");
  expect(client.evictSession("s")).toBe(true);
  fake.receive(imageEcho("s", "reuse"));
  expect(client.forSession("s").store.getOutline().filter((entry) => entry.kind === "user").map(({ id }) => id)).toHaveLength(1);
  expect(client.forSession("s").store.getOutline()[0]?.id).not.toContain("old-id");
});

test("closing with pending requests clears retained image delivery metadata", async () => {
  const fake = fakeTransport();
  const client = connect(fake.transport);
  const features = ["delivery_id", "user_message_event", "user_message_delivery_id", "send_images_delivery_id"];
  const ready = client.hello(features);
  fake.receive({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.2", capabilities: { features } } });
  await ready;
  const sending = client.request("send_images", { session_id: "s", text: "pending", images: [], delivery_id: "pending-id" }, { intent: "pending-intent" });
  fake.receive(imageEcho("s", "pending", "pending-id"));
  client.close();
  await expect(sending).rejects.toThrow("transport closed");
  fake.receive(imageEcho("s", "pending"));
  expect(client.forSession("s").store.getOutline().filter((entry) => entry.kind === "user").map(({ id }) => id)).toHaveLength(2);
});

test("text request pressure does not evict a live image fallback", async () => {
  const fake = fakeTransport();
  const client = createClient(fake.transport, undefined, undefined, { maxPendingRequests: 2 });
  const features = ["delivery_id", "user_message_event", "user_message_delivery_id", "send_images_delivery_id"];
  const ready = client.hello(features);
  fake.receive({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.2", capabilities: { features } } });
  await ready;
  await settleImage(fake, client, 2, "s", "image", "image-id");
  for (const [id, deliveryId] of [[3, "text-1"], [4, "text-2"]] as const) {
    const sending = client.request("send", { session_id: "s", text: deliveryId, delivery_id: deliveryId });
    fake.receive({ jsonrpc: "2.0", id, result: { accepted: true } });
    await sending;
  }
  fake.receive(imageEcho("s", "image"));
  expect(client.forSession("s").store.getOutline().filter((entry) => entry.kind === "user").map(({ id }) => id)).toEqual(["user:intent:s-intent"]);
});

test("settled image delivery fallback expires after five minutes", async () => {
  jest.useFakeTimers();
  try {
    const fake = fakeTransport();
    const client = connect(fake.transport);
    const features = ["delivery_id", "user_message_event", "user_message_delivery_id", "send_images_delivery_id"];
    const ready = client.hello(features);
    fake.receive({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.2", capabilities: { features } } });
    await ready;
    await settleImage(fake, client, 2, "s", "expires", "expires-id");
    jest.advanceTimersByTime(5 * 60 * 1000 + 1);
    fake.receive(imageEcho("s", "expires"));
    expect(client.forSession("s").store.getOutline().filter((entry) => entry.kind === "user")).toHaveLength(2);
  } finally {
    jest.useRealTimers();
  }
});

test("an echoed user_message gets the intent of the pending request with the same text, never another one", async () => {
  const fake = fakeTransport();
  const client = connect(fake.transport);
  const hello = client.hello();
  fake.receive({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.2" } });
  await hello;
  client.request("send", { text: "one" }, { intent: "a" }).catch(() => {});
  client.request("steer", { text: "two" }, { intent: "b" }).catch(() => {});
  const echo = (text: string) => fake.receive({ jsonrpc: "2.0", method: "event", params: { event: "user_message", text, mode: "send", data: {} } });
  echo("two");
  echo("three");
  echo("one");
  const ids = client.store.getOutline().filter((entry) => entry.kind === "user").map((entry) => entry.id);
  expect(ids[0]).toBe("user:intent:b");
  expect(ids[1]).not.toContain("intent");
  expect(ids[2]).toBe("user:intent:a");
  client.close();
});

test("the client remembers each session's last served turn id from live turn_start", async () => {
  const fake = fakeTransport();
  const client = connect(fake.transport);
  fake.receive({ jsonrpc: "2.0", method: "event", params: { event: "turn_start", session_id: "s", data: { turn: 1, turn_id: "5ec6b9bb4c8c44d29bfa315da83a4190" } } });
  fake.receive({ jsonrpc: "2.0", method: "event", params: { event: "turn_start", session_id: "s", data: { turn: 2, turn_id: "5ec6b9bb4c8c44d29bfa315da83a4190" } } });
  fake.receive({ jsonrpc: "2.0", method: "event", params: { event: "turn_start", session_id: "other", data: { turn: 1 } } });
  expect(client.servedTurn("s")).toBe("5ec6b9bb4c8c44d29bfa315da83a4190");
  expect(client.servedTurn("other")).toBeUndefined();
});

test("a turn_start during a quarantined replay still records the served turn id but is not dispatched", async () => {
  const fake = fakeTransport();
  const client = connect(fake.transport, (flush) => flush());
  const lease = await client.replay("s", async () => [{ type: "run_start" }, { type: "run_end" }], true);
  const before = lease.store.getState();
  const turnStart = (session: string, turnId: string) => fake.receive({ jsonrpc: "2.0", method: "event", params: { event: "turn_start", session_id: session, data: { turn: 1, turn_id: turnId } } });
  turnStart("s", "a1");
  expect(client.servedTurn("s")).toBe("a1");
  expect(lease.store.getState()).toBe(before);
  expect(client.replayRevision("s")).toBe(1);
  const other = client.forSession("other");
  const otherBefore = other.store.getState();
  turnStart("other", "b1");
  expect(client.servedTurn("other")).toBe("b1");
  expect(client.replayRevision("other")).toBe(0);
  expect(other.store.getState()).not.toBe(otherBefore);
  other.release();
  lease.release();
  client.close();
});
