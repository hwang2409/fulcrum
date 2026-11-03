import { expect, test } from "bun:test";
import { createRunStore, type OutlineSnapshot } from "../src/index.js";

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
  });
  expect(reads).toBeLessThan(10);
});
