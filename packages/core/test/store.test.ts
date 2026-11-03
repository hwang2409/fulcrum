import { expect, test } from "bun:test";
import { createRunStore } from "../src/index.js";

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

test("outline snapshots describe batched appends and structural deletion", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  store.dispatch({ type: "message_commit", message_id: "a", message: message("a") });
  store.dispatch({ type: "message_commit", message_id: "b", message: message("b") });
  jobs.shift()!();
  expect(store.getOutlineSnapshot()).toMatchObject({ change: { type: "append", count: 2 } });

  store.dispatch({ type: "message_commit", message_id: "forced-a", message: message("a") });
  store.getOutline();
  store.dispatch({ type: "message_commit", message_id: "forced-b", message: message("b") });
  expect(store.getOutlineSnapshot()).toMatchObject({ change: { type: "append", count: 2 } });
  jobs.shift()!();

  store.dispatch({ type: "message_delta", message_id: "c", delta: "c" });
  jobs.shift()!();
  store.dispatch({ type: "message_reset" });
  jobs.shift()!();
  expect(store.getOutlineSnapshot()).toMatchObject({ change: null });
});

test("an outline rewritten in place is a full change, even when its length holds or grows in the same frame", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  const read = { id: "read-1", name: "read", arguments: { path: "README.md" } };
  store.dispatch({ type: "approval_request", request_id: "read-1", tool_call: read, delegated: false });
  store.dispatch({ type: "approval_end", request_id: "read-1", decision: "approve" });
  jobs.shift()!();
  // The tool's row takes the approval's place: same length, a new entry at index 0.
  store.dispatch({ type: "tool_start", tool_call: read });
  jobs.shift()!();
  expect(store.getOutlineSnapshot()).toMatchObject({ items: [{ id: "tool:read-1" }], change: null });
  // A fold and an append in one frame are still not an append.
  const bash = { id: "bash-2", name: "bash", arguments: { command: "ls" } };
  store.dispatch({ type: "approval_request", request_id: "bash-2", tool_call: bash, delegated: false });
  jobs.shift()!();
  store.dispatch({ type: "approval_end", request_id: "bash-2", decision: "approve" });
  store.dispatch({ type: "tool_start", tool_call: bash });
  store.dispatch({ type: "message_commit", message_id: "after", message: message("after") });
  jobs.shift()!();
  expect(store.getOutlineSnapshot()).toMatchObject({ change: null });
  expect(store.getOutline().map(({ id }) => id)).toEqual(["tool:read-1", "tool:bash-2", "message:after"]);
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
