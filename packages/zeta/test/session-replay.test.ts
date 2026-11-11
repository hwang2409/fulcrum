import { expect, test } from "bun:test";
import { domShimAlarm, shimProperty } from "../../../test-support/dom-shim.js";
import { createClient, parseJoinStatus, type EventParams, type Transport } from "../src/index.js";

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
const harness = () => {
  let receive!: (text: string) => void;
  const sent: Array<{ id: number; method: string; params: unknown }> = [];
  const transport: Transport = {
    send(text) { sent.push(JSON.parse(text)); },
    onMessage(listener) { receive = listener; },
    close() {},
  };
  const client = createClient(transport, (job) => job());
  const reply = (id: number, result: unknown) => receive(JSON.stringify({ jsonrpc: "2.0", id, result }));
  const event = (params: EventParams) => receive(JSON.stringify({ jsonrpc: "2.0", method: "event", params }));
  const hello = client.hello(["session_replay_seq"]);
  reply(sent[0]!.id, { protocol_version: "1.2", capabilities: { features: ["session_replay_seq"] } });
  const ready = hello.then(() => { sent.splice(0); });
  return { client, sent, reply, event, ready };
};
const waitFor = async (condition: () => boolean) => {
  for (let index = 0; index < 100 && !condition(); index++) await Bun.sleep(1);
  expect(condition()).toBe(true);
};

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

  expect(assistantText(fake.client, "session-a")).toBe("x");
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

  expect(lease.state.replay).toEqual({ phase: "joined", streamId: "stream-a", lastSeq: 5 });
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
      expect(lease.state.replay, role).toMatchObject({ phase: "joined", lastSeq: 1 });
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
