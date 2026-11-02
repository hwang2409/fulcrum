import { expect, test } from "bun:test";
import { createRunStore } from "../src/index.js";
test("coalesces a burst", () => { const jobs: (() => void)[] = []; const store = createRunStore(undefined, cb => { jobs.push(cb); }); let calls = 0; store.subscribe(() => calls++); for (let i = 0; i < 100; i++) store.dispatch({ type: "message_delta", delta: "x" }); expect(calls).toBe(0); expect(jobs).toHaveLength(1); jobs[0](); expect(calls).toBe(1); });
