import { expect, jest, test } from "bun:test";
import { domShimAlarm, shimProperty } from "../../../test-support/dom-shim.js";
import type { RunEvent } from "@fulcrum/core";
import { createClient, fromZetaHistory, parseJoinStatus, type EventParams, type Transport } from "../src/index.js";

domShimAlarm(import.meta.path);

const assistantText = (client: ReturnType<typeof createClient>, session: string) => {
  const store = client.stores.get(session)!;
  const item = store.getOutline().map(({ id }) => store.getItem(id)).find((row) => row?.type === "message");
  return item?.type === "message" ? item.text ?? item.message.content.map((block) => block.type === "text" ? block.text : "").join("") : undefined;
};
const joinResult = (overrides: Record<string, unknown> = {}) => ({
  messages: [],
  next_before: null,
  history_validator: { end: 0, entry_id: null },
  replay: { stream_id: "stream-a", history_seq: 0 },
  status: { state: "running", pending_approvals: [], pending_approvals_truncated: false },
  ...overrides,
});
const harness = (options: { maxSessions?: number; features?: string[] } = {}) => {
  const features = options.features ?? ["session_replay_seq"];
  let receive!: (text: string) => void;
  let drop = (_code?: number) => {};
  const sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  const transport: Transport = {
    send(text) { sent.push(JSON.parse(text)); },
    onMessage(listener) { receive = listener; },
    onClose(listener) { drop = listener; },
    close() {},
  };
  const client = createClient(transport, (job) => job(), undefined, options);
  const reply = (id: number, result: unknown) => receive(JSON.stringify({ jsonrpc: "2.0", id, result }));
  const fail = (id: number | null, code: number, data?: unknown, message = "failed") => receive(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } }));
  const event = (params: EventParams) => receive(JSON.stringify({ jsonrpc: "2.0", method: "event", params }));
  const hello = client.hello(features);
  reply(sent[0]!.id, { protocol_version: "1.2", capabilities: { features } });
  const ready = hello.then(() => { sent.splice(0); });
  const joins = () => sent.filter(({ method }) => method === "session_history_and_subscribe");
  return { client, sent, reply, fail, event, ready, joins, close: (code?: number) => drop(code) };
};
type Harness = ReturnType<typeof harness>;
const waitFor = async (condition: () => boolean) => {
  for (let index = 0; index < 100 && !condition(); index++) await Bun.sleep(1);
  expect(condition()).toBe(true);
};
// Settles promise continuations without timers, for tests that fake them.
const flush = async () => { for (let index = 0; index < 50; index++) await Promise.resolve(); };
/** Opens `session` and answers its join with `overrides`. */
const joined = async (fake: Harness, overrides: Record<string, unknown> = {}, session = "session-a", options?: { signal?: AbortSignal }) => {
  const count = fake.joins().length;
  const open = fake.client.openSessionReplay(session, options);
  await waitFor(() => fake.joins().length === count + 1);
  fake.reply(fake.joins().at(-1)!.id, joinResult(overrides));
  return open;
};
const delta = (seq: number, text: string, stream = "stream-a", session = "session-a"): EventParams =>
  ({ event: "assistant_delta", session_id: session, stream_id: stream, seq, delta: text, kind: "assistant" });
const row = (id: string, text: string, role = "assistant") => ({ id, role, content: [{ type: "text", text }], tool_result: null });
const outlineText = (client: ReturnType<typeof createClient>, session = "session-a") => {
  const store = client.stores.get(session)!;
  return store.getOutline().flatMap(({ id }) => {
    const item = store.getItem(id);
    if (item?.type === "message") return [item.text ?? item.message.content.map((block) => block.type === "text" ? block.text : "").join("")];
    if (item?.type === "user") return [item.event.text];
    return [];
  });
};
const staleEvent = { code: "stale_event_sequence" };
const staleSnapshot = { code: "stale_history_snapshot" };
const history = (text: string) => fromZetaHistory([row(text, text)]);
const deferredLoad = () => {
  let resolve!: (events: RunEvent[]) => void;
  return { promise: new Promise<RunEvent[]>((done) => { resolve = done; }), resolve };
};
const send = (fake: Harness, session: string, id: string, method: "send" | "steer" = "send") =>
  void fake.client.request(method, { session_id: session, text: id, delivery_id: id }, { intent: id }).catch(() => {});
const echo = (fake: Harness, session: string, id: string, mode: "send" | "steer" = "send") =>
  fake.event({ event: "user_message", session_id: session, text: id, mode, delivery_id: id } as EventParams);
const userIds = (store: ReturnType<ReturnType<typeof createClient>["forSession"]>["store"]) =>
  store.getOutline().filter(({ kind }) => kind === "user").map(({ id }) => id);
// A disposed store is empty again; every store these tests check has at least one row while it lives.
const shown = (store: ReturnType<ReturnType<typeof createClient>["forSession"]>["store"]) => store.getOutline().length > 0;

// Fail-first on c04b167: this reaches the final assertion and receives "xx" because positioned duplicates are ordinary events.
test("positioned duplicate frames are not reduced twice", async () => {
  const fake = harness();
  await fake.ready;
  const open = "openSessionReplay" in fake.client
    ? (fake.client as ReturnType<typeof createClient> & { openSessionReplay(session: string): Promise<unknown> }).openSessionReplay("session-a")
    : undefined;
  if (open) {
    await waitFor(() => fake.sent.length === 1);
    fake.reply(fake.sent[0]!.id, joinResult());
    await open;
  }
  const event = (seq: number) => fake.event({ event: "assistant_delta", session_id: "session-a", stream_id: "stream-a", seq, delta: "x", kind: "assistant" });

  event(1);
  event(1);
  await Bun.sleep(1);

  expect(assistantText(fake.client, "session-a")).toBe("x");
  expect(fake.sent, "a duplicate is dropped, never treated as a gap").toHaveLength(1);
});

test("the shared status parser accepts ordinary omission but replay rejects it", async () => {
  expect(parseJoinStatus({ state: "idle", pending_approvals: [] })).toEqual({ state: "idle", pending_approvals: [] });
  const fake = harness();
  await fake.ready;
  const open = fake.client.openSessionReplay("session-a");
  await waitFor(() => fake.sent.length === 1);
  fake.reply(fake.sent[0]!.id, joinResult({ status: { state: "idle", pending_approvals: [] } }));
  const lease = await open;
  expect(lease.state.replay).toEqual({ phase: "failed", message: "could not join live updates", retryable: true });
});

test("join baseline is installed before the contiguous tail and no status call is made", async () => {
  const fake = harness();
  await fake.ready;
  const open = fake.client.openSessionReplay("session-a");
  await waitFor(() => fake.sent.length === 1);
  fake.reply(fake.sent[0]!.id, joinResult({ replay: { stream_id: "stream-a", history_seq: 4 } }));
  const lease = await open;
  fake.event({ event: "turn_end", session_id: "session-a", stream_id: "stream-a", seq: 5, data: {} });

  expect(lease.state.replay).toEqual({ phase: "joined", streamId: "stream-a" });
  expect(lease.lastSeq).toBe(5);
  expect(fake.sent.map(({ method }) => method)).toEqual(["session_history_and_subscribe"]);
  expect(lease.store.getState()).toMatchObject({ turn: "idle" });
});

test("a gap starts one fresh join and drops the gap frame", async () => {
  const fake = harness();
  await fake.ready;
  const open = fake.client.openSessionReplay("session-a");
  await waitFor(() => fake.sent.length === 1);
  fake.reply(fake.sent[0]!.id, joinResult());
  const lease = await open;
  fake.event({ event: "assistant_delta", session_id: "session-a", stream_id: "stream-a", seq: 1, delta: "one", kind: "assistant" });
  fake.event({ event: "assistant_delta", session_id: "session-a", stream_id: "stream-a", seq: 3, delta: "gap", kind: "assistant" });
  await waitFor(() => fake.sent.length === 2);

  expect(assistantText(fake.client, "session-a")).toBe("one");
  expect(fake.sent.filter(({ method }) => method === "session_history_and_subscribe")).toHaveLength(2);
  expect(lease.state.replay.phase).toBe("rejoining");

  // Real zeta starts every stream at history_seq 0, so the new stream's first frame applies after the old one's.
  fake.reply(fake.joins()[1]!.id, joinResult({ replay: { stream_id: "stream-b", history_seq: 0 }, messages: [row("one", "one")] }));
  await waitFor(() => lease.state.replay.phase === "joined");
  fake.event(delta(1, " two", "stream-b"));
  expect(lease.lastSeq).toBe(1);
  expect(outlineText(fake.client)).toEqual(["one", " two"]);
});

test("foreign streams and retired stream ends cannot mutate or rejoin", async () => {
  const fake = harness();
  await fake.ready;
  const open = fake.client.openSessionReplay("session-a");
  await waitFor(() => fake.sent.length === 1);
  fake.reply(fake.sent[0]!.id, joinResult());
  await open;
  fake.event({ event: "assistant_delta", session_id: "session-a", stream_id: "other", seq: 1, delta: "wrong", kind: "assistant" });
  fake.event({ event: "replay_stream_ended", session_id: "session-a", stream_id: "other", reason: "rejoined" });
  await Bun.sleep(1);

  expect(assistantText(fake.client, "session-a")).toBeUndefined();
  expect(fake.sent).toHaveLength(1);
});

test("every matching stream end reason starts one replacement", async () => {
  for (const reason of ["session_replaced", "evicted", "rejoined", "future_reason"]) {
    const fake = harness();
  await fake.ready;
    const open = fake.client.openSessionReplay("session-a");
    await waitFor(() => fake.sent.length === 1);
    fake.reply(fake.sent[0]!.id, joinResult());
    await open;
    fake.event({ event: "replay_stream_ended", session_id: "session-a", stream_id: "stream-a", reason });
    await waitFor(() => fake.sent.length === 2);
    expect(fake.sent.filter(({ method }) => method === "session_history_and_subscribe")).toHaveLength(2);
  }
});

test("cross-mode acquisition rejects without disturbing the joined owner", async () => {
  const fake = harness();
  await fake.ready;
  const open = fake.client.openSessionReplay("session-a");
  await waitFor(() => fake.sent.length === 1);
  fake.reply(fake.sent[0]!.id, joinResult());
  const lease = await open;

  await expect(fake.client.replay("session-a", async () => [])).rejects.toMatchObject({ kind: "session_owned_by_other_mode" });
  expect(lease.state.replay.phase).toBe("joined");
  expect(fake.sent).toHaveLength(1);
});

const approvalRequest = (request_id = "a") => ({
  id: `request-${request_id}`, role: "system", event: "approval_request", request_id,
  tool_call: { id: `tool-${request_id}`, name: "bash", arguments: { command: "pwd" } }, delegated: false,
});
const approvalEnd = (request_id = "a", reason?: string) => ({
  id: `end-${request_id}`, role: "system", event: "approval_end", request_id,
  data: { decision: "abort", ...(reason ? { reason } : {}) },
});
const approval = (client: ReturnType<typeof createClient>, requestId = "a") => client.stores.get("session-a")?.getItem(`approval:${requestId}`);

test("baseline and page requests reconcile with every page end", async () => {
  for (const page of [[approvalEnd()], [approvalRequest(), approvalEnd()], [approvalRequest()]]) {
    const fake = harness();
    await fake.ready;
    const open = fake.client.openSessionReplay("session-a");
    await waitFor(() => fake.sent.length === 1);
    fake.reply(fake.sent[0]!.id, joinResult({
      messages: page,
      status: { state: "tool", pending_approvals: [{ request_id: "a", tool_call: { id: "tool-a", name: "bash", arguments: { command: "pwd" } }, delegated: false, label: "shell" }], pending_approvals_truncated: false },
    }));
    await open;
    const row = approval(fake.client);
    expect(row?.type).toBe("approval");
    expect(row?.type === "approval" && Boolean(row.ended)).toBe(page.some((item) => item.event === "approval_end"));
  }
});

test("a continuation request and its retained newer end publish atomically", async () => {
  const fake = harness();
  await fake.ready;
  const open = fake.client.openSessionReplay("session-a");
  await waitFor(() => fake.sent.length === 1);
  fake.reply(fake.sent[0]!.id, joinResult({ messages: [approvalEnd()], next_before: 1, history_validator: { end: 2, entry_id: "end-a" } }));
  const lease = await open;
  await waitFor(() => fake.sent.some(({ method }) => method === "session_history"));
  const snapshots: Array<"absent" | "open" | "ended"> = [];
  const store = lease.store as ReturnType<typeof fake.client.forSession>["store"];
  const unsubscribe = store.subscribe(() => {
    const row = store.getItem("approval:a");
    snapshots.push(row?.type !== "approval" ? "absent" : row.ended ? "ended" : "open");
  });
  const history = fake.sent.find(({ method }) => method === "session_history")!;
  fake.reply(history.id, { messages: [approvalRequest()], next_before: null, history_validator: { end: 2, entry_id: "end-a" } });
  await waitFor(() => lease.state.history.phase === "complete");
  unsubscribe();

  expect(snapshots).not.toContain("open");
  expect(approval(fake.client)).toMatchObject({ type: "approval", ended: { type: "approval_end" } });
});

test("reasonless and restart cleanup ends both close the joined approval", async () => {
  for (const reason of [undefined, "server_restarted"]) {
    const fake = harness();
    await fake.ready;
    const open = fake.client.openSessionReplay("session-a");
    await waitFor(() => fake.sent.length === 1);
    fake.reply(fake.sent[0]!.id, joinResult({ messages: [approvalRequest(), approvalEnd("a", reason)] }));
    await open;
    expect(approval(fake.client)).toMatchObject({ type: "approval", ended: { type: "approval_end" } });
  }
});

// An approval's first end is final: a later tail end for the same request cannot rewrite its decision.
test("a later tail end cannot rewrite the decision of an approval the page or the tail already ended", async () => {
  const tailEnd = (seq: number, decision: string): EventParams =>
    ({ event: "approval_end", session_id: "session-a", stream_id: "stream-a", seq, request_id: "a", data: { decision } });
  for (const [name, messages, frames, decision] of [
    ["page ended", [approvalRequest(), approvalEnd()], [tailEnd(1, "allow")], "abort"],
    ["tail ended", [approvalRequest()], [tailEnd(1, "deny"), tailEnd(2, "allow")], "deny"],
  ] as const) {
    const fake = harness();
    await fake.ready;
    const lease = await joined(fake, { messages });
    for (const frame of frames) fake.event(frame);

    expect(approval(fake.client), name).toMatchObject({ type: "approval", ended: { type: "approval_end", decision } });
    expect(lease.lastSeq, name).toBe(frames.length);
  }
});

test("an unmatched sequenced approval end is quiet for both roles and never creates a card", async () => {
  // zeta #1218 gives observers the controller's pending rows, but until zeta #1227 a durable approval can be missing
  // from either role's join baseline after a zeta restart, so its later end has no request to close.
  for (const role of ["controller", "observer"] as const) {
    const fake = harness();
    await fake.ready;
    if (role === "observer") {
      const observerHello = fake.client.hello(["session_replay_seq"], "observer");
      await waitFor(() => fake.sent.length === 1);
      fake.reply(fake.sent[0]!.id, { protocol_version: "1.2", capabilities: { features: ["session_replay_seq"] } });
      await observerHello;
      fake.sent.splice(0);
    }
    const warnings: unknown[] = [];
    const restoreWarn = shimProperty(console, "warn", { configurable: true, writable: true, value: (...args: unknown[]) => { warnings.push(args); } });
    try {
      const open = fake.client.openSessionReplay("session-a");
      await waitFor(() => fake.sent.length === 1);
      fake.reply(fake.sent[0]!.id, joinResult({ status: { state: "tool", pending_approvals: [], pending_approvals_truncated: false } }));
      const lease = await open;
      fake.event({ event: "approval_end", session_id: "session-a", stream_id: "stream-a", seq: 1, request_id: "outside-page", data: {} });

      expect(lease.state.approvals.incomplete, role).toBeNull();
      expect(lease.state.replay.phase, role).toBe("joined");
      expect(lease.lastSeq, role).toBe(1);
      expect(fake.client.stores.get("session-a")!.getOutline().some(({ kind }) => kind === "approval"), role).toBe(false);
      expect(warnings, role).toEqual([]);
    } finally {
      restoreWarn();
    }
  }
});

test("defensive truncation retains supplied approvals and marks incompleteness", async () => {
  const fake = harness();
  await fake.ready;
  const open = fake.client.openSessionReplay("session-a");
  await waitFor(() => fake.sent.length === 1);
  fake.reply(fake.sent[0]!.id, joinResult({ status: {
    state: "tool",
    pending_approvals: [{ request_id: "a", tool_call: { id: "tool-a", name: "bash", arguments: {} }, delegated: false }],
    pending_approvals_truncated: true,
  } }));
  const lease = await open;

  expect(lease.state.approvals.incomplete).toBe("server_truncated");
  expect(approval(fake.client)).toMatchObject({ type: "approval" });
});

test("missing positions rejoin once and never dispatch", async () => {
  const fake = harness();
  await fake.ready;
  const open = fake.client.openSessionReplay("session-a");
  await waitFor(() => fake.sent.length === 1);
  fake.reply(fake.sent[0]!.id, joinResult());
  await open;
  fake.event({ event: "assistant_delta", session_id: "session-a", stream_id: "stream-a", delta: "bad", kind: "assistant" });
  await waitFor(() => fake.sent.length === 2);

  expect(assistantText(fake.client, "session-a")).toBeUndefined();
  expect(fake.sent.filter(({ method }) => method === "session_history_and_subscribe")).toHaveLength(2);
});

test("same-session supersession ignores a late old join and keeps one owner", async () => {
  const fake = harness();
  await fake.ready;
  const first = fake.client.openSessionReplay("session-a");
  await waitFor(() => fake.sent.length === 1);
  const second = fake.client.openSessionReplay("session-a");
  await waitFor(() => fake.sent.length === 2);
  fake.reply(fake.sent[0]!.id, joinResult({ messages: [{ id: "old", role: "assistant", content: [{ type: "text", text: "old" }], tool_result: null }] }));
  fake.reply(fake.sent[1]!.id, joinResult({ messages: [{ id: "new", role: "assistant", content: [{ type: "text", text: "new" }], tool_result: null }] }));
  await Promise.all([first, second]);

  expect(assistantText(fake.client, "session-a")).toBe("new");
});

test("suspending for another session prevents the old owner from rejoining", async () => {
  const fake = harness();
  await fake.ready;
  const first = fake.client.openSessionReplay("session-a");
  await waitFor(() => fake.sent.length === 1);
  fake.reply(fake.sent[0]!.id, joinResult());
  const leaseA = await first;
  const openB = fake.client.openSessionReplay("session-b");
  await waitFor(() => fake.sent.length === 2);
  fake.event({ event: "replay_stream_ended", session_id: "session-a", stream_id: "stream-a", reason: "rejoined" });

  expect(leaseA.state.replay.phase).toBe("suspended");
  expect(fake.sent).toHaveLength(2);
  fake.reply(fake.sent[1]!.id, joinResult({ replay: { stream_id: "stream-b", history_seq: 0 } }));
  await openB;
});

test("selecting another session aborts the first session's pending join; its open settles and a late reply changes nothing", async () => {
  const fake = harness();
  await fake.ready;
  let settled = false;
  const openA = fake.client.openSessionReplay("session-a").finally(() => { settled = true; });
  await waitFor(() => fake.joins().length === 1);
  const joinA = fake.joins()[0]!;
  const leaseB = await joined(fake, { replay: { stream_id: "stream-b", history_seq: 0 } }, "session-b");
  await waitFor(() => settled);
  const leaseA = await openA;
  let notified = 0;
  leaseA.subscribeReplay(() => notified++);
  fake.reply(joinA.id, joinResult({ messages: [row("late", "late")] }));
  await Bun.sleep(1);

  expect(leaseA.state.replay).toEqual({ phase: "suspended" });
  expect(notified).toBe(0);
  expect(outlineText(fake.client)).toEqual([]);
  expect(leaseB.state.replay).toEqual({ phase: "joined", streamId: "stream-b" });
  expect(leaseB.lastSeq).toBe(0);
  expect(fake.joins()).toHaveLength(2);
});

test("navigation abort synchronously suspends and blocks a late join", async () => {
  const fake = harness();
  await fake.ready;
  const navigation = new AbortController();
  const open = fake.client.openSessionReplay("session-a", { signal: navigation.signal });
  await waitFor(() => fake.sent.length === 1);
  navigation.abort();
  const lease = await open;
  fake.reply(fake.sent[0]!.id, joinResult({ messages: [{ id: "late", role: "assistant", content: [{ type: "text", text: "late" }], tool_result: null }] }));
  await Bun.sleep(1);

  expect(lease.state.replay.phase).toBe("suspended");
  expect(assistantText(fake.client, "session-a")).toBeUndefined();
});

test("an already-aborted navigation never sends a join", async () => {
  const fake = harness();
  await fake.ready;
  const navigation = new AbortController();
  navigation.abort();

  await expect(fake.client.openSessionReplay("session-a", { signal: navigation.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(fake.sent).toHaveLength(0);
});

// Fail-first on c172a6a: the end arrived before the join's continuation ran, met no stream id, and was lost.
test("a stream end right after the join reply waits for that join and then rejoins once", async () => {
  const fake = harness();
  await fake.ready;
  const open = fake.client.openSessionReplay("session-a");
  await waitFor(() => fake.joins().length === 1);
  fake.reply(fake.joins()[0]!.id, joinResult());
  fake.event({ event: "replay_stream_ended", session_id: "session-a", stream_id: "stream-a", reason: "evicted" });
  await open;
  await Bun.sleep(1);

  expect(fake.joins()).toHaveLength(2);
});

test("a frame that arrives while the join reply is settling applies once the join commits", async () => {
  const fake = harness();
  await fake.ready;
  const open = fake.client.openSessionReplay("session-a");
  await waitFor(() => fake.joins().length === 1);
  fake.reply(fake.joins()[0]!.id, joinResult());
  fake.event(delta(1, "held"));
  const lease = await open;
  await Bun.sleep(1);

  expect(assistantText(fake.client, "session-a")).toBe("held");
  expect(lease.lastSeq).toBe(1);
  expect(fake.joins()).toHaveLength(1);
});

// Fail-first on 7cd2f5c: the owner looked for an error code the adapter never emits, so it applied the error row.
test("a positioned frame whose payload cannot be read is never applied and starts one rejoin", async () => {
  const fake = harness();
  await fake.ready;
  const lease = await joined(fake);
  fake.event({ ...delta(1, "x"), delta: 5 } as unknown as EventParams);
  await Bun.sleep(1);

  expect(fake.joins()).toHaveLength(2);
  expect(lease.state.replay.phase).toBe("rejoining");
  expect(lease.store.getOutline().some(({ id }) => lease.store.getItem(id)?.type === "error")).toBe(false);
  expect(lease.lastSeq).toBe(0);
});

test("unreadable payloads spend the shared rejoin budget: three rejoins, then the stream stops", async () => {
  const fake = harness();
  await fake.ready;
  const lease = await joined(fake);
  const unreadable = (stream: string): EventParams => ({ ...delta(1, "x", stream), delta: 5 } as unknown as EventParams);
  let stream = "stream-a";
  for (const next of ["stream-b", "stream-c", "stream-d"]) {
    fake.event(unreadable(stream));
    await waitFor(() => lease.state.replay.phase === "rejoining");
    fake.reply(fake.joins().at(-1)!.id, joinResult({ replay: { stream_id: next, history_seq: 0 } }));
    await waitFor(() => lease.state.replay.phase === "joined");
    stream = next;
  }
  fake.event(unreadable("stream-d"));
  await Bun.sleep(1);

  expect(fake.joins()).toHaveLength(4);
  expect(lease.state.replay).toEqual({ phase: "failed", message: "could not join live updates", retryable: true });
  fake.event(delta(1, "after", "stream-d"));
  await Bun.sleep(1);
  expect(fake.joins(), "the retired stream starts no join").toHaveLength(4);
  expect(assistantText(fake.client, "session-a")).toBeUndefined();
});

test("live text deltas advance lastSeq without notifying replay listeners", async () => {
  const fake = harness();
  await fake.ready;
  const lease = await joined(fake);
  let notified = 0;
  lease.subscribeReplay(() => notified++);
  for (let seq = 1; seq <= 200; seq++) fake.event(delta(seq, "x"));

  expect(notified, "replay state changes only with phase, history, or approvals").toBe(0);
  expect(assistantText(fake.client, "session-a")).toBe("x".repeat(200));
  expect(lease.lastSeq).toBe(200);
  fake.event(delta(202, "gap"));
  await Bun.sleep(1);
  expect(notified, "a rejoin is a phase change").toBeGreaterThan(0);
});

test("a gap and a matching stream end in one turn start one join", async () => {
  const fake = harness();
  await fake.ready;
  await joined(fake);
  fake.event(delta(2, "gap"));
  fake.event({ event: "replay_stream_ended", session_id: "session-a", stream_id: "stream-a", reason: "evicted" });
  await Bun.sleep(1);

  expect(fake.joins()).toHaveLength(2);
});

// Design: this proof plants "set lastSeq before dispatch": the failed frame must never count as applied.
test("a store failure rejoins and never counts its frame as applied", async () => {
  const fake = harness();
  await fake.ready;
  const lease = await joined(fake);
  const restore = shimProperty(lease.store, "dispatch", { configurable: true, writable: true, value: () => { throw new Error("store failed"); } });
  const errors: unknown[] = [];
  const restoreReport = shimProperty(globalThis, "reportError", { configurable: true, writable: true, value: (error: unknown) => { errors.push(error); } });
  try {
    fake.event(delta(1, "lost"));
    // The failed frame is never counted as applied on its stream.
    expect(lease.lastSeq).toBe(0);
  } finally {
    restore();
    restoreReport();
  }
  await waitFor(() => fake.joins().length === 2);
  fake.reply(fake.joins()[1]!.id, joinResult({ replay: { stream_id: "stream-b", history_seq: 0 }, messages: [row("one", "one")] }));
  await waitFor(() => lease.state.replay.phase === "joined");
  fake.event(delta(1, " more", "stream-b"));

  expect(errors).toHaveLength(1);
  expect(lease.state.replay).toEqual({ phase: "joined", streamId: "stream-b" });
  expect(lease.lastSeq).toBe(1);
});

test("an older page that resolves as the owner rejoins is not prepended", async () => {
  const fake = harness();
  await fake.ready;
  await joined(fake, { messages: [row("new", "new")], next_before: 1, history_validator: { end: 2, entry_id: "new" } });
  await waitFor(() => fake.sent.some(({ method }) => method === "session_history"));
  const page = fake.sent.find(({ method }) => method === "session_history")!;
  fake.reply(page.id, { messages: [row("old", "old")], next_before: null, history_validator: { end: 2, entry_id: "new" } });
  fake.event(delta(2, "gap"));
  await Bun.sleep(1);

  expect(outlineText(fake.client)).toEqual(["new"]);
  expect(fake.joins()).toHaveLength(2);
});

test("a continuation page that never answers times out at 15 s, keeps the stream, and never rejoins", async () => {
  jest.useFakeTimers();
  try {
    const fake = harness();
    await fake.ready;
    const open = fake.client.openSessionReplay("session-a");
    await flush();
    fake.reply(fake.joins()[0]!.id, joinResult({ messages: [row("new", "new")], next_before: 1 }));
    const lease = await open;
    await flush();
    const histories = new Set<unknown>();
    lease.subscribeReplay(() => histories.add(lease.state.history));
    jest.advanceTimersByTime(14_999);
    await flush();
    expect(lease.state.history.phase).toBe("loading");
    jest.advanceTimersByTime(1);
    await flush();
    fake.event(delta(1, "live"));

    expect([...histories], "one history notice").toEqual([{ phase: "incomplete", messages: 1, reason: "timeout" }]);
    expect(lease.state.replay).toEqual({ phase: "joined", streamId: "stream-a" });
    expect(lease.lastSeq).toBe(1);
    expect(fake.joins()).toHaveLength(1);
  } finally {
    jest.useRealTimers();
  }
});

test("stale join retries stop after six attempts, and a manual retry starts again at attempt one", async () => {
  jest.useFakeTimers();
  try {
    const fake = harness();
    await fake.ready;
    const open = fake.client.openSessionReplay("session-a");
    for (const wait of [0, 500, 1_000, 2_000, 4_000, 8_000]) {
      jest.advanceTimersByTime(wait);
      await flush();
      fake.fail(fake.joins().at(-1)!.id, -32009, staleEvent);
      await flush();
    }
    const lease = await open;
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(fake.joins()).toHaveLength(6);
    expect(lease.state.replay).toEqual({ phase: "failed", message: "could not join live updates", retryable: true });

    lease.retry();
    await flush();
    expect(fake.joins()).toHaveLength(7);
    expect(lease.state.replay).toEqual({ phase: "rejoining", attempt: 1 });
  } finally {
    jest.useRealTimers();
  }
});

test("only an exact stale_event_sequence join error retries", async () => {
  for (const data of [staleSnapshot, undefined]) {
    const fake = harness();
    await fake.ready;
    const open = fake.client.openSessionReplay("session-a");
    await waitFor(() => fake.joins().length === 1);
    fake.fail(fake.joins()[0]!.id, -32009, data);
    const lease = await open;
    await Bun.sleep(1);

    expect(fake.joins()).toHaveLength(1);
    expect(lease.state.replay.phase).toBe("failed");
  }
});

test("four stale continuations make three replacement joins, then stop the stream and the history walk", async () => {
  const fake = harness();
  await fake.ready;
  const lease = await joined(fake, { messages: [row("new", "new")], next_before: 1 });
  for (let cycle = 0; cycle < 4; cycle++) {
    await waitFor(() => fake.sent.filter(({ method }) => method === "session_history").length === cycle + 1);
    const pages = fake.sent.filter(({ method }) => method === "session_history");
    fake.fail(pages.at(-1)!.id, -32009, staleSnapshot);
    if (cycle === 3) break;
    await waitFor(() => fake.joins().length === cycle + 2);
    fake.reply(fake.joins().at(-1)!.id, joinResult({ messages: [row("new", "new")], next_before: 1 }));
  }
  await waitFor(() => lease.state.replay.phase === "failed");
  fake.event(delta(1, " live"));
  fake.event({ event: "replay_stream_ended", session_id: "session-a", stream_id: "stream-a", reason: "rejoined" });
  await Bun.sleep(1);

  expect(fake.joins(), "the retired stream's end starts no join").toHaveLength(4);
  expect(lease.state).toMatchObject({ replay: { phase: "failed" }, history: { phase: "incomplete", reason: "stale_limit" } });
  expect(outlineText(fake.client), "a retired stream dispatches nothing").toEqual(["new"]);
});

test("retrySession on a sequenced session starts one fresh join on the same owner", async () => {
  const fake = harness();
  await fake.ready;
  const lease = await joined(fake, { messages: [row("one", "one")] });
  const retried = fake.client.retrySession("session-a");
  await waitFor(() => fake.joins().length === 2);
  expect(outlineText(fake.client), "the committed transcript stays readable").toEqual(["one"]);
  fake.reply(fake.joins()[1]!.id, joinResult({ messages: [row("one", "one"), row("two", "two")], replay: { stream_id: "stream-b", history_seq: 0 } }));
  await retried;
  await waitFor(() => lease.state.replay.phase === "joined");

  expect(lease.state.replay).toEqual({ phase: "joined", streamId: "stream-b" });
  expect(lease.lastSeq).toBe(0);
  expect(lease.store).toBe(fake.client.stores.get("session-a")!);
  expect(outlineText(fake.client)).toEqual(["one", "two"]);
});

test("a rejoin keeps unconfirmed optimistic rows and drops the ones history confirms", async () => {
  const fake = harness();
  await fake.ready;
  const lease = await joined(fake);
  lease.store.dispatch({ type: "user_message", text: "confirmed", mode: "send", intent: "send-1", delivery_id: "d1" });
  lease.store.dispatch({ type: "user_message", text: "pending", mode: "send", intent: "send-2", delivery_id: "d2" });
  fake.event(delta(2, "gap"));
  await waitFor(() => fake.joins().length === 2);
  fake.reply(fake.joins()[1]!.id, joinResult({
    messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "confirmed" }], tool_result: null, delivery_id: "d1" }],
    replay: { stream_id: "stream-b", history_seq: 0 },
  }));
  await waitFor(() => lease.state.replay.phase === "joined");

  expect(outlineText(fake.client)).toEqual(["confirmed", "pending"]);
});

const servedEnd = (turn: string, reason: string) => ({ id: `e-${turn}`, role: "system", event: "served_turn_end", data: { turn_id: turn, reason } });
const idle = { state: "idle", pending_approvals: [], pending_approvals_truncated: false };

// Fail-first on c172a6a: the joined idle snapshot ended with a bare run_end, so endOutcome was undefined.
test("a joined idle snapshot keeps the newest served turn's stopped or failed outcome without a status call", async () => {
  for (const [reason, outcome] of [["user_stop", "cancelled"], ["error", "failed"]] as const) {
    const fake = harness();
    await fake.ready;
    await joined(fake, { messages: [row("a1", "work"), servedEnd("t1", reason)], status: idle });

    expect(fake.client.stores.get("session-a")!.getState(), reason).toMatchObject({ turn: "idle", endOutcome: outcome });
    expect(fake.sent.map(({ method }) => method)).toEqual(["session_history_and_subscribe"]);
  }
});

// Fail-first on c172a6a: the registry took sequenced frames before the client recorded turn_start's turn id.
test("servedTurn() follows sequenced turns, and a rejoin names no outcome for an older turn's end", async () => {
  const fake = harness();
  await fake.ready;
  const lease = await joined(fake);
  fake.event({ event: "turn_start", session_id: "session-a", stream_id: "stream-a", seq: 1, data: { turn_id: "t2" } });
  expect(fake.client.servedTurn("session-a")).toBe("t2");
  fake.event(delta(3, "gap"));
  await waitFor(() => fake.joins().length === 2);
  fake.reply(fake.joins()[1]!.id, joinResult({ messages: [servedEnd("t1", "user_stop")], status: idle, replay: { stream_id: "stream-b", history_seq: 0 } }));
  await waitFor(() => lease.state.replay.phase === "joined");

  expect(lease.store.getState()).toMatchObject({ turn: "idle", endOutcome: undefined });
});

// Fail-first on c172a6a: the owned store was the oldest unheld store, eviction refused it, and trimming stopped.
test("event-created stores stay within maxSessions while a sequenced owner holds the oldest store", async () => {
  const fake = harness({ maxSessions: 2 });
  await fake.ready;
  await joined(fake);
  for (const session of ["b", "c", "d", "e"]) fake.event({ event: "assistant_delta", session_id: session, delta: "x", kind: "assistant" });

  expect(fake.client.stores.has("session-a")).toBe(true);
  expect([...fake.client.stores.keys()].filter((session) => session !== "session-a")).toEqual(["d", "e"]);
});

// Fail-first on c172a6a: the aborted reopen had already retired the owner's stream, so the next frame was dropped.
test("an already-aborted reopen rejects and leaves the joined owner and its stream untouched", async () => {
  const fake = harness();
  await fake.ready;
  const lease = await joined(fake);
  const navigation = new AbortController();
  navigation.abort();
  await expect(fake.client.openSessionReplay("session-a", { signal: navigation.signal })).rejects.toMatchObject({ name: "AbortError" });
  fake.event(delta(1, "live"));

  expect(lease.state.replay).toEqual({ phase: "joined", streamId: "stream-a" });
  expect(lease.lastSeq).toBe(1);
  expect(assistantText(fake.client, "session-a")).toBe("live");
  expect(fake.joins()).toHaveLength(1);
});

test("retryHistory supersedes the walk with one fresh join and a fresh page walk; a superseded page cannot land", async () => {
  const fake = harness();
  await fake.ready;
  const pages = () => fake.sent.filter(({ method }) => method === "session_history");
  const page = { next_before: 1, history_validator: { end: 2, entry_id: "new" } };
  const lease = await joined(fake, { messages: [row("new", "new")], ...page });
  await waitFor(() => pages().length === 1);
  fake.fail(pages()[0]!.id, -32603);
  await waitFor(() => lease.state.history.phase === "incomplete");
  expect(lease.state.history).toEqual({ phase: "incomplete", messages: 1, reason: "rpc_error" });

  lease.retryHistory();
  expect(lease.state.history).toEqual({ phase: "loading", messages: 0 });
  await waitFor(() => fake.joins().length === 2);
  fake.reply(fake.joins()[1]!.id, joinResult({ messages: [row("new", "new")], ...page, replay: { stream_id: "stream-b", history_seq: 0 } }));
  await waitFor(() => pages().length === 2);
  lease.retryHistory();
  await waitFor(() => fake.joins().length === 3);
  fake.reply(pages()[1]!.id, { messages: [row("stale", "stale")], next_before: null, history_validator: page.history_validator });
  fake.reply(fake.joins()[2]!.id, joinResult({ messages: [row("new", "new")], ...page, replay: { stream_id: "stream-c", history_seq: 0 } }));
  await waitFor(() => pages().length === 3);
  fake.reply(pages()[2]!.id, { messages: [row("old", "old")], next_before: null, history_validator: page.history_validator });
  await waitFor(() => lease.state.history.phase === "complete");

  expect(lease.state.history).toEqual({ phase: "complete", messages: 2 });
  expect(lease.state.replay).toEqual({ phase: "joined", streamId: "stream-c" });
  expect(lease.lastSeq).toBe(0);
  expect(outlineText(fake.client)).toEqual(["old", "new"]);
  expect(fake.joins()).toHaveLength(3);
});

// #154 and design 4.3. Fail-first on c172a6a: the superseded load's failure cleared the new replay's quarantine.
test("a same-session legacy retry keeps the displayed store until its own load commits; late old work changes nothing", async () => {
  const fake = harness();
  await fake.ready;
  const events = (text: string) => fromZetaHistory([row(text, text)]);
  const deferred = () => {
    let resolve!: (events: RunEvent[]) => void;
    return { promise: new Promise<RunEvent[]>((done) => { resolve = done; }), resolve };
  };
  const lateRecovery = deferred();
  let loads = 0;
  const displayed = await fake.client.replay("session-a", () => ++loads === 1 ? Promise.resolve(events("one")) : lateRecovery.promise, true);
  expect(fake.client.finishReplay("session-a", 0)).toBe(true);
  const recovering = fake.client.retrySession("session-a");
  const first = deferred();
  const second = deferred();
  const superseded = fake.client.replay("session-a", () => first.promise, true);
  const retried = fake.client.replay("session-a", () => second.promise, true);
  expect(fake.client.stores.get("session-a")).toBe(displayed.store);

  first.resolve(events("first"));
  lateRecovery.resolve(events("late"));
  await expect(superseded).rejects.toMatchObject({ name: "AbortError" });
  await recovering;
  fake.event({ event: "assistant_delta", session_id: "session-a", delta: "x", kind: "assistant" });
  expect(fake.client.replayRevision("session-a"), "the newest replay still holds its quarantine").toBe(1);
  expect(outlineText(fake.client), "late recovery and the late live frame left the displayed store alone").toEqual(["one"]);

  second.resolve(events("second"));
  const lease = await retried;
  displayed.release();
  expect(fake.client.stores.get("session-a")).toBe(lease.store);
  expect(outlineText(fake.client)).toEqual(["second"]);
  expect(fake.client.finishReplay("session-a", 1)).toBe(true);
  lease.release();
});

// The store cache has one owner (client storeStep). Each row checks delivery identity, disposal, and the cached store.
// Fail-first on 832abea: the "send and steer during" row; the install evicted identities a send made during the load.
test.each([
  {
    name: "first open: identities tracked before the replay go; the unheld cached store is disposed at install",
    async run(fake: Harness) {
      fake.event({ event: "assistant_delta", session_id: "s", delta: "cached", kind: "assistant" });
      const cached = fake.client.stores.get("s")!;
      send(fake, "s", "before");
      const lease = await fake.client.replay("s", async () => history("one"));
      echo(fake, "s", "before");
      return { users: userIds(lease.store), shown: { old: shown(cached), current: shown(lease.store) }, cached: fake.client.stores.get("s") === lease.store };
    },
    expected: { users: ["user:delivery:before"], shown: { old: false, current: true }, cached: true },
  },
  {
    name: "same-session supersede: a send during the new load keeps its intent; the held old store waits for its release",
    async run(fake: Harness) {
      const first = await fake.client.replay("s", async () => history("one"));
      const load = deferredLoad();
      const second = fake.client.replay("s", () => load.promise);
      send(fake, "s", "during");
      load.resolve(history("two"));
      const lease = await second;
      echo(fake, "s", "during");
      const whileHeld = shown(first.store);
      first.release();
      return { users: userIds(lease.store), shown: { whileHeld, afterRelease: shown(first.store), current: shown(lease.store) }, cached: fake.client.stores.get("s") === lease.store };
    },
    expected: { users: ["user:intent:during"], shown: { whileHeld: true, afterRelease: false, current: true }, cached: true },
  },
  {
    name: "switch to another session: the first session's store and identities are untouched",
    async run(fake: Harness) {
      const a = await fake.client.replay("a", async () => history("a"));
      send(fake, "a", "for-a");
      const b = await fake.client.replay("b", async () => history("b"));
      echo(fake, "a", "for-a");
      return { users: userIds(a.store), shown: { a: shown(a.store), b: shown(b.store) }, cached: fake.client.stores.get("a") === a.store && fake.client.stores.get("b") === b.store };
    },
    expected: { users: ["user:intent:for-a"], shown: { a: true, b: true }, cached: true },
  },
  {
    name: "send and steer during an in-flight first load keep their intents",
    async run(fake: Harness) {
      const load = deferredLoad();
      const open = fake.client.replay("s", () => load.promise);
      send(fake, "s", "sent");
      send(fake, "s", "steered", "steer");
      load.resolve(history("one"));
      const lease = await open;
      echo(fake, "s", "sent");
      echo(fake, "s", "steered", "steer");
      return { users: userIds(lease.store), shown: { current: shown(lease.store) }, cached: fake.client.stores.get("s") === lease.store };
    },
    expected: { users: ["user:intent:sent", "user:intent:steered"], shown: { current: true }, cached: true },
  },
  {
    name: "cap eviction: the oldest unheld store and its identities go at once; a held store and its identities stay",
    options: { maxSessions: 2 },
    async run(fake: Harness) {
      const held = fake.client.forSession("held");
      for (const session of ["held", "x"]) fake.event({ event: "assistant_delta", session_id: session, delta: session, kind: "assistant" });
      const x = fake.client.stores.get("x")!;
      send(fake, "held", "h");
      send(fake, "x", "x-send");
      for (const session of ["y", "z"]) fake.event({ event: "assistant_delta", session_id: session, delta: session, kind: "assistant" });
      const evicted = !fake.client.stores.has("x");
      echo(fake, "held", "h");
      echo(fake, "x", "x-send");
      return { users: [...userIds(held.store), ...userIds(fake.client.stores.get("x")!)], shown: { held: shown(held.store), x: shown(x) }, cached: evicted && fake.client.stores.get("held") === held.store };
    },
    expected: { users: ["user:intent:h", "user:delivery:x-send"], shown: { held: true, x: false }, cached: true },
  },
  {
    name: "a store a view still holds is never disposed by a replay install, only by that view's release",
    async run(fake: Harness) {
      const viewer = fake.client.forSession("s");
      fake.event({ event: "assistant_delta", session_id: "s", delta: "shown", kind: "assistant" });
      const load = deferredLoad();
      const open = fake.client.replay("s", () => load.promise);
      send(fake, "s", "during");
      load.resolve(history("one"));
      const lease = await open;
      echo(fake, "s", "during");
      const whileHeld = shown(viewer.store);
      viewer.release();
      return { users: userIds(lease.store), shown: { whileHeld, afterRelease: shown(viewer.store), current: shown(lease.store) }, cached: fake.client.stores.get("s") === lease.store };
    },
    expected: { users: ["user:intent:during"], shown: { whileHeld: true, afterRelease: false, current: true }, cached: true },
  },
  {
    name: "abort mid-load: nothing is installed or disposed; the shown store keeps a send made during the load",
    async run(fake: Harness) {
      const displayed = await fake.client.replay("s", async () => history("one"));
      const aborted = fake.client.replay("s", async () => {
        send(fake, "s", "during");
        throw Object.assign(new Error("request aborted"), { name: "AbortError" });
      });
      await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
      echo(fake, "s", "during");
      return { users: userIds(displayed.store), shown: { displayed: shown(displayed.store) }, cached: fake.client.stores.get("s") === displayed.store };
    },
    expected: { users: ["user:intent:during"], shown: { displayed: true }, cached: true },
  },
])("store lifecycle: $name", async ({ run, expected, options }) => {
  const fake = harness({ ...options, features: ["delivery_id", "user_message_event", "user_message_delivery_id"] });
  await fake.ready;
  expect(await run(fake)).toEqual(expected);
});

// Design section 6: the client side of every named fake-zeta case.
test.each([
  ["accepted-new-session", "session_replaced"], ["accepted-resume-same", "session_replaced"],
  ["active-reset-unstable-frontier", "session_replaced"], ["scope-ledger-evicted", "evicted"],
  ["old-row-lookup-evicted", "evicted"], ["deferred-row-aged-out", "evicted"], ["unknown-route-evicted", "evicted"],
])("matrix %s: the matching %s end starts exactly one join and the transcript stays readable", async (_, reason) => {
  const fake = harness();
  await fake.ready;
  const lease = await joined(fake, { messages: [row("one", "one")] });
  fake.event({ event: "replay_stream_ended", session_id: "session-a", stream_id: "stream-a", reason });
  await waitFor(() => fake.joins().length === 2);
  expect(outlineText(fake.client)).toEqual(["one"]);
  fake.reply(fake.joins()[1]!.id, joinResult({ messages: [row("one", "one")], replay: { stream_id: "stream-b", history_seq: 0 } }));
  await waitFor(() => lease.state.replay.phase === "joined");

  expect(lease.state.replay).toEqual({ phase: "joined", streamId: "stream-b" });
  expect(lease.lastSeq).toBe(0);
  expect(fake.joins()).toHaveLength(2);
});

test("matrix second-valid-join-rejoined: the old stream's rejoined end after a supersession is ignored", async () => {
  const fake = harness();
  await fake.ready;
  const lease = await joined(fake);
  lease.retry();
  await waitFor(() => fake.joins().length === 2);
  fake.event({ event: "replay_stream_ended", session_id: "session-a", stream_id: "stream-a", reason: "rejoined" });
  fake.reply(fake.joins()[1]!.id, joinResult({ replay: { stream_id: "stream-b", history_seq: 0 } }));
  await waitFor(() => lease.state.replay.phase === "joined");
  fake.event(delta(1, "next", "stream-b"));
  await Bun.sleep(1);

  expect(fake.joins()).toHaveLength(2);
  expect(lease.state.replay).toEqual({ phase: "joined", streamId: "stream-b" });
  expect(lease.lastSeq).toBe(1);
});

test.each(["second-join-stale-after-begin", "pending-join-reset"])("matrix %s: an exact stale join reply backs off and never restores the old stream", async () => {
  jest.useFakeTimers();
  try {
    const fake = harness();
    await fake.ready;
    const open = fake.client.openSessionReplay("session-a");
    await flush();
    fake.reply(fake.joins()[0]!.id, joinResult({ messages: [row("one", "one")] }));
    const lease = await open;
    lease.retry();
    await flush();
    fake.fail(fake.joins()[1]!.id, -32009, staleEvent);
    await flush();
    fake.event(delta(1, " old stream"));
    expect(fake.joins()).toHaveLength(2);
    jest.advanceTimersByTime(500);
    await flush();

    expect(fake.joins()).toHaveLength(3);
    expect(lease.state.replay).toEqual({ phase: "rejoining", attempt: 2 });
    expect(outlineText(fake.client)).toEqual(["one"]);
  } finally {
    jest.useRealTimers();
  }
});

test("matrix join-rejected-before-validation: a rejected raw join leaves the owner, stream, frontier, and store unchanged", async () => {
  const fake = harness();
  await fake.ready;
  const lease = await joined(fake, { messages: [row("one", "one")] });
  const store = lease.store;
  const raw = fake.client.request("session_history_and_subscribe", {});
  fake.fail(fake.sent.at(-1)!.id, -32602);
  await expect(raw).rejects.toMatchObject({ code: -32602 });
  fake.event(delta(1, "next"));

  expect(lease.state.replay).toEqual({ phase: "joined", streamId: "stream-a" });
  expect(lease.lastSeq).toBe(1);
  expect(fake.client.stores.get("session-a")).toBe(store);
  expect(outlineText(fake.client)).toEqual(["one", "next"]);
});

test("matrix accepted-resume-other: selecting another session suspends the first before the second joins", async () => {
  const fake = harness();
  await fake.ready;
  const first = await joined(fake);
  const second = await joined(fake, { replay: { stream_id: "stream-b", history_seq: 0 } }, "session-b");
  fake.event(delta(1, "stale"));
  fake.event(delta(1, "live", "stream-b", "session-b"));

  expect(first.state.replay).toEqual({ phase: "suspended" });
  expect(second.state.replay).toEqual({ phase: "joined", streamId: "stream-b" });
  expect(second.lastSeq).toBe(1);
  expect(assistantText(fake.client, "session-a")).toBeUndefined();
});

test.each(["output-overflow-close", "write-or-admission-failure-close", "peer-close"])("matrix %s: a close is no stream end; the owner stops and the host's reconnect path runs", async (name) => {
  const fake = harness();
  await fake.ready;
  const closes: unknown[] = [];
  fake.client.onClose((error) => closes.push(error));
  const open = fake.client.openSessionReplay("session-a");
  await waitFor(() => fake.joins().length === 1);
  if (name !== "write-or-admission-failure-close") fake.reply(fake.joins()[0]!.id, joinResult());
  if (name === "output-overflow-close") fake.fail(null, -32011, undefined, "output overflow (controller)");
  const lease = await Promise.race([open, Bun.sleep(5).then(() => undefined)]);
  const notices: unknown[] = [];
  lease?.subscribeReplay(() => notices.push(lease.state));
  fake.close(1011);
  const settled = await open;
  settled.retry();
  await Bun.sleep(1);

  expect(closes).toHaveLength(1);
  expect(fake.joins(), "no synthetic end and no rejoin after close").toHaveLength(1);
  expect(notices).toEqual([]);
  expect(settled.state.replay.phase).not.toBe("rejoining");
});

test.each([
  ["active-reset-empty-frontier-stable", "assistant_reset"], ["active-reset-same-frontier-stable", "assistant_reset"],
  ["append-only-compaction", "compaction_end"], ["rename-session-no-end", "session_renamed"],
  ["fork-message-no-end", "session_forked"], ["switch-branch-no-end", "branch_switched"],
])("matrix %s: no end and no join; the next contiguous frame applies", async (_, event) => {
  const fake = harness();
  await fake.ready;
  const lease = await joined(fake);
  fake.event({ event, session_id: "session-a", stream_id: "stream-a", seq: 1, data: {} });
  fake.event(delta(2, "next"));
  await Bun.sleep(1);

  expect(fake.joins()).toHaveLength(1);
  expect(lease.state.replay).toEqual({ phase: "joined", streamId: "stream-a" });
  expect(lease.lastSeq).toBe(2);
  expect(assistantText(fake.client, "session-a")).toBe("next");
});

test("matrix older-history-read-no-end: reading an older page leaves the stream contiguous", async () => {
  const fake = harness();
  await fake.ready;
  const lease = await joined(fake, { messages: [row("new", "new")], next_before: 1, history_validator: { end: 2, entry_id: "new" } });
  await waitFor(() => fake.sent.some(({ method }) => method === "session_history"));
  fake.reply(fake.sent.find(({ method }) => method === "session_history")!.id, { messages: [row("old", "old")], next_before: null, history_validator: { end: 2, entry_id: "new" } });
  await waitFor(() => lease.state.history.phase === "complete");
  fake.event(delta(1, "next"));

  expect(fake.joins()).toHaveLength(1);
  expect(lease.state.replay).toEqual({ phase: "joined", streamId: "stream-a" });
  expect(lease.lastSeq).toBe(1);
  expect(outlineText(fake.client)).toEqual(["old", "new", "next"]);
});
