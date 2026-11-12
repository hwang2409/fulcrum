import { expect, spyOn, test } from "bun:test";
import { domShimAlarm, shimProperty } from "../../../test-support/dom-shim.js";
domShimAlarm(import.meta.path);
import { createRunStore, type OutlineSnapshot, type RunEvent, type RunStore, type StoreDiagnostics } from "../src/index.js";
import { seededRandom } from "./fuzz.js";

const message = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

test("100 dispatches in one burst notify subscribers exactly once", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  let calls = 0;
  let outlineCalls = 0;
  store.subscribe(() => calls++);
  store.subscribeOutline(() => outlineCalls++);

  for (let i = 0; i < 100; i++) store.dispatch({ type: "message_delta", delta: "x" });

  expect(calls).toBe(0);
  expect(jobs).toHaveLength(1);
  jobs[0]();
  expect({ calls, outlineCalls, jobs: jobs.length }).toEqual({ calls: 1, outlineCalls: 1, jobs: 1 });
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

test("prepend joins an older message to its newer dropped status", () => {
  const store = createRunStore((flush) => flush());
  store.beginHistory();
  store.dispatch({ type: "delivery_status", delivery_id: "d", method: "steer", status: "dropped", content: "steer dropped: turn_end", reason: "turn_end" });
  expect(store.getOutline()).toEqual([{ id: "user:delivery:d", kind: "user" }]);
  expect(store.getItem("user:delivery:d")).toMatchObject({ event: { text: "", text_omitted: true } });

  store.prepend([{ type: "user_message", text: "keep going", mode: "steer", delivery_id: "d" }]);

  expect(store.getOutline()).toEqual([{ id: "user:delivery:d", kind: "user" }]);
  expect(store.getItem("user:delivery:d")).toMatchObject({
    event: { text: "keep going", delivery_status: "dropped", delivery_reason: "turn_end" },
  });
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

const commit = (id: string): RunEvent => ({ type: "message_commit", message_id: id, message: message(id) });
const draft: RunEvent = { type: "message_delta", message_id: "s", delta: "draft" };
const reset: RunEvent = { type: "message_reset" };
// A resync is a discontinuity: subscribers are told only when they would miss something, and then take `items` whole
// (`change` is null). setup is notified; pending is flushed by a read (as apps/web does before resync) but its frame
// has not run yet; older is a history page a read flushed (so subscribers hold the `from` of an unnotified change).
const resyncRows: Array<{ name: string; setup: RunEvent[]; pending?: RunEvent; older?: RunEvent[]; replay: RunEvent[]; outlineNotes: number; view: string[]; keyed: Record<string, number> }> = [
  { name: "empty -> empty", setup: [], replay: [], outlineNotes: 0, view: [], keyed: {} },
  { name: "rows -> empty", setup: [commit("a")], replay: [], outlineNotes: 1, view: [], keyed: { "message:a": 1 } },
  { name: "empty -> rows", setup: [], replay: [commit("a")], outlineNotes: 1, view: ["message:a"], keyed: { "message:a": 1 } },
  { name: "same ids, pending change", setup: [commit("a")], pending: commit("x"), replay: [commit("a"), commit("x")], outlineNotes: 1, view: ["message:a", "message:x"], keyed: { "message:a": 1, "message:x": 1 } },
  { name: "same ids, nothing pending", setup: [commit("a")], replay: [commit("a")], outlineNotes: 0, view: ["message:a"], keyed: { "message:a": 1 } },
  { name: "different ids", setup: [commit("a")], replay: [commit("b")], outlineNotes: 1, view: ["message:b"], keyed: { "message:a": 1, "message:b": 1 } },
  { name: "pending change, empty replacement", setup: [commit("a")], pending: commit("x"), replay: [], outlineNotes: 1, view: [], keyed: { "message:a": 1, "message:x": 1 } },
  { name: "pending keyed removal, replay without it", setup: [commit("a"), draft], pending: reset, replay: [commit("a")], outlineNotes: 1, view: ["message:a"], keyed: { "message:a": 1, "message:s": 1 } },
  { name: "open history window, flushed page", setup: [commit("a")], older: [commit("b")], replay: [commit("a")], outlineNotes: 1, view: ["message:a"], keyed: { "message:a": 1, "message:b": 1 } },
];

test.each(resyncRows)("resync tells subscribers to take the outline whole: $name", ({ setup, pending, older, replay, outlineNotes, view: expectedView, keyed: expectedKeyed }) => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  const drain = () => { while (jobs.length > 0) jobs.shift()!(); };
  setup.forEach((event) => store.dispatch(event));
  drain();
  if (older) store.beginHistory();
  let held = store.getOutline();
  let notes = 0;
  let resynced = false;
  const changes: Array<OutlineSnapshot["change"]> = [];
  store.subscribeOutline(() => {
    notes++;
    const snapshot = store.getOutlineSnapshot();
    if (resynced) changes.push(snapshot.change);
    held = snapshot.items;
  });
  const keyed: Record<string, number> = {};
  for (const id of ["message:a", "message:b", "message:x", "message:s"]) store.subscribe(id, () => { keyed[id] = (keyed[id] ?? 0) + 1; });

  if (pending) store.dispatch(pending), store.getState();
  if (older) store.prepend(older), store.getState();
  resynced = true;
  store.resync(replay);
  drain();

  expect({ notes, changes, view: ids(held), keyed }).toEqual({ notes: outlineNotes, changes: Array(outlineNotes).fill(null), view: expectedView, keyed: expectedKeyed });
  expect(store.getOutlineSnapshot().change).toBeNull();
  expect(ids(held)).toEqual(ids(store.getOutline()));
});

test("two resyncs before a frame: each notifies only when its rows differ, and the last replay wins", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  store.dispatch(commit("a"));
  jobs.shift()!();
  const changes: Array<OutlineSnapshot["change"]> = [];
  store.subscribeOutline(() => changes.push(store.getOutlineSnapshot().change));
  store.resync([commit("b")]);
  store.resync([commit("b")]);
  store.resync([commit("c")]);
  while (jobs.length > 0) jobs.shift()!();
  expect({ changes, view: ids(store.getOutline()) }).toEqual({ changes: [null, null], view: ["message:c"] });
});

// A resync from inside a listener is not notified inside that notification (no nested pass with half-reset state);
// it is delivered right after it, once, as a whole replacement.
test("resync from a listener is delivered after the running notification, not nested in it", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  store.dispatch(commit("a"));
  let depth = 0;
  let nested = 0;
  const seen: Array<{ change: OutlineSnapshot["change"]; view: string[] }> = [];
  let resynced = false;
  store.subscribe(() => {
    if (depth > 0) nested++;
    depth++;
    if (!resynced) resynced = true, store.resync([commit("b"), commit("c")]);
    depth--;
  });
  store.subscribeOutline(() => {
    if (depth > 0) nested++;
    const snapshot = store.getOutlineSnapshot();
    seen.push({ change: snapshot.change, view: ids(snapshot.items) });
  });
  while (jobs.length > 0) jobs.shift()!();
  expect({ nested, last: seen.at(-1), view: ids(store.getOutline()) }).toEqual({
    nested: 0,
    last: { change: null, view: ["message:b", "message:c"] },
    view: ["message:b", "message:c"],
  });
});

// notify delivers a snapshot: each pending flag/set is taken and cleared before any listener runs, so whatever a
// listener adds (here a resync) lands in the next pass, even for a key the running pass already delivered. The rows
// outside a scheduler job, and the empty replay, have no scheduler loop behind them: only notify's own tail delivers.
const resyncFrom = (["global", "outline", "keyed"] as const).flatMap((from) => [
  { from, start: "in a frame", replay: ["c"] },
  { from, start: "in a frame", replay: [] },
  { from, start: "in an outer resync", replay: ["c"] },
]);
test.each(resyncFrom)("resync from a $from listener ($start, to $replay): every consumer ends on the replayed state", ({ from, start, replay }) => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  if (start === "in a frame") store.dispatch(commit("a")), store.dispatch(commit("b"));
  let resynced = false;
  const trigger = () => { if (!resynced) resynced = true, store.resync(replay.map(commit)); };
  let globalView: string[] = [];
  let outlineView: string[] = [];
  const keyed: Record<string, string | undefined> = {};
  store.subscribe(() => { globalView = ids(store.getState().outline); if (from === "global") trigger(); });
  store.subscribeOutline(() => { outlineView = ids(store.getOutlineSnapshot().items); if (from === "outline") trigger(); });
  for (const id of ["message:a", "message:b", "message:c"])
    store.subscribe(id, () => { keyed[id] = store.getItem(id)?.id; if (from === "keyed" && id === "message:b") trigger(); });
  if (start === "in an outer resync") store.resync([commit("a"), commit("b")]);
  while (jobs.length > 0) jobs.shift()!();
  const view = replay.map((id) => `message:${id}`);
  expect({ globalView, outlineView, keyed }).toEqual({
    globalView: view,
    outlineView: view,
    keyed: { "message:a": undefined, "message:b": undefined, ...(view.length > 0 && { "message:c": "message:c" }) },
  });
  expect(store.getItem("message:a")).toBeUndefined();
});

// A throwing listener is a bug in that listener, not in the others: every listener of the pass still runs, the store
// stays consistent, and the first error is rethrown once the pass is done.
test.each(["global", "outline", "keyed"] as const)("a throwing %s listener does not stop the others, and its error surfaces", (thrower) => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  const calls: string[] = [];
  const listener = (name: string) => () => {
    calls.push(name);
    if (name === thrower || (thrower === "keyed" && name === "message:a")) throw new Error(`boom ${name}`);
  };
  store.subscribe(listener("global"));
  store.subscribeOutline(listener("outline"));
  for (const id of ["message:a", "message:b"]) store.subscribe(id, listener(id));
  const boom = `boom ${thrower === "keyed" ? "message:a" : thrower}`;
  const all = ["global", "outline", "message:a", "message:b"];

  store.dispatch(commit("a"));
  store.dispatch(commit("b"));
  expect(jobs.shift()!).toThrow(boom);
  expect(calls).toEqual(all);

  calls.length = 0;
  expect(() => store.resync([commit("a"), commit("b"), commit("c")])).toThrow(boom);
  expect(calls).toEqual(all);
  expect(ids(store.getOutline())).toEqual(["message:a", "message:b", "message:c"]);

  calls.length = 0;
  store.dispatch(commit("d"));
  expect(jobs).toHaveLength(1);
  const job = jobs.shift()!;
  if (thrower === "keyed") job(); // message:d's pass has no keyed listener to throw
  else expect(job).toThrow(boom);
  expect(calls).toEqual(["global", "outline"]);
  expect(ids(store.getOutline())).toEqual(["message:a", "message:b", "message:c", "message:d"]);
});

// Only the first listener error can be rethrown; the others still reach the host's error report. With a synchronous
// scheduler the job runs inside dispatch, so dispatch is the call that rethrows.
test("later listener errors in a pass go to reportError, and a sync dispatch rethrows the first", () => {
  const store = createRunStore((job) => job());
  const reported = spyOn(globalThis, "reportError").mockImplementation(() => {});
  const calls: string[] = [];
  for (const name of ["first", "second", "third"]) store.subscribe(() => { calls.push(name); if (name !== "third") throw new Error(name); });
  try {
    expect(() => store.dispatch(commit("a"))).toThrow("first");
    expect(calls).toEqual(["first", "second", "third"]);
    expect(reported.mock.calls.map(([error]) => (error as Error).message)).toEqual(["second"]);
  } finally {
    reported.mockRestore();
  }
});

// A throw that no listener wrapper can catch (here a stack overflow on the way into a pass) must not leave the store
// thinking a pass is still running: that would silence every later notification. Each level of the recursion enters a
// pass a little closer to the stack limit, so one of them overflows between listeners.
test("an overflow escaping a pass does not silence later notifications", () => {
  const store = createRunStore((job) => job());
  let calls = 0;
  store.subscribe(() => { calls++; });
  let n = 0;
  const edge = (): void => {
    try { edge(); } catch {}
    try { store.resync(n++ % 2 ? [] : [commit("a")]); } catch {}
  };
  edge();
  calls = 0;
  store.resync([commit("final")]);
  expect(store.getDiagnostics().desynced).toBe(false);
  expect(calls).toBe(1);
});

// One rule: a flush asked for during a notification waits for the end of that pass; a scheduler that runs its job at
// once must not make the store spin. The probe runs in a child process so a spin fails the row instead of hanging.
const syncDispatch = [
  { entry: "resync", outline: ["message:a", "message:x"] },
  { entry: "beginHistory", outline: ["message:a", "message:x"] },
  { entry: "prepend", outline: ["message:b", "message:a", "message:x"] },
  { entry: "endHistory", outline: ["message:b", "message:x"] },
  { entry: "prepend from a listener", outline: ["message:b", "message:a", "message:c", "message:x"] },
  { entry: "endHistory from a listener", outline: ["message:b", "message:a", "message:c", "message:x"] },
  { entry: "dispatch during a reduction", outline: ["user:delivery:outer", "user:delivery:nested"] },
];
test.each(syncDispatch)("$entry with a synchronous scheduler: a listener's dispatch is delivered after the pass", ({ entry, outline }) => {
  const probe = Bun.spawnSync([process.execPath, new URL("./notify-probe.ts", import.meta.url).pathname, entry], { timeout: 3_000 });
  const result = probe.exitCode === 0 ? JSON.parse(probe.stdout.toString()) : { exitCode: probe.exitCode, signal: probe.signalCode, stderr: probe.stderr.toString() };
  expect(result).toEqual({ seen: outline, outline });
});

// Regression locks for the README notification contract: the history entries deliver their own pass and rethrow like
// the scheduler job and resync do, reads never surface a listener error, and the console fallback catches later errors.
test.each(["beginHistory", "prepend", "endHistory"] as const)("%s delivers every listener, rethrows the first error, and reports the rest", (entry) => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  if (entry !== "beginHistory") store.beginHistory();
  const calls: string[] = [];
  for (const name of ["first", "second", "third"]) store.subscribe(() => { calls.push(name); if (name !== "third") throw new Error(name); });
  store.dispatch(commit("a"));
  store.getState(); // reduced, not yet delivered: the entry's own pass delivers it
  const reported = spyOn(globalThis, "reportError").mockImplementation(() => {});
  try {
    expect(() => entry === "prepend" ? store.prepend([commit("b")]) : store[entry]()).toThrow("first");
    expect(calls).toEqual(["first", "second", "third"]);
    expect(reported.mock.calls.map(([error]) => (error as Error).message)).toEqual(["second"]);
  } finally {
    reported.mockRestore();
  }
});

test("read methods never throw a listener error, inside or after a failing pass", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  const readAll = () => {
    store.getState(); store.getItem("message:a"); store.getOutline(); store.getOutlineSnapshot();
    store.hasMessageDelivery("a"); store.getDiagnostics();
  };
  let readThrew = false;
  store.subscribe(() => { throw new Error("boom"); });
  store.subscribe(() => { try { readAll(); } catch { readThrew = true; } });
  store.dispatch(commit("a"));
  expect(jobs.shift()!).toThrow("boom");
  store.dispatch(commit("b"));
  expect(readAll).not.toThrow();
  expect(readThrew).toBe(false);
  expect(jobs.shift()!).toThrow("boom");
});

test("later listener errors go to console.error where reportError does not exist", () => {
  const store = createRunStore((job) => job());
  const restoreReportError = shimProperty(globalThis, "reportError");
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const name of ["first", "second"]) store.subscribe(() => { throw new Error(name); });
    expect(() => store.dispatch(commit("a"))).toThrow("first");
    expect(logged.mock.calls.map(([error]) => (error as Error).message)).toEqual(["second"]);
  } finally {
    restoreReportError();
    logged.mockRestore();
  }
});

// Diagnostics listeners and onError go through the same delivery owner as every other listener. A malformed event
// changes diagnostics during whichever call flushes it: a read must not throw, the other listeners still run, and the
// entry that delivers (the dispatch's scheduler job, or dispatch itself under a sync scheduler) rethrows the first error.
const malformed = { type: "message_commit" } as unknown as RunEvent;
test("a throwing diagnostics listener: reads never throw, the others still run, and the scheduler job rethrows", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  const calls: string[] = [];
  for (const name of ["first", "second"]) store.subscribeDiagnostics(() => { calls.push(name); if (name === "first") throw new Error("diag boom"); });
  store.dispatch(malformed);
  expect(() => store.getState()).not.toThrow();
  expect(calls).toEqual(["first", "second"]);
  expect(store.getDiagnostics().ignoredEvents).toBe(1);
  expect(jobs.shift()!).toThrow("diag boom");
  expect(() => store.getState()).not.toThrow();
});

test("a throwing diagnostics listener under a sync scheduler: dispatch rethrows after every listener ran", () => {
  const store = createRunStore((job) => job());
  const calls: string[] = [];
  for (const name of ["first", "second"]) store.subscribeDiagnostics(() => { calls.push(name); if (name === "first") throw new Error("diag boom"); });
  expect(() => store.dispatch(malformed)).toThrow("diag boom");
  expect(calls).toEqual(["first", "second"]);
  expect(store.getDiagnostics().ignoredEvents).toBe(1);
});

test("resyncFailed delivers every diagnostics listener, then rethrows the first error", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job), { onError() {} });
  store.dispatch(new Proxy({ type: "retry" }, { get(target, key, receiver) { if (key === "type") throw new Error("reduce"); return Reflect.get(target, key, receiver); } }) as RunEvent);
  jobs.shift()!();
  expect(store.getDiagnostics().desynced).toBe(true);
  const calls: string[] = [];
  for (const name of ["first", "second"]) store.subscribeDiagnostics(() => { calls.push(name); if (name === "first") throw new Error("diag boom"); });
  expect(() => store.resyncFailed(new Error("reload failed"))).toThrow("diag boom");
  expect(calls).toEqual(["first", "second"]);
  expect(store.getDiagnostics().resyncError).toBe("reload failed");
});

test("a throwing onError never escapes a read: the store still desyncs, and the scheduler job rethrows it", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job), { onError() { throw new Error("onError boom"); } });
  let diagnosticsCalls = 0;
  store.subscribeDiagnostics(() => diagnosticsCalls++);
  store.dispatch(new Proxy({ type: "retry" }, { get(target, key, receiver) { if (key === "type") throw new Error("reduce"); return Reflect.get(target, key, receiver); } }) as RunEvent);
  expect(() => store.getState()).not.toThrow();
  expect({ diagnosticsCalls, desynced: store.getDiagnostics().desynced }).toEqual({ diagnosticsCalls: 1, desynced: true });
  expect(jobs.shift()!).toThrow("onError boom");
});

test("a throwing onError on a rejected prepend page never escapes a read: the store desyncs, and the scheduler job rethrows it", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job), { onError() { throw new Error("onError boom"); } });
  store.beginHistory();
  store.prepend([new Proxy({ type: "retry" }, { get(target, key, receiver) { if (key === "type") throw new Error("reduce"); return Reflect.get(target, key, receiver); } }) as RunEvent]);
  expect(() => store.getState()).not.toThrow();
  expect(store.getDiagnostics()).toMatchObject({ desynced: true, reason: "reduce" });
  expect(jobs.shift()!).toThrow("onError boom");
});

// Formatting a thrown value runs host code too: a `message` getter, toString, or Proxy traps. The store desyncs first,
// and an unreadable value becomes a fixed reason, so reads, diagnostics, and onError still agree.
const throwingType = (thrown: () => unknown) =>
  new Proxy({ type: "retry" }, { get(target, key, receiver) { if (key === "type") throw thrown(); return Reflect.get(target, key, receiver); } }) as RunEvent;
const unreadable = [
  { name: "a null-prototype object", thrown: () => Object.create(null) as unknown },
  { name: "an Error whose message getter throws", thrown: () => Object.defineProperty(new Error("x"), "message", { get() { throw new Error("message getter"); } }) },
  { name: "a Proxy whose every trap throws", thrown: () => new Proxy({}, new Proxy({}, { get() { return () => { throw new Error("trap"); }; } })) },
  { name: "a revoked Proxy", thrown: () => { const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); return proxy; } },
  { name: "a Symbol.toPrimitive that throws", thrown: () => ({ [Symbol.toPrimitive]() { throw new Error("primitive"); } }) },
];
test.each(unreadable)("an unreadable thrown value: reads never throw, diagnostics say desynced, and onError runs once: $name", ({ thrown }) => {
  const jobs: Array<() => void> = [];
  const errors: unknown[] = [];
  const seen: StoreDiagnostics[] = [];
  const store: RunStore = createRunStore((job) => jobs.push(job), { onError: (error) => { errors.push(error); seen.push(store.getDiagnostics()); } });
  const value = thrown();
  store.dispatch(throwingType(() => value));
  expect(() => store.getState()).not.toThrow();
  expect(store.getDiagnostics()).toMatchObject({ desynced: true, reason: "unreadable error" });
  expect(seen).toEqual([store.getDiagnostics()]); // onError runs after the desync is published
  expect(errors.length).toBe(1);
  expect(errors[0]).toBe(value);
  expect(jobs.shift()!).not.toThrow();
  expect(() => store.resyncFailed(value)).not.toThrow();
  expect(store.getDiagnostics().resyncError).toBe("unreadable error");
});

test("hasMessageDelivery formats only a string id: a non-string argument runs no host code", () => {
  const store = createRunStore((job) => job());
  let ran = 0;
  const hostile = { toString() { ran++; return "a"; }, [Symbol.toPrimitive]() { ran++; return "a"; } };
  expect(store.hasMessageDelivery(hostile as unknown as string)).toBe(false);
  expect(store.hasMessageDelivery(Symbol("s") as unknown as string)).toBe(false);
  expect(ran).toBe(0);
});

test("options.onError is read once, at creation: a getter cannot throw from a read", () => {
  const jobs: Array<() => void> = [];
  const errors: unknown[] = [];
  let created = false;
  const store = createRunStore((job) => jobs.push(job), {
    get onError() {
      if (created) throw new Error("onError getter");
      return (error: unknown) => { errors.push(error); };
    },
  });
  created = true;
  store.dispatch(throwingType(() => new Error("reduce")));
  expect(() => store.getState()).not.toThrow();
  expect(store.getDiagnostics()).toMatchObject({ desynced: true, reason: "reduce" });
  expect(errors.map((error) => (error as Error).message)).toEqual(["reduce"]);
  expect(jobs.shift()!).not.toThrow();
});

// The events argument is plain data, but a throwing iterator is host code: it reaches the caller before any change.
const throwingIterator = { [Symbol.iterator]() { throw new Error("iterator"); } } as unknown as RunEvent[];
test.each(["resync", "prepend"] as const)("a throwing events iterator: %s throws to its caller and changes nothing", (entry) => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  store.beginHistory();
  store.resync([commit("a")]);
  const state = store.getState();
  const snapshot = store.getOutlineSnapshot();
  const diagnostics = store.getDiagnostics();
  let calls = 0;
  store.subscribe(() => calls++);
  store.dispatch(commit("b")); // queued, not reduced: the throwing entry must not flush or deliver it
  expect(() => store[entry](throwingIterator)).toThrow("iterator");
  expect(calls).toBe(0);
  expect(jobs).toHaveLength(1);
  expect(store.getDiagnostics()).toBe(diagnostics);
  expect(ids(snapshot.items)).toEqual(["message:a"]);
  expect(state.outline).toBe(snapshot.items);
  jobs.shift()!();
  expect({ calls, outline: ids(store.getOutline()) }).toEqual({ calls: 1, outline: ["message:a", "message:b"] });
});

test("prepend reuses the compact tool snapshot without reading tool arguments again", () => {
  const jobs: Array<() => void> = [];
  const errors: unknown[] = [];
  const store = createRunStore((job) => jobs.push(job), { onError: (error) => errors.push(error) });
  // The accepted tool snapshot owns replay; history paging must not inspect this host object a second time.
  const args = () => new Proxy({}, { ownKeys() { throw new Error("ownKeys trap"); } });
  store.beginHistory();
  store.dispatch({ type: "tool_start", get tool_call() { return { id: "t", name: "x", arguments: args() }; } } as RunEvent);
  jobs.shift()!();
  store.prepend([commit("b")]);
  expect(() => store.getState()).not.toThrow();
  expect(store.getDiagnostics()).toMatchObject({ desynced: false });
  expect(errors).toEqual([]);
  expect(ids(store.getOutline())).toEqual(["message:b", "tool:t"]);
  expect(jobs.shift()!).not.toThrow();
});

// The host's error sink (reportError, or console.error where it does not exist) is host code too. A sink that throws,
// like a fail-on-console test setup, must not cut a pass short, replace the first error, or leave it for a later job.
const throwingSinks = [
  { sink: "reportError", install: () => spyOn(globalThis, "reportError").mockImplementation(() => { throw new Error("sink"); }), restore: () => {} },
  {
    sink: "console.error",
    install: () => {
      const restoreReportError = shimProperty(globalThis, "reportError");
      const spy = spyOn(console, "error").mockImplementation(() => { throw new Error("sink"); });
      return { mockRestore: () => { spy.mockRestore(); restoreReportError(); } };
    },
  },
];
test.each(throwingSinks)("a throwing $sink: every listener runs, the job rethrows the first error, and reads never throw", ({ install }) => {
  const sinkSpy = install();
  try {
    const jobs: Array<() => void> = [];
    const store = createRunStore((job) => jobs.push(job));
    const calls: string[] = [];
    let throwing = true;
    for (const name of ["a", "b", "c"]) store.subscribe(() => { calls.push(name); if (throwing && name !== "c") throw new Error(name); });
    for (const name of ["d1", "d2"]) store.subscribeDiagnostics(() => { if (throwing) throw new Error(name); });
    store.dispatch(commit("a"));
    expect(jobs.shift()!).toThrow("a");
    expect(calls).toEqual(["a", "b", "c"]);
    store.dispatch(malformed);
    expect(() => store.getState()).not.toThrow();
    expect(jobs.shift()!).toThrow("d1");
    throwing = false;
    calls.length = 0;
    store.dispatch(commit("b"));
    expect(jobs.shift()!).not.toThrow();
    expect(calls).toEqual(["a", "b", "c"]);
  } finally {
    sinkSpy.mockRestore();
  }
});

// A throw escaping the host's scheduler reaches the caller, but must not leave a job marked as queued: that would
// silence every later dispatch, like a pass flag left set.
test("a throwing scheduler does not stop later dispatches from scheduling", () => {
  const jobs: Array<() => void> = [];
  let refuse = true;
  const store = createRunStore((job) => { if (refuse) throw new Error("scheduler boom"); jobs.push(job); });
  expect(() => store.dispatch(commit("a"))).toThrow("scheduler boom");
  refuse = false;
  store.dispatch(commit("b"));
  expect(jobs).toHaveLength(1);
  jobs.shift()!();
  expect(ids(store.getOutline())).toEqual(["message:a", "message:b"]);
});

test("dispose publishes an empty outline, notifies no one after, and every later entry throws or does nothing", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  store.dispatch(commit("a"));
  jobs.shift()!();
  store.beginHistory();
  let calls = 0;
  store.subscribe(() => calls++);
  store.subscribeOutline(() => calls++);
  store.subscribe("message:a", () => calls++);
  store.prepend([commit("b")]);
  store.dispose();
  while (jobs.length > 0) jobs.shift()!();
  expect({ calls, snapshot: store.getOutlineSnapshot() }).toEqual({ calls: 0, snapshot: { items: [], change: null } });
  expect(() => store.dispatch(commit("c"))).toThrow("store is disposed");
  expect(() => store.resync([commit("c")])).toThrow("store is disposed");
  expect(() => store.beginHistory()).toThrow("store is disposed");
  expect(() => store.prepend([commit("c")])).toThrow("store is disposed");
  expect(() => { store.endHistory(); store.dispose(); }).not.toThrow();
  expect(calls).toBe(0);
});

// dispose from a listener stops the rest of the running pass: no global, outline, keyed, or diagnostics listener runs
// after it.
test("dispose from a listener stops the rest of the pass: global, outline, keyed", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  const calls: string[] = [];
  store.subscribe(() => { calls.push("first"); store.dispose(); });
  store.subscribe(() => calls.push("second"));
  store.subscribeOutline(() => calls.push("outline"));
  store.subscribe("message:a", () => calls.push("keyed"));
  store.dispatch(commit("a"));
  jobs.shift()!();
  expect(calls).toEqual(["first"]);
});

test("dispose from a diagnostics listener stops the rest of the pass: diagnostics", () => {
  const store = createRunStore((job) => job());
  const calls: string[] = [];
  store.subscribeDiagnostics(() => { calls.push("first"); store.dispose(); });
  store.subscribeDiagnostics(() => calls.push("second"));
  store.dispatch(malformed);
  expect(calls).toEqual(["first"]);
});

// A listener error that a read flushed belongs to the job the dispatch queued; dispose drops that job's work, so the
// error goes to the host's error report instead of surfacing from a job after dispose.
test("dispose hands an undelivered listener error to reportError, and no job rethrows it after dispose", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  store.subscribeDiagnostics(() => { throw new Error("diag boom"); });
  store.dispatch(malformed);
  store.getState();
  const reported = spyOn(globalThis, "reportError").mockImplementation(() => {});
  try {
    store.dispose();
    expect(jobs.shift()!).not.toThrow();
    expect(reported.mock.calls.map(([error]) => (error as Error).message)).toEqual(["diag boom"]);
  } finally {
    reported.mockRestore();
  }
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

test("interleaved prepend and live flushes match chronological reduction", () => {
  const jobs: Array<() => void> = [];
  const actual = createRunStore((job) => jobs.push(job));
  actual.beginHistory();
  actual.prepend([{ type: "message_commit", message_id: "middle", message: message("middle") }]);
  actual.dispatch({ type: "message_commit", message_id: "new", message: message("new") });
  jobs.shift()!();
  actual.prepend([{ type: "message_commit", message_id: "old", message: message("old") }]);

  const expected = createRunStore((flush) => flush());
  expected.resync([
    { type: "message_commit", message_id: "old", message: message("old") },
    { type: "message_commit", message_id: "middle", message: message("middle") },
    { type: "message_commit", message_id: "new", message: message("new") },
  ]);
  expect(prependView(actual)).toEqual(prependView(expected));
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

// A seam bug depends on the events on each side of the cut: which kind they are and whether the cut splits one stream,
// tool, approval, or sub-agent. That shape is the coverage unit, so a seed runs every split only while it still shows a
// shape seen fewer than SHAPE_SEEDS times; the others get one random split. (#58 ran every split of all 1,100 seeds:
// ~31,000 store runs, 4 s alone, a timeout under load, and no shape the selected seeds miss.)
const SHAPE_SEEDS = 5;
const seamOwner = (event: Record<string, any> | undefined): unknown =>
  event?.message_id ?? event?.tool_call?.id ?? event?.request_id ?? event?.childRunId ?? event?.data?.turn;
const seamSide = (event: Record<string, any> | undefined, before: Record<string, any> | undefined) => {
  if (!event) return "edge";
  if (event.type === "message_delta") return `delta:${event.kind}`;
  if (event.type === "turn_end") return `turn_end:${before?.type}`;
  if (event.type === "approval_end") return `approval_end:${event.decision}`;
  if (event.type === "sub_agent") return `sub_agent:${event.status}`;
  return event.type as string;
};
const seamShape = (events: readonly Record<string, any>[], split: number) => {
  const older = events[split - 1], newer = events[split];
  const inside = seamOwner(older) !== undefined && seamOwner(older) === seamOwner(newer);
  return `${seamSide(older, events[split - 2])}>${seamSide(newer, older)}${inside ? ":inside" : ""}`;
};

test("prepend equals whole-log reduction at every page seam shape", () => {
  const shapeSeeds = new Map<string, number>();
  // `queued` holds every page for one frame, so they reach the store as one coalesced prepend (#98).
  const expectSplits = (events: RunEvent[], splits: readonly number[], expectedView: ReturnType<typeof prependView>, label: string, queued = false) => {
    const frames: Array<() => void> = [];
    const actual = createRunStore(queued ? (flush) => frames.push(flush) : (flush) => flush());
    actual.beginHistory();
    actual.resync(events.slice(splits[0]));
    for (let page = 1; page <= splits.length; page++) actual.prepend(events.slice(splits[page] ?? 0, splits[page - 1]));
    while (frames.length > 0) frames.shift()!();
    expect(prependView(actual), `${label}${queued ? " queued" : ""}, splits ${splits.join("/")}`).toEqual(expectedView);
  };
  for (let seed = 10_001; seed <= 11_100; seed++) {
    const events = generatedHistory(seed);
    const expected = createRunStore((flush) => flush());
    expected.resync(events);
    const expectedView = prependView(expected);
    const shapes = new Set(Array.from({ length: events.length + 1 }, (_, split) => seamShape(events, split)));
    if ([...shapes].some((shape) => (shapeSeeds.get(shape) ?? 0) < SHAPE_SEEDS)) {
      for (const shape of shapes) shapeSeeds.set(shape, (shapeSeeds.get(shape) ?? 0) + 1);
      for (let split = 0; split <= events.length; split++) expectSplits(events, [split], expectedView, `seed ${seed}`);
    } else {
      expectSplits(events, [(seed * 7) % (events.length + 1)], expectedView, `seed ${seed}`);
    }
    const first = seed % (events.length + 1);
    const second = first + seed % (events.length - first + 1);
    expectSplits(events, [second, first], expectedView, `seed ${seed}`);
    expectSplits(events, [second, first], expectedView, `seed ${seed}`, true);
  }
  // Every shape these seeds produce, each seen in at least SHAPE_SEEDS seeds that ran all their splits. The count and the
  // named sub-variant shapes catch a generator that silently lost one; when the generator changes on purpose, update both.
  const requiredShapes = [
    "delta:text>delta:text:inside",
    "delta:reasoning>delta:reasoning:inside",
    "delta:text>message_commit:inside",
    "tool_start>tool_input:inside",
    "tool_input>tool_end:inside",
    "approval_request>approval_end:approve:inside",
    "approval_request>approval_end:deny:inside",
    "sub_agent:running>sub_agent:done:inside",
  ];
  expect(requiredShapes.filter((shape) => !shapeSeeds.has(shape)), "missing seam shapes").toEqual([]);
  expect(shapeSeeds.size, "seam shape count").toBe(138);
  expect([...shapeSeeds].filter(([, seeds]) => seeds < SHAPE_SEEDS), "shapes in too few seeds").toEqual([]);
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

test("prepend copies its input so later caller mutation cannot change queued history", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((flush) => jobs.push(flush));
  store.beginHistory();
  const page: RunEvent[] = [{ type: "message_commit", message_id: "old", message: message("old") }];
  store.prepend(page);
  page.push({ type: "message_commit", message_id: "injected", message: message("injected") });
  jobs.shift()!();
  expect(store.getOutline().map(({ id }) => id)).toEqual(["message:old"]);
});

test("resync drops prepend pages still queued for the next frame", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((flush) => jobs.push(flush));
  store.beginHistory();
  store.prepend([{ type: "message_commit", message_id: "stale", message: message("stale") }]);
  store.resync([{ type: "message_commit", message_id: "fresh", message: message("fresh") }]);
  for (const job of jobs.splice(0)) job();
  expect(store.getOutline().map(({ id }) => id)).toEqual(["message:fresh"]);
});

// Spreading a page into push() passes every event as a call argument; Bun 1.4.4 throws RangeError near 700k.
const hugePage = (): RunEvent[] => new Array(1_000_000).fill({ type: "message_delta", message_id: "huge", delta: "x" });

test("a 1,000,000-event history page prepends without exceeding the call argument limit", () => {
  const store = createRunStore((flush) => flush());
  store.beginHistory();
  store.prepend(hugePage());
  expect((store.getItem("message:huge") as { text: string }).text).toHaveLength(1_000_000);
});

test("a 1,000,000-event resync inside a history window applies without exceeding the call argument limit", () => {
  const store = createRunStore((flush) => flush());
  store.beginHistory();
  store.resync(hugePage());
  expect((store.getItem("message:huge") as { text: string }).text).toHaveLength(1_000_000);
});
