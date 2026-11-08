import { expect, test } from "bun:test";
import { createRunStore, type OutlineSnapshot } from "../src/index.js";
import { seededRandom } from "./fuzz.js";

const message = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

test("100 dispatches in one burst notify subscribers exactly once", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  let calls = 0;
  store.subscribe(() => calls++);

  for (let i = 0; i < 100; i++) store.dispatch({ type: "message_delta", delta: "x" });

  expect(calls).toBe(0);
  expect(jobs).toHaveLength(1);
  jobs[0]();
  expect(calls).toBe(1);
});

test("one delta notifies only its keyed subscriber", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  store.dispatch({ type: "message_commit", message_id: "a", message: message("a") });
  store.dispatch({ type: "message_commit", message_id: "b", message: message("b") });
  jobs.shift()!();

  let a = 0;
  let b = 0;
  let outline = 0;
  store.subscribe("message:a", () => a++);
  store.subscribe("message:b", () => b++);
  store.subscribeOutline(() => outline++);

  const before = store.getState();
  const aItem = store.getItem("message:a");
  const bItem = store.getItem("message:b");
  store.dispatch({ type: "message_delta", message_id: "a", delta: "+" });
  jobs.shift()!();

  expect(a).toBe(1);
  expect(b).toBe(0);
  expect(outline).toBe(0);
  expect(store.getOutline()).toBe(before.outline);
  expect(store.getItem("message:a")).not.toBe(aItem);
  expect(store.getItem("message:b")).toBe(bItem);
});

test("outline changes only when membership changes", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  const empty = store.getOutline();
  store.dispatch({ type: "message_delta", message_id: "a", delta: "a" });
  jobs.shift()!();
  const added = store.getOutline();
  expect(added).toEqual([{ id: "message:a", kind: "message" }]);
  expect(added).not.toBe(empty);

  store.dispatch({ type: "message_delta", message_id: "a", delta: "b" });
  jobs.shift()!();
  expect(store.getOutline()).toBe(added);
});

const ids = (items: readonly { id: string }[]) => items.map(({ id }) => id);
// Applies a change the way a view does, so a test checks that the edits rebuild `items` exactly.
const applyChange = (snapshot: OutlineSnapshot) => {
  const items = [...snapshot.change!.from];
  for (const { index, deleteCount, items: inserted } of snapshot.change!.splices) items.splice(index, deleteCount, ...inserted);
  expect(items).toEqual([...snapshot.items]);
  return snapshot.change!.splices;
};

test("outline snapshots describe batched appends and deletion as edits from the last notified outline", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  expect(store.getOutlineSnapshot().change).toBeNull();
  const empty = store.getOutline();
  store.dispatch({ type: "message_commit", message_id: "a", message: message("a") });
  store.dispatch({ type: "message_commit", message_id: "b", message: message("b") });
  jobs.shift()!();
  expect(store.getOutlineSnapshot().change!.from).toBe(empty);
  expect(applyChange(store.getOutlineSnapshot())).toEqual([{ index: 0, deleteCount: 0, items: [{ id: "message:a", kind: "message" }, { id: "message:b", kind: "message" }] }]);

  // A read between two dispatches flushes early; the notification still carries one edit list from the notified outline.
  const notified = store.getOutline();
  store.dispatch({ type: "message_commit", message_id: "forced-a", message: message("a") });
  const early = store.getOutlineSnapshot();
  store.dispatch({ type: "message_commit", message_id: "forced-b", message: message("b") });
  const late = store.getOutlineSnapshot();
  expect(late.change!.from).toBe(notified);
  expect(applyChange(late)).toEqual([{ index: 2, deleteCount: 0, items: [{ id: "message:forced-a", kind: "message" }, { id: "message:forced-b", kind: "message" }] }]);
  // The early snapshot is published: extending the change must not edit it.
  expect(applyChange(early)).toEqual([{ index: 2, deleteCount: 0, items: [{ id: "message:forced-a", kind: "message" }] }]);
  jobs.shift()!();

  store.dispatch({ type: "message_delta", message_id: "c", delta: "c" });
  jobs.shift()!();
  store.dispatch({ type: "message_reset" });
  jobs.shift()!();
  expect(applyChange(store.getOutlineSnapshot())).toEqual([{ index: 4, deleteCount: 1, items: [] }]);
  // A row opened and reset in one frame is no edit at all.
  store.dispatch({ type: "message_delta", message_id: "d", delta: "d" });
  store.dispatch({ type: "message_reset" });
  jobs.shift()!();
  expect(applyChange(store.getOutlineSnapshot())).toEqual([]);
});

test("an approval folding into its tool row is one replace in place, even with an append in the same frame", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  const read = { id: "read-1", name: "read", arguments: { path: "README.md" } };
  store.dispatch({ type: "user_message", text: "go", mode: "normal" });
  store.dispatch({ type: "approval_request", request_id: "read-1", tool_call: read, delegated: false });
  store.dispatch({ type: "approval_end", request_id: "read-1", decision: "approve" });
  store.dispatch({ type: "message_commit", message_id: "m", message: message("m") });
  jobs.shift()!();
  // The tool's row takes the approval's place.
  store.dispatch({ type: "tool_start", tool_call: read });
  jobs.shift()!();
  expect(applyChange(store.getOutlineSnapshot())).toEqual([{ index: 1, deleteCount: 1, items: [{ id: "tool:read-1", kind: "tool" }] }]);
  const bash = { id: "bash-2", name: "bash", arguments: { command: "ls" } };
  store.dispatch({ type: "approval_request", request_id: "bash-2", tool_call: bash, delegated: false });
  jobs.shift()!();
  store.dispatch({ type: "approval_end", request_id: "bash-2", decision: "approve" });
  store.dispatch({ type: "tool_start", tool_call: bash });
  store.dispatch({ type: "message_commit", message_id: "after", message: message("after") });
  jobs.shift()!();
  expect(applyChange(store.getOutlineSnapshot())).toEqual([
    { index: 3, deleteCount: 1, items: [{ id: "tool:bash-2", kind: "tool" }, { id: "message:after", kind: "message" }] },
  ]);
  expect(ids(store.getOutline())).toEqual(["user:1", "tool:read-1", "message:m", "tool:bash-2", "message:after"]);
  // The tool row came first (a replayed history): the approval's row goes, the tool row stays where it is.
  const write = { id: "write-3", name: "write", arguments: { path: "a" } };
  store.dispatch({ type: "tool_start", tool_call: write });
  store.dispatch({ type: "message_commit", message_id: "between", message: message("between") });
  store.dispatch({ type: "approval_request", request_id: "write-3", tool_call: write, delegated: false });
  jobs.shift()!();
  store.dispatch({ type: "approval_end", request_id: "write-3", decision: "approve" });
  jobs.shift()!();
  expect(applyChange(store.getOutlineSnapshot())).toEqual([{ index: 7, deleteCount: 1, items: [] }]);
  expect(ids(store.getOutline()).slice(5)).toEqual(["tool:write-3", "message:between"]);
});

test("serializes dispatches that re-enter during a reduction", () => {
  const store = createRunStore((job) => job());
  const nested = { type: "user_message", text: "nested", mode: "send", delivery_id: "nested" } as const;
  const outer = {
    type: "user_message", text: "outer", mode: "send",
    get delivery_id() { store.dispatch(nested); return "outer"; },
  } as const;
  store.dispatch(outer);
  expect(store.getOutline()).toEqual([
    { id: "user:delivery:outer", kind: "user" },
    { id: "user:delivery:nested", kind: "user" },
  ]);
  expect(store.getItem("user:delivery:outer")).toBeDefined();
  expect(store.getItem("user:delivery:nested")).toBeDefined();
  expect(store.hasMessageDelivery("outer")).toBe(true);
  expect(store.hasMessageDelivery("nested")).toBe(true);
});

test("keeps one snapshot for every subscriber notification pass", () => {
  const store = createRunStore((job) => job());
  const seenA: string[][] = [];
  const seenB: string[][] = [];
  let first = true;
  store.subscribe(() => {
    if (first) {
      first = false;
      store.dispatch({ type: "user_message", text: "nested", mode: "send", delivery_id: "nested" });
    }
    seenA.push(store.getOutline().map(({ id }) => id));
  });
  store.subscribe(() => seenB.push(store.getOutline().map(({ id }) => id)));

  store.dispatch({ type: "user_message", text: "outer", mode: "send", delivery_id: "outer" });

  expect(seenA).toEqual([["user:delivery:outer"], ["user:delivery:outer", "user:delivery:nested"]]);
  expect(seenB).toEqual([["user:delivery:outer"], ["user:delivery:outer", "user:delivery:nested"]]);
});

test("queues subscriber dispatches until after the current notification", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  let calls = 0;
  store.subscribe(() => {
    calls++;
    if (calls === 1) store.dispatch({ type: "user_message", text: "second", mode: "send", delivery_id: "second" });
  });
  store.dispatch({ type: "user_message", text: "first", mode: "send", delivery_id: "first" });
  jobs.shift()!();
  expect(calls).toBe(2);
  expect(store.getOutline()).toEqual([
    { id: "user:delivery:first", kind: "user" },
    { id: "user:delivery:second", kind: "user" },
  ]);
});

test("does not publish a reduction when disposed during the reduction", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  const event = {
    type: "user_message", text: "dispose", mode: "send",
    get delivery_id() { store.dispose(); return "dispose"; },
  } as const;
  store.dispatch(event);
  jobs.shift()!();
  expect(store.getOutline()).toEqual([]);
  expect(store.getItem("user:delivery:dispose")).toBeUndefined();
  expect(store.hasMessageDelivery("dispose")).toBe(false);
  expect(() => store.dispatch({ type: "message_delta", message_id: "late", delta: "x" })).toThrow("store is disposed");
});

test("dispose stops notifications, drops pending chunks, and rejects dispatch", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  let calls = 0;
  store.subscribe("message:a", () => calls++);
  store.dispatch({ type: "message_delta", message_id: "a", delta: "queued" });
  store.dispose();
  jobs.shift()!();

  expect(calls).toBe(0);
  expect(store.getItem("message:a")).toBeUndefined();
  expect(() => store.dispatch({ type: "message_delta", message_id: "a", delta: "late" })).toThrow(
    "store is disposed",
  );
});

test("published state snapshots do not change after a later delivery", () => {
  const store = createRunStore((flush) => flush());
  store.dispatch({ type: "user_message", text: "first", mode: "send", delivery_id: "one" });
  const before = store.getState();
  const snapshot = structuredClone(before);
  store.dispatch({ type: "user_message", text: "second", mode: "send", delivery_id: "two" });
  store.getState();
  expect(before).toEqual(snapshot);
  expect(snapshot.outline).toHaveLength(1);
});

test("stores do not share delivery aliases through initialState", () => {
  const first = createRunStore((flush) => flush());
  first.dispatch({ type: "user_message", text: "first", mode: "send", delivery_id: "same" });
  first.dispose();
  const second = createRunStore((flush) => flush());
  second.dispatch({ type: "user_message", text: "second", mode: "send", delivery_id: "same" });
  expect(second.getOutline()).toEqual([{ id: "user:delivery:same", kind: "user" }]);
});

test("an unexpected reduction failure marks the store desynced until history replaces it", () => {
  const jobs: Array<() => void> = [];
  const errors: unknown[] = [];
  const store = createRunStore((job) => jobs.push(job), { onError: (error) => errors.push(error) });
  store.dispatch({ type: "user_message", text: "first", mode: "send", delivery_id: "first" });
  jobs.shift()!();
  let reads = 0;
  const event = new Proxy({ type: "retry" }, {
    get(target, key, receiver) {
      if (key === "type" && ++reads > 3) throw new Error("boom");
      return Reflect.get(target, key, receiver);
    },
  }) as RunEvent;
  store.dispatch(event);
  jobs.shift()!();
  expect(errors).toHaveLength(1);
  expect(store.getDiagnostics()).toEqual({ ignoredEvents: 0, sanitizedFields: 0, desynced: true, reason: "boom" });
  expect(store.getOutline()).toEqual([{ id: "user:delivery:first", kind: "user" }]);
  expect(store.getItem("user:delivery:first")).toBeDefined();
  expect(() => store.dispatch({ type: "turn_end" })).toThrow("store is desynced");

  store.resync([{ type: "user_message", text: "from history", mode: "send", delivery_id: "history" }]);
  expect(store.getDiagnostics().desynced).toBe(false);
  expect(store.getOutline()).toEqual([{ id: "user:delivery:history", kind: "user" }]);
});

test("history windows reject prepends after releasing their accepted events", () => {
  const store = createRunStore((flush) => flush());
  store.beginHistory();
  store.dispatch({ type: "run_start" });
  store.endHistory();
  store.dispatch({ type: "run_end" });

  expect(store.getState().agent).toBe("idle");
  expect(() => store.prepend([])).toThrow("prepend requires an open history window");
});

test("prepend composes a message stream split across the page seam", () => {
  const store = createRunStore((flush) => flush());
  store.beginHistory();
  store.dispatch({ type: "message_delta", message_id: "split", delta: "suffix" });

  store.prepend([{ type: "message_delta", message_id: "split", delta: "prefix-" }]);

  expect((store.getItem("message:split") as { text: string }).text).toBe("prefix-suffix");
});

test("prepend keeps a current approval resolution when its request is older", () => {
  const call = { id: "split", name: "bash", arguments: { command: "true" } };
  const store = createRunStore((flush) => flush());
  store.beginHistory();
  store.resync([{ type: "approval_end", request_id: "split", decision: "approve" }]);

  store.prepend([{ type: "approval_request", request_id: "split", tool_call: call, delegated: false }]);

  expect(store.getItem("approval:split")).toMatchObject({ ended: { decision: "approve" } });
});

test("prepend folds an older completed tool with its newer approval resolution", () => {
  const call = { id: "split", name: "bash", arguments: { command: "true" } };
  const store = createRunStore((flush) => flush());
  store.beginHistory();
  store.resync([{ type: "approval_end", request_id: "split", decision: "approve" }]);

  store.prepend([
    { type: "approval_request", request_id: "split", tool_call: call, delegated: false },
    { type: "tool_end", tool_call: call, tool_result: { tool_call_id: "split", content: "done", is_error: false } },
  ]);

  expect(store.getOutline()).toEqual([{ id: "tool:split", kind: "tool" }]);
  expect(store.getItem("tool:split")).toMatchObject({ approval: { decision: "approve" }, version: 2 });
  expect(store.getState().toolApprovals).toEqual({});
});

test("prepend assigns generated ids as a whole chronological reduction", () => {
  const store = createRunStore((flush) => flush());
  store.beginHistory();
  store.resync([{ type: "error", error: { code: "newer", message: "newer" } }]);

  store.prepend([{ type: "message_commit", message_id: "fixed", message: message("older") }]);

  expect(store.getOutline()).toEqual([
    { id: "message:fixed", kind: "message" },
    { id: "error:2", kind: "error" },
  ]);
  expect(store.getItem("error:1")).toBeUndefined();
  expect(store.getItem("error:2")).toMatchObject({ event: { error: { message: "newer" } } });
  expect(store.getOutlineSnapshot().change?.splices).toEqual([{
    index: 0,
    deleteCount: 1,
    items: [{ id: "message:fixed", kind: "message" }, { id: "error:2", kind: "error" }],
  }]);
});

test("resync to empty publishes outline and keyed removals", () => {
  const store = createRunStore((flush) => flush());
  store.dispatch({ type: "message_commit", message_id: "old", message: message("old") });
  let stateChanges = 0;
  let outlineChanges = 0;
  let itemChanges = 0;
  store.subscribe(() => stateChanges++);
  store.subscribeOutline(() => outlineChanges++);
  store.subscribe("message:old", () => itemChanges++);

  store.resync([]);

  expect(store.getOutline()).toEqual([]);
  expect(store.getItem("message:old")).toBeUndefined();
  expect({ stateChanges, outlineChanges, itemChanges }).toEqual({ stateChanges: 1, outlineChanges: 1, itemChanges: 1 });
  expect(store.getOutlineSnapshot().change?.splices).toEqual([{
    index: 0,
    deleteCount: 1,
    items: [],
  }]);
});

test("prepend rejection keeps the last good state and visibly desyncs", () => {
  const errors: unknown[] = [];
  const store = createRunStore((flush) => flush(), { onError: (error) => errors.push(error) });
  store.beginHistory();
  store.resync([{ type: "message_commit", message_id: "kept", message: message("kept") }]);
  const kept = store.getItem("message:kept");
  let reads = 0;
  const broken = new Proxy({ type: "retry" }, {
    get(target, key, receiver) {
      if (key === "type" && ++reads > 3) throw new Error("broken history");
      return Reflect.get(target, key, receiver);
    },
  }) as RunEvent;

  store.prepend([broken]);

  expect(store.getOutline()).toEqual([{ id: "message:kept", kind: "message" }]);
  expect(store.getItem("message:kept")).toBe(kept);
  expect(store.getDiagnostics()).toMatchObject({ desynced: true, reason: "broken history" });
  expect(errors).toHaveLength(1);
});

test("prepend coalesces pages queued in one frame", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((flush) => jobs.push(flush));
  store.beginHistory();
  store.resync([{ type: "message_commit", message_id: "new", message: message("new") }]);
  store.prepend([{ type: "message_commit", message_id: "middle", message: message("middle") }]);
  store.prepend([{ type: "message_commit", message_id: "old", message: message("old") }]);

  expect(jobs).toHaveLength(1);
  jobs.shift()!();
  expect(store.getOutline().map(({ id }) => id)).toEqual(["message:old", "message:middle", "message:new"]);
  expect(store.getOutlineSnapshot().change?.splices).toEqual([{
    index: 0,
    deleteCount: 0,
    items: [{ id: "message:old", kind: "message" }, { id: "message:middle", kind: "message" }],
  }]);
});

const prependView = (store: ReturnType<typeof createRunStore>) => ({
  state: store.getState(),
  items: store.getOutline().map(({ id }) => store.getItem(id)),
});

const generatedHistory = (seed: number) => {
  const next = seededRandom(seed);
  const random = (max: number) => Math.floor(next() * max);
  const events: Parameters<ReturnType<typeof createRunStore>["dispatch"]>[0][] = [];
  const groups = 8 + random(11);
  for (let group = 0; group < groups; group++) {
    const id = `${seed}-${group}`;
    const kind = random(8);
    if (kind === 0) {
      const deltas = 1 + random(4);
      const streamKind = ["text", "reasoning", "user"][random(3)]!;
      for (let part = 0; part < deltas; part++) events.push({ type: "message_delta", message_id: id, delta: `${id}:${part}|`, kind: streamKind });
      if (random(2)) events.push({ type: "message_commit", message_id: id, message: message(`done:${id}`) });
      else events.push({ type: "turn_end" });
    } else if (kind === 1) {
      const call = { id, name: "bash", arguments: { command: `echo ${id}` } };
      events.push({ type: "tool_start", tool_call: call });
      if (random(2)) events.push({ type: "tool_input", tool_call: call, input: JSON.stringify(call.arguments) });
      events.push({ type: "tool_end", tool_call: { ...call, arguments: {} }, tool_result: { tool_call_id: id, content: `done:${id}`, is_error: false } });
    } else if (kind === 2) {
      const call = { id, name: "write", arguments: { path: id } };
      events.push({ type: "approval_request", request_id: id, tool_call: call, delegated: false });
      events.push({ type: "approval_end", request_id: id, decision: random(2) ? "approve" : "deny" });
    } else if (kind === 3) {
      events.push({ type: "usage", usage: { input: 1 + random(100), output: random(50) } });
    } else if (kind === 4) {
      events.push({ type: "sub_agent", childRunId: id, status: "running", toolCount: random(5), sequence: 1 });
      events.push({ type: "sub_agent", childRunId: id, status: "done", summary: `done:${id}`, toolCount: 5, sequence: 2 });
    } else if (kind === 5) {
      events.push({ type: "run_start" }, { type: "turn_start", data: { turn: id } }, { type: "turn_end" }, { type: "run_end" });
    } else if (kind === 6) {
      events.push({ type: "error", error: { code: id, message: `error:${id}` } });
    } else {
      events.push({ type: "notification", data: { message: id } });
    }
  }
  return events;
};

test("prepend equals whole-log reduction at every page seam", () => {
  let cases = 0;
  for (let seed = 10_001; seed <= 11_100; seed++) {
    const events = generatedHistory(seed);
    const expected = createRunStore((flush) => flush());
    expected.resync(events);
    const expectedView = prependView(expected);
    for (let split = 0; split <= events.length; split++) {
      const actual = createRunStore((flush) => flush());
      actual.beginHistory();
      actual.resync(events.slice(split));
      actual.prepend(events.slice(0, split));
      expect(prependView(actual), `seed ${seed}, split ${split}`).toEqual(expectedView);
      cases++;
    }
    const first = seed % (events.length + 1);
    const second = first + seed % (events.length - first + 1);
    const actual = createRunStore((flush) => flush());
    actual.beginHistory();
    actual.resync(events.slice(second));
    actual.prepend(events.slice(first, second));
    actual.prepend(events.slice(0, first));
    expect(prependView(actual), `seed ${seed}, splits ${first}/${second}`).toEqual(expectedView);
    cases++;
  }
  expect(cases).toBeGreaterThan(30_000);
});

test("prepend inserts older rows without resetting or replacing the live tail", () => {
  const store = createRunStore((flush) => flush());
  store.beginHistory();
  store.dispatch({ type: "message_commit", message_id: "new", message: message("new") });
  store.dispatch({ type: "user_message", text: "pending", mode: "steer", intent: "pending", delivery_id: "pending" });
  store.dispatch({ type: "message_delta", message_id: "live", delta: "streaming" });
  const pending = store.getItem("user:intent:pending");
  const live = store.getItem("message:live");

  store.prepend([
    { type: "user_message", message_id: "old", text: "old", mode: "send" },
    { type: "message_commit", message_id: "new", message: message("stale replacement") },
  ]);

  expect(store.getOutline().map(({ id }) => id)).toEqual(["user:message:old", "message:new", "user:intent:pending", "message:live"]);
  expect(store.getItem("user:intent:pending")).toBe(pending);
  expect(store.getItem("message:live")).toBe(live);
  expect(store.getItem("message:new")).toMatchObject({ message: message("new") });
  expect(store.getOutlineSnapshot().change?.splices).toEqual([{ index: 0, deleteCount: 0, items: [{ id: "user:message:old", kind: "user" }] }]);
});

test("a malformed event after a delivered row is a counted no-op", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((flush) => jobs.push(flush));
  store.dispatch({ type: "user_message", text: "go", mode: "send", delivery_id: "kept" });
  store.dispatch({ type: "tool_start", tool_call: undefined as never });
  jobs.shift()!();
  expect(store.getOutline()).toEqual([{ id: "user:delivery:kept", kind: "user" }]);
  expect(store.getItem("user:delivery:kept")).toBeDefined();
  expect(store.hasMessageDelivery("kept")).toBe(true);
  expect(store.getDiagnostics().ignoredEvents).toBe(1);
});

test("a malformed event after a plain row is a counted no-op", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((flush) => jobs.push(flush));
  store.dispatch({ type: "user_message", text: "go", mode: "send" });
  store.dispatch({ type: "tool_start", tool_call: undefined as never });
  store.dispatch(null as never);
  jobs.shift()!();
  expect(store.getOutline()).toEqual([{ id: "user:1", kind: "user" }]);
  expect(store.getItem("user:1")).toBeDefined();
  expect(store.getDiagnostics().ignoredEvents).toBe(2);
});

test("dispose and replay rebuilds delivery aliases", () => {
  const store = createRunStore((flush) => flush());
  store.dispatch({ type: "user_message", text: "first", mode: "send", delivery_id: "one" });
  store.dispose();
  const replay = createRunStore((flush) => flush());
  replay.dispatch({ type: "user_message", text: "first", mode: "send", delivery_id: "one" });
  replay.dispatch({ type: "user_message", text: "replacement", mode: "send", delivery_id: "two" });
  expect(replay.getOutline()).toHaveLength(2);
  expect(replay.getItem("user:delivery:one")).toBeDefined();
  expect(replay.getItem("user:delivery:two")).toBeDefined();
});

test("one user intent is one row: a dropped steer resent as a new message replaces its row in place", () => {
  const store = createRunStore((flush) => flush());
  store.dispatch({ type: "user_message", text: "run the tests", mode: "send", intent: "a" });
  store.dispatch({ type: "message_commit", message_id: "m1", message: message("working") });
  store.dispatch({ type: "user_message", text: "also windows", mode: "steer", intent: "b" });
  store.dispatch({ type: "message_commit", message_id: "m2", message: message("done") });
  const before = store.getOutline().map((entry) => entry.id);
  store.dispatch({ type: "user_message", text: "also windows", mode: "send", intent: "b" });
  const outline = store.getOutline();
  expect(outline.map((entry) => entry.id)).toEqual(before);
  const users = outline.filter((entry) => entry.kind === "user").map((entry) => store.getItem(entry.id));
  expect(users.map((item) => item?.type === "user" && item.event.type === "user_message" && [item.event.text, item.event.mode])).toEqual([["run the tests", "send"], ["also windows", "send"]]);
  // Without an intent every message is its own row.
  store.dispatch({ type: "user_message", text: "again", mode: "send" });
  store.dispatch({ type: "user_message", text: "again", mode: "send" });
  expect(store.getOutline().filter((entry) => entry.kind === "user")).toHaveLength(4);
});

test("random streams with early reads: every snapshot's edits rebuild its items from its base", () => {
  let seed = 7;
  const random = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), Math.floor((seed / 2 ** 31) * n));
  for (let run = 0; run < 50; run++) {
    const jobs: Array<() => void> = [];
    const store = createRunStore((job) => jobs.push(job));
    let calls = 0;
    for (let step = 0; step < 200; step++) {
      const call = { id: `c${random(calls + 1)}`, name: "bash", arguments: {} };
      const choice = random(8);
      if (choice === 0) calls++, store.dispatch({ type: "approval_request", request_id: `c${calls}`, tool_call: { ...call, id: `c${calls}` }, delegated: false });
      else if (choice === 1) store.dispatch({ type: "approval_end", request_id: call.id, decision: "approve" });
      else if (choice === 2) store.dispatch({ type: "tool_start", tool_call: call });
      else if (choice === 3) store.dispatch({ type: "message_delta", delta: "x" });
      else if (choice === 4) store.dispatch({ type: "message_reset" });
      else if (choice === 5) store.dispatch({ type: "user_message", text: "u", mode: "normal" });
      else if (choice === 6) store.getOutlineSnapshot().change && applyChange(store.getOutlineSnapshot());
      else jobs.splice(0).forEach((job) => job()), store.getOutlineSnapshot().change && applyChange(store.getOutlineSnapshot());
    }
  }
});

test("live and history user messages join one row through original and replacement delivery ids", () => {
  const liveFirst = createRunStore((flush) => flush());
  liveFirst.dispatch({ type: "user_message", text: "go", mode: "send", intent: "intent-1", delivery_id: "delivery-1" });
  liveFirst.dispatch({ type: "user_message", text: "go", mode: "send", intent: "intent-1", delivery_id: "delivery-2" });
  liveFirst.dispatch({ type: "user_message", text: "go", mode: "send", delivery_id: "delivery-1" });
  expect(liveFirst.getOutline().filter((item) => item.kind === "user")).toHaveLength(1);

  const historyFirst = createRunStore((flush) => flush());
  historyFirst.dispatch({ type: "user_message", text: "go", mode: "send", delivery_id: "delivery-1" });
  historyFirst.dispatch({ type: "user_message", text: "go", mode: "send", intent: "intent-1", delivery_id: "delivery-1" });
  historyFirst.dispatch({ type: "user_message", text: "go", mode: "send", intent: "intent-1", delivery_id: "delivery-2" });
  expect(historyFirst.getOutline().filter((item) => item.kind === "user")).toHaveLength(1);
});

test("delivery-id reconciliation reads a constant number of entities in a 100k-row outline", async () => {
  const { initialState, reduceAllWithEntities } = await import("../src/reducer.js");
  const target = { id: "user:target", type: "user" as const, event: { type: "user_message" as const, text: "go", mode: "send", delivery_id: "other" } };
  const entities = new Map<string, typeof target>();
  entities.set(target.id, target);
  const outline = [{ id: target.id, kind: "user" as const }];
  for (let i = 0; i < 100_000; i++) {
    const id = `user:${i}`;
    entities.set(id, { id, type: "user", event: { type: "user_message", text: "x", mode: "send" } });
    outline.push({ id, kind: "user" });
  }
  const state = { ...initialState, outline };
  let reads = 0;
  reduceAllWithEntities(state, [{ type: "user_message", text: "go", mode: "send", delivery_id: "target" }], {
    get(id) { reads++; return entities.get(id); },
    set() {}, delete() {}, splice() {},
    getMessageAlias() { return undefined; },
    setMessageAlias() {},
  });
  expect(reads).toBeLessThan(10);
});
