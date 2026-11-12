import { expect, test } from "bun:test";
import { createRunStore, type RunEvent, type RunItem } from "../src/index.js";
import { streamTail } from "../src/internal.js";
import { retainedText } from "../src/text-source.js";

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

test("held tool source snapshots keep their own retained text", () => {
  const store = run(out("a"));
  const first = tool(store);
  store.dispatch(out("b"));
  const second = tool(store);
  store.dispatch(out("c"));
  const third = tool(store);
  expect(retainedText(first.output)).toBe("a");
  expect(retainedText(second.output)).toBe("ab");
  expect(retainedText(third.output)).toBe("abc");
  expect(first.output).not.toBe(second.output);
});

test("replace and restart create independent tool sources", () => {
  const store = run(out("abc"));
  const before = tool(store).output;
  store.dispatch(out("x", true));
  const replaced = tool(store).output;
  store.dispatch({ type: "tool_start", tool_call: call });
  store.dispatch(out("z"));
  const restarted = tool(store).output;
  expect([retainedText(before), retainedText(replaced), retainedText(restarted)]).toEqual(["abc", "x", "z"]);
  expect(new Set([before, replaced, restarted]).size).toBe(3);
});

test("tool_end keeps the same retained output when the result repeats it", () => {
  const store = run(out("abc"));
  const live = tool(store);
  store.dispatch({ type: "tool_end", tool_call: call, tool_result: { tool_call_id: "t", content: "abc", is_error: false } });
  const ended = tool(store);
  expect(ended.active).toBe(false);
  expect(retainedText(ended.output)).toBe("abc");
  expect(ended.output).toBe(live.output);
  expect(ended.result?.relation).toBe("same");
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
