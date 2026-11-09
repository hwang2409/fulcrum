import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import type { RunEvent } from "@fulcrum/core";
import { createClient, type Transport } from "../src/index.js";

// README "Listener contract": a throwing host listener never reaches the socket loop, the recovery loop, or another
// listener; its error goes to reportError exactly once.
function fakeTransport() {
  let onMessage!: (text: string) => void;
  let onClose = (_code?: number) => {};
  const transport: Transport = {
    send() {},
    onMessage(callback) { onMessage = callback; },
    onClose(callback) { onClose = callback; },
    close() {},
  };
  return {
    transport,
    receive: (message: unknown) => onMessage(typeof message === "string" ? message : JSON.stringify(message)),
    drop: () => onClose(1006),
  };
}
type Fake = ReturnType<typeof fakeTransport>;
type Client = ReturnType<typeof createClient>;
const sync = (job: () => void) => job();
const boom = new Error("listener boom");
const thrower = () => { throw boom; };
const grantsEvent = (change: string) => ({ jsonrpc: "2.0", method: "event", params: {
  event: "session_grants_changed", session_id: "s1",
  data: { change, changed: [], grants: { session_id: "s1", default: "ask", precedence: [], rules: { deny: [], ask: [], allow: [] }, session_grants: [] } },
} });
const turnStart = (session: string, turn: string) => ({ jsonrpc: "2.0", method: "event", params: { event: "turn_start", session_id: session, data: { turn_id: turn } } });
async function handshake(fake: Fake, client: Client) {
  const ready = client.hello();
  fake.receive({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.2", capabilities: { features: [] } } });
  await ready;
}
const settled = (promise: Promise<unknown>) => Promise.race([
  promise.then((value) => ({ value }), (error: unknown) => ({ error })),
  new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 100)),
]);

let reported: ReturnType<typeof spyOn>;
beforeEach(() => { reported = spyOn(globalThis, "reportError").mockImplementation(() => {}); });
afterEach(() => { reported.mockRestore(); });

type Row = {
  name: string;
  closeError?: () => unknown;
  // Subscribes `first` (throws) and `second` (records) through the public API.
  arm: (client: Client, second: (value?: unknown) => void) => void;
  fire: (fake: Fake) => void;
  // True when the callback closes the client, so the pending request rejects instead of resolving.
  closes?: boolean;
};
const rows: Row[] = [
  { name: "onSessionGrantsChanged listeners", arm: (client, second) => { client.onSessionGrantsChanged(thrower); client.onSessionGrantsChanged(second); }, fire: (fake) => fake.receive(grantsEvent("grant")) },
  { name: "session store listeners (live event dispatch)", arm: (client, second) => { const { store } = client.forSession("s1"); store.subscribe(thrower); store.subscribe(() => second()); }, fire: (fake) => fake.receive(turnStart("s1", "t1")) },
  { name: "client store listeners (adapter error dispatch)", arm: (client, second) => { client.store.subscribe(thrower); client.store.subscribe(() => second()); }, fire: (fake) => fake.receive("{not json") },
  { name: "onClose listeners", arm: (client, second) => { client.onClose(thrower); client.onClose(second); }, fire: (fake) => fake.drop(), closes: true },
  { name: "closeError callback", closeError: thrower, arm: (client, second) => { client.onClose(second); }, fire: (fake) => fake.drop(), closes: true },
];

test.each(rows)("a throwing host callback stays isolated: $name", async (row) => {
  const fake = fakeTransport();
  const client = createClient(fake.transport, sync, row.closeError);
  try {
    await handshake(fake, client);
    const pending = client.request("ping");
    pending.catch(() => {});
    const received: unknown[] = [];
    row.arm(client, (value) => received.push(value));

    expect(() => row.fire(fake)).not.toThrow();
    expect(received).toHaveLength(1);
    if (row.closes) {
      expect(await settled(pending)).toEqual({ error: new Error("transport closed") });
    } else {
      // The socket loop keeps going: the next frames settle the pending request and reach the listener again.
      fake.receive({ jsonrpc: "2.0", id: 2, result: "pong" });
      expect(await settled(pending)).toEqual({ value: "pong" });
      expect(() => row.fire(fake)).not.toThrow();
      expect(received).toHaveLength(2);
    }
    expect(reported.mock.calls).toEqual(row.closes ? [[boom]] : [[boom], [boom]]);
  } finally {
    // Before the fix, close() rethrew the callback's error here and hid the failed assertion above.
    try { client.close(); } catch {}
  }
});

test("a throwing store listener during a successful recovery resync does not restart the recovery loop", async () => {
  const fake = fakeTransport();
  const client = createClient(fake.transport, sync);
  try {
    let loads = 0;
    const lease = await client.replay("s1", async () => {
      loads++;
      return [{ type: "user_message", text: `history ${loads}`, mode: "send", delivery_id: `d${loads}` }] as RunEvent[];
    });
    const calls: number[] = [];
    lease.store.subscribe(thrower);
    lease.store.subscribe(() => calls.push(loads));

    expect(await settled(client.retrySession("s1"))).toEqual({ value: undefined });
    expect(loads).toBe(2);
    expect(calls).toEqual([2]);
    expect(reported.mock.calls).toEqual([[boom]]);
    // Recovery finished, so live events route to the store again instead of staying quarantined.
    fake.receive(turnStart("s1", "t1"));
    expect(lease.store.getState().turn).toBe("running");
  } finally {
    client.close();
  }
});

test("a throwing diagnostics listener during a failed recovery (resyncFailed) never replaces the load failure", async () => {
  jest.useFakeTimers();
  const fake = fakeTransport();
  const client = createClient(fake.transport, sync);
  try {
    let fail = false;
    const lease = await client.replay("s1", async () => {
      if (fail) throw new Error("history unavailable");
      return [] as RunEvent[];
    });
    fail = true;
    const seen: Array<string | undefined> = [];
    lease.store.subscribeDiagnostics(() => { if (lease.store.getDiagnostics().resyncError) throw boom; });
    lease.store.subscribeDiagnostics(() => seen.push(lease.store.getDiagnostics().resyncError));
    let reads = 0;
    // Desync the store with a reducer failure; the client's own recovery starts, and retrySession replaces it.
    lease.store.dispatch(new Proxy({ type: "retry" }, {
      get(target, key, receiver) {
        if (key === "type" && ++reads > 3) throw new Error("reducer failed");
        return Reflect.get(target, key, receiver);
      },
    }) as RunEvent);
    const retry = client.retrySession("s1");
    retry.catch(() => {});
    for (let step = 0; step < 12; step++) {
      jest.advanceTimersByTime(8_000);
      for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    }
    jest.useRealTimers();

    expect(await settled(retry)).toEqual({ error: new Error("history unavailable") });
    expect(seen).toEqual([undefined, "history unavailable"]);
    expect(reported.mock.calls).toEqual([[boom]]);
  } finally {
    jest.useRealTimers();
    client.close();
  }
});
