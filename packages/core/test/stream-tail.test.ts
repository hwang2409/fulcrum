import { expect, test } from "bun:test";
import { createRunStore, streamTail, type RunEvent, type RunItem } from "../src/index.js";

const call = { id: "t", name: "bash", arguments: {} };
const out = (output: string, replace?: boolean): RunEvent => ({ type: "tool_output", tool_call: call, output, ...(replace ? { replace } : {}) });
const tool = (store: ReturnType<typeof createRunStore>) => store.getItem("tool:t") as RunItem & { output: string };

function run(...events: RunEvent[]) {
  const store = createRunStore((job) => job());
  store.dispatch({ type: "tool_start", tool_call: call });
  events.forEach(store.dispatch);
  return store;
}

test("streamTail is the appended text across appends, for the newest and for held older snapshots", () => {
  const store = run(out("a"));
  const first = tool(store);
  store.dispatch(out("b"));
  store.dispatch(out("\ud83d"));
  const second = tool(store);
  store.dispatch(out("\ude00c"));
  const third = tool(store);
  expect(streamTail(first, second)).toBe("b\ud83d");
  expect(streamTail(second, third)).toBe("\ude00c");
  expect(streamTail(first, third)).toBe("b\ud83d\ude00c");
  expect(streamTail(third, third)).toBe("");
  // An older snapshot is not an append of a newer one.
  expect(streamTail(third, first)).toBeUndefined();
  // Read after a newer one, an older snapshot still has its own text.
  expect(third.output).toBe("ab\ud83d\ude00c");
  expect(first.output).toBe("a");
  expect(second.output).toBe("ab\ud83d");
});

test("streamTail is undefined across a replace, a restart, a resync, and other rows", () => {
  const message = (text: string): RunEvent => ({ type: "message_delta", message_id: "m", delta: text });
  const store = run(out("abc"));
  const before = tool(store);
  store.dispatch(out("x", true));
  const replaced = tool(store);
  expect(streamTail(before, replaced)).toBeUndefined();
  store.dispatch(out("y"));
  expect(streamTail(replaced, tool(store))).toBe("y");
  const beforeRestart = tool(store);
  store.dispatch({ type: "tool_start", tool_call: call });
  store.dispatch(out("z"));
  expect(streamTail(beforeRestart, tool(store))).toBeUndefined();
  const beforeResync = tool(store);
  store.resync([{ type: "tool_start", tool_call: call }, out("z"), out("w")]);
  expect(streamTail(beforeResync, tool(store))).toBeUndefined();
  expect(streamTail(undefined, tool(store))).toBeUndefined();
  store.dispatch(message("hi"));
  expect(streamTail(store.getItem("message:m"), tool(store))).toBeUndefined();
});

test("tool_end keeps the stream: its output is an empty append", () => {
  const store = run(out("abc"));
  const live = tool(store);
  store.dispatch({ type: "tool_end", tool_call: call, tool_result: { tool_call_id: "t", content: "abc", is_error: false } });
  const ended = tool(store);
  expect(ended.active).toBe(false);
  expect(ended.output).toBe("abc");
  // A consumer reading tails across the end gets "" (nothing new), not undefined (read it all again).
  expect(streamTail(live, ended)).toBe("");
  expect(JSON.parse(JSON.stringify(ended)).output).toBe("abc");
});

test("streamTail costs the chunks since the previous snapshot, not the whole stream", () => {
  // 1,000 chunks since `previous` in both streams, so each call does measurable work; only the stream before differs.
  const timed = (before: number) => {
    const store = run();
    for (let index = 0; index < before; index++) store.dispatch(out("x"));
    const previous = tool(store);
    for (let index = 0; index < 1_000; index++) store.dispatch(out("y"));
    const item = tool(store);
    expect(streamTail(previous, item)).toBe("y".repeat(1_000));
    Bun.gc(true); // the 200,000 dispatches leave garbage; collect it outside the timed loop
    const started = performance.now();
    for (let index = 0; index < 500; index++) streamTail(previous, item);
    return performance.now() - started;
  };
  timed(1_000); // warm up
  const small = timed(6_250);
  const large = timed(200_000);
  // 32x the stream before; a walk of the whole chain grows ~32x. The limit is near the geometric middle (sqrt 32 ~ 5.7).
  console.log(`streamTail: ${small.toFixed(2)} ms at 6,250 chunks before, ${large.toFixed(2)} ms at 200,000`);
  expect(small).toBeGreaterThan(0);
  expect(large / small).toBeLessThan(5.7);
});

test("a message's text is its one stream; a reasoning delta in between is not part of it", () => {
  const store = createRunStore((job) => job());
  const delta = (text: string, kind?: string): RunEvent => ({ type: "message_delta", message_id: "m", delta: text, ...(kind ? { kind } : {}) });
  store.dispatch(delta("hel"));
  const first = store.getItem("message:m");
  store.dispatch(delta("lo"));
  const second = store.getItem("message:m");
  expect(streamTail(first, second)).toBe("lo");
  store.dispatch(delta("thinking", "reasoning"));
  const reasoning = store.getItem("message:m");
  expect(streamTail(second, reasoning)).toBeUndefined();
  store.dispatch(delta(" world"));
  expect(streamTail(reasoning, store.getItem("message:m"))).toBeUndefined();
});
