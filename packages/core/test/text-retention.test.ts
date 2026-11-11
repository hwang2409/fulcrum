import { expect, test } from "bun:test";
import { createRunStore, type RunEvent, type RunItem } from "../src/index.js";

type Source = {
  length: number; bytes: number; retainedBytes: number; lines: number; protocolTruncated: boolean;
  omission: null | { kind: "omitted"; reason: "item-cap" | "run-cap"; bytes: number; whole: boolean; start: number; end: number };
  chunks(): IterableIterator<{ start: number; line: number; text: string }>;
};
type Tool = Extract<RunItem, { type: "tool" }>;
const tool = (store: ReturnType<typeof createRunStore>, id: string) => {
  const item = store.getItem(`tool:${id}`);
  if (item?.type !== "tool") throw new Error(`missing tool ${id}`);
  return item;
};
const source = (value: unknown) => value as Source;
const text = (value: unknown) => [...source(value).chunks()].map((chunk) => chunk.text).join("");
const call = (id: string) => ({ id, name: `tool-${id}`, arguments: {} });
const output = (id: string, value: string, replace = false): RunEvent => ({ type: "tool_output", tool_call: call(id), output: value, replace });
const end = (id: string, is_error = false, content = ""): RunEvent => ({ type: "tool_end", tool_call: call(id), tool_result: { tool_call_id: id, content, is_error } });
const retained = (item: Tool) => {
  const values: Source[] = [source(item.output)];
  const view = item.view;
  if (view?.kind === "shell") { if (view.stdout) values.push(source(view.stdout)); if (view.stderr) values.push(source(view.stderr)); }
  if (view?.kind === "edit") values.push(source(view.diff));
  if (view?.kind === "write" && view.content) values.push(source(view.content));
  if (view?.kind === "search") for (const match of view.matches ?? []) values.push(source(match));
  if (item.result?.finalContent) values.push(source(item.result.finalContent));
  for (const block of item.result?.blocks ?? []) if (block.text) values.push(source(block.text));
  return values.reduce((sum, value) => sum + value.retainedBytes, 0);
};

test("oversized output is a bounded immutable source with a head, tail, and explicit cut", () => {
  const store = createRunStore((flush) => flush(), { toolOutputItemBytes: 100, toolOutputRunBytes: 1_000 });
  store.dispatch(output("large", `HEAD${"x".repeat(200)}TAIL`));
  const item = tool(store, "large");
  // Fail-first on c04b167: old core publishes the original unbounded string here.
  expect(typeof item.output, "tool output must be a bounded source, not an unbounded string").toBe("object");
  const value = source(item.output);
  expect(value.retainedBytes).toBeLessThanOrEqual(100);
  expect(value.omission).toMatchObject({ kind: "omitted", reason: "item-cap", whole: false });
  expect(text(value).startsWith("HEAD")).toBe(true);
  expect(text(value).endsWith("TAIL")).toBe(true);
  expect(value.bytes - value.retainedBytes).toBe(value.omission!.bytes);
  expect([...value.chunks()].every((chunk) => new TextEncoder().encode(chunk.text).byteLength <= 32 * 1024)).toBe(true);
});

test("item accounting covers every output-bearing view and result source", () => {
  const cap = 256;
  const store = createRunStore((flush) => flush(), { toolOutputItemBytes: cap, toolOutputRunBytes: 10_000 });
  const big = "v".repeat(300);
  store.dispatch({ type: "tool_output", tool_call: call("all"), output: big, view: { kind: "shell", command: "run", stdout: big, stderr: big } });
  store.dispatch({ type: "tool_end", tool_call: call("all"), resultContent: "auto", tool_result: { tool_call_id: "all", content: big, is_error: false, blocks: [{ type: "text", text: big }] } });
  const item = tool(store, "all");
  expect(retained(item)).toBeLessThanOrEqual(cap);
  expect(item.result?.relation).toBe("unknown");
  expect(item.result?.finalContent?.omission).not.toBeNull();
  expect(item.result?.blocks?.[0]?.metadata).toEqual({ type: "text" });
  expect(item.result?.blocks?.[0]?.text).toBeDefined();
});

test("run eviction is oldest-first and protects running, failed, non-zero, and newest completed tools", () => {
  const store = createRunStore((flush) => flush(), { toolOutputItemBytes: 100, toolOutputRunBytes: 350 });
  for (let index = 0; index < 8; index++) {
    const id = String(index);
    const view = index === 2 ? { kind: "shell" as const, command: "bad", exitCode: 2 } : undefined;
    store.dispatch({ type: "tool_output", tool_call: call(id), output: id.repeat(100), view });
    if (index !== 3) store.dispatch(end(id, index === 1));
  }
  expect(source(tool(store, "0").output).omission).toMatchObject({ reason: "run-cap", whole: true });
  expect(source(tool(store, "4").output).omission).toMatchObject({ reason: "run-cap", whole: true });
  expect(retained(tool(store, "1"))).toBe(100);
  expect(retained(tool(store, "2"))).toBe(100);
  expect(retained(tool(store, "3"))).toBe(100);
  expect([5, 6, 7].map((id) => retained(tool(store, String(id))))).toEqual([100, 100, 100]);
  // The cap is soft because six protected bodies alone exceed it.
  expect([1, 2, 3, 5, 6, 7].reduce((sum, id) => sum + retained(tool(store, String(id))), 0)).toBe(600);
});

test("cuts preserve scalar pairs and crlf while split surrogate deltas match one-shot text", () => {
  const store = createRunStore((flush) => flush(), { toolOutputItemBytes: 20, toolOutputRunBytes: 1_000 });
  store.dispatch(output("split", `a\r\n${"x".repeat(40)}\ud83d`));
  store.dispatch(output("split", `\ude00\r\nz`));
  store.dispatch(end("split"));
  const value = source(tool(store, "split").output);
  const kept = text(value);
  expect(kept).toContain("😀");
  for (const chunk of value.chunks()) {
    expect(chunk.text.endsWith("\r")).toBe(false);
    expect(/^\n/.test(chunk.text)).toBe(false);
    expect(/[\uD800-\uDBFF]$/.test(chunk.text)).toBe(false);
    expect(/^[\uDC00-\uDFFF]/.test(chunk.text)).toBe(false);
  }
  expect(value.omission && value.omission.start < value.omission.end).toBe(true);

  store.dispatch(output("ansi", `plain\u001b[38;2;255;120;90m${"colored".repeat(20)}\u001b[0mend`));
  const ansi = text(tool(store, "ansi").output);
  expect(ansi.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|.)/g, "")).not.toContain("\u001b");
});

test("history replay retains compact tool state and keeps bounded output exact", () => {
  const store = createRunStore((flush) => flush(), { toolOutputItemBytes: 128, toolOutputRunBytes: 512 });
  store.beginHistory();
  store.dispatch(output("live", "a".repeat(300)));
  const before = tool(store, "live");
  store.prepend([{ type: "message_commit", message_id: "old", message: { role: "assistant", content: [{ type: "text", text: "old" }] } }]);
  const after = tool(store, "live");
  expect(after.output).toBe(before.output);
  expect(retained(after)).toBeLessThanOrEqual(128);
  expect(text(after.output)).toBe(text(before.output));
  store.dispatch(output("live", "TAIL"));
  store.prepend([{ type: "message_commit", message_id: "older", message: { role: "assistant", content: [{ type: "text", text: "older" }] } }]);
  expect(text(tool(store, "live").output).endsWith("TAIL")).toBe(true);
});

test("one flush publishes every cross-item omission atomically and once", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((flush) => jobs.push(flush), { toolOutputItemBytes: 100, toolOutputRunBytes: 250 });
  for (const id of ["a", "b", "d"]) { store.dispatch(output(id, id.repeat(100))); store.dispatch(end(id)); }
  jobs.shift()!();
  const calls = { a: 0, b: 0, c: 0 };
  for (const id of Object.keys(calls)) store.subscribe(`tool:${id}`, () => calls[id as keyof typeof calls]++);
  store.subscribe(() => {
    expect(source(tool(store, "a").output).omission?.reason).toBe("run-cap");
    expect(retained(tool(store, "b"))).toBe(100);
    expect(retained(tool(store, "c"))).toBe(100);
  });
  store.dispatch(output("c", "c".repeat(100)));
  store.dispatch(end("c"));
  jobs.shift()!();
  expect(calls).toEqual({ a: 1, b: 0, c: 1 });
});

test("protocol truncation is distinct from a local cut", () => {
  const store = createRunStore((flush) => flush(), { toolOutputItemBytes: 30, toolOutputRunBytes: 1_000 });
  store.dispatch(output("both", "x".repeat(100)));
  store.dispatch({ type: "tool_end", tool_call: call("both"), tool_result: { tool_call_id: "both", content: "", is_error: false, truncated: true } });
  const value = source(tool(store, "both").output);
  expect(value.protocolTruncated).toBe(true);
  expect(value.omission?.reason).toBe("item-cap");
});
