import { expect, test } from "bun:test";
import { createRunStore, streamTail, type RunEvent, type RunItem } from "../src/index.js";

type ToolItem = Extract<RunItem, { type: "tool" }>;
type MessageItem = Extract<RunItem, { type: "message" }>;
const call = { id: "t", name: "bash", arguments: {} };
const out = (output: string, replace?: boolean): RunEvent => ({ type: "tool_output", tool_call: call, output, ...(replace ? { replace } : {}) });
const tool = (store: ReturnType<typeof createRunStore>) => store.getItem("tool:t") as ToolItem;
const message = (store: ReturnType<typeof createRunStore>) => store.getItem("message:m") as MessageItem;
const delta = (text: string, kind?: string): RunEvent => ({ type: "message_delta", message_id: "m", delta: text, ...(kind ? { kind } : {}) });

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
  expect(streamTail(first, second, "output")).toBe("b\ud83d");
  expect(streamTail(second, third, "output")).toBe("\ude00c");
  expect(streamTail(first, third, "output")).toBe("b\ud83d\ude00c");
  expect(streamTail(third, third, "output")).toBe("");
  // An older snapshot is not an append of a newer one.
  expect(streamTail(third, first, "output")).toBeUndefined();
  // Read after a newer one, an older snapshot still has its own text.
  expect(third.output).toBe("ab\ud83d\ude00c");
  expect(first.output).toBe("a");
  expect(second.output).toBe("ab\ud83d");
});

test("streamTail is undefined across a replace, a restart, a resync, another row, and another field", () => {
  const store = run(out("abc"));
  const before = tool(store);
  store.dispatch(out("x", true));
  const replaced = tool(store);
  expect(streamTail(before, replaced, "output")).toBeUndefined();
  store.dispatch(out("y"));
  expect(streamTail(replaced, tool(store), "output")).toBe("y");
  const beforeRestart = tool(store);
  store.dispatch({ type: "tool_start", tool_call: call });
  store.dispatch(out("z"));
  expect(streamTail(beforeRestart, tool(store), "output")).toBeUndefined();
  const beforeResync = tool(store);
  store.resync([{ type: "tool_start", tool_call: call }, out("z"), out("w")]);
  expect(streamTail(beforeResync, tool(store), "output")).toBeUndefined();
  expect(streamTail(undefined, tool(store), "output")).toBeUndefined();
  store.dispatch(delta("hi"));
  store.dispatch(delta("!"));
  // The overloads reject both at compile time; at run time each field has its own chains.
  expect(streamTail(message(store) as never, tool(store), "output")).toBeUndefined();
  expect(streamTail(tool(store) as never, tool(store) as never, "text")).toBeUndefined();
});

test("tool_end keeps the stream: its output is an empty append", () => {
  const store = run(out("abc"));
  const live = tool(store);
  store.dispatch({ type: "tool_end", tool_call: call, tool_result: { tool_call_id: "t", content: "abc", is_error: false } });
  const ended = tool(store);
  expect(ended.active).toBe(false);
  expect(ended.output).toBe("abc");
  // A consumer reading tails across the end gets "" (nothing new), not undefined (read it all again).
  expect(streamTail(live, ended, "output")).toBe("");
  expect(JSON.parse(JSON.stringify(ended)).output).toBe("abc");
});

test("a message's text is its stream; a reasoning delta in between is a content block, not part of it", () => {
  const store = createRunStore((job) => job());
  store.dispatch(delta("hel"));
  const first = message(store);
  store.dispatch(delta("lo"));
  const second = message(store);
  expect(streamTail(first, second, "text")).toBe("lo");
  store.dispatch(delta("thinking", "reasoning"));
  const reasoning = message(store);
  expect(reasoning.message.content.map((block) => block.type)).toEqual(["text", "reasoning"]);
  expect(streamTail(second, reasoning, "text")).toBeUndefined();
  store.dispatch(delta(" world"));
  expect(streamTail(reasoning, message(store), "text")).toBeUndefined();
});

// Test-only count of the chunks streamTail walks: it pushes each walked chunk's value once (Array.prototype.push).
function walked(run: () => unknown) {
  const push = Array.prototype.push;
  let count = 0;
  Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
    count += items.length;
    return push.apply(this, items);
  };
  try {
    run();
  } finally {
    Array.prototype.push = push;
  }
  return count;
}

test("streamTail walks exactly the chunks since the previous snapshot, whatever the stream's length (32x span)", () => {
  const work = (before: number, since: number) => {
    const store = run();
    for (let index = 0; index < before; index++) store.dispatch(out("x"));
    const previous = tool(store);
    for (let index = 0; index < since; index++) store.dispatch(out("y"));
    const item = tool(store);
    let tail: string | undefined;
    const count = walked(() => { tail = streamTail(previous, item, "output"); });
    expect(tail).toBe("y".repeat(since));
    // A stream that does not continue `previous` is rejected without a walk.
    expect(walked(() => streamTail(item, previous, "output"))).toBe(0);
    return count;
  };
  expect(work(6_250, 10)).toBe(10);
  expect(work(200_000, 10)).toBe(10);
  expect(work(200_000, 1)).toBe(1);
  expect(work(200_000, 0)).toBe(0);
});
