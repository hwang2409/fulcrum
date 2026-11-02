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

  store.dispatch({ type: "message_delta", message_id: "c", delta: "c" });
  jobs.shift()!();
  store.dispatch({ type: "message_reset" });
  jobs.shift()!();
  expect(store.getOutlineSnapshot()).toMatchObject({ change: null });
});

test("dispose publishes once, drops pending chunks, and rejects dispatch", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  let calls = 0;
  store.subscribe("message:a", () => calls++);
  store.dispatch({ type: "message_delta", message_id: "a", delta: "queued" });
  store.dispose();
  jobs.shift()!();

  expect(calls).toBe(1);
  expect(store.getItem("message:a")).toBeUndefined();
  expect(() => store.dispatch({ type: "message_delta", message_id: "a", delta: "late" })).toThrow(
    "store is disposed",
  );
});
