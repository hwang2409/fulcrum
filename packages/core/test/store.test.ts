import { expect, test } from "bun:test";
import { createRunStore } from "../src/index.js";

test("100 dispatches in one burst notify subscribers exactly once", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore(undefined, (job) => jobs.push(job));
  let calls = 0;
  store.subscribe(() => calls++);

  for (let i = 0; i < 100; i++) store.dispatch({ type: "message_delta", delta: "x" });

  expect(calls).toBe(0);
  expect(jobs).toHaveLength(1);
  jobs[0]();
  expect(calls).toBe(1);
});
