import { expect, test } from "bun:test";
import { heapStats } from "bun:jsc";
import { createRunStore, type RunEvent, type RunItem, type TextSourceSnapshot } from "../src/index.js";

type Tool = Extract<RunItem, { type: "tool" }>;
type Store = ReturnType<typeof createRunStore>;
const encoder = new TextEncoder();
const utf8 = (value: string) => encoder.encode(value).byteLength;
const tool = (store: Store, id: string) => {
  const item = store.getItem(`tool:${id}`);
  if (item?.type !== "tool") throw new Error(`missing tool ${id}`);
  return item;
};
const text = (source: TextSourceSnapshot | undefined) => source ? [...source.chunks()].map((chunk) => chunk.text).join("") : "";
const call = (id: string) => ({ id, name: `tool-${id}`, arguments: {} });
const output = (id: string, value: string, replace = false): RunEvent => ({ type: "tool_output", tool_call: call(id), output: value, replace });
const end = (id: string, is_error = false, content = "", resultContent?: "same" | "append" | "replace" | "auto"): RunEvent =>
  ({ type: "tool_end", tool_call: call(id), tool_result: { tool_call_id: id, content, is_error }, ...(resultContent ? { resultContent } : {}) });
const sources = (item: Tool): TextSourceSnapshot[] => {
  const values = [item.output];
  const view = item.view;
  if (view?.kind === "shell") values.push(...[view.stdout, view.stderr].filter((value) => value !== undefined));
  if (view?.kind === "edit") values.push(view.diff);
  if (view?.kind === "write" && view.content) values.push(view.content);
  if (view?.kind === "search") values.push(...view.matches ?? []);
  if (item.result?.finalContent) values.push(item.result.finalContent);
  for (const block of item.result?.blocks ?? []) if (block.text) values.push(block.text);
  return values;
};
const retained = (item: Tool) => sources(item).reduce((sum, value) => sum + value.retainedBytes, 0);
const lineCount = (value: string) => value === "" ? 0 : value.split("\n").length - Number(value.endsWith("\n"));
// Every fact a source states about its logical text, checked against that text.
function expectTruthful(source: TextSourceSnapshot, whole: string, limit: number) {
  expect(source.length).toBe(whole.length);
  expect(source.bytes).toBe(utf8(whole));
  expect(source.lines).toBe(lineCount(whole));
  const chunks = [...source.chunks()];
  expect(source.retainedBytes).toBe(chunks.reduce((sum, chunk) => sum + utf8(chunk.text), 0));
  expect(source.retainedBytes).toBeLessThanOrEqual(limit);
  for (const chunk of chunks) {
    expect(utf8(chunk.text)).toBeLessThanOrEqual(32 * 1024);
    expect(whole.slice(chunk.start, chunk.start + chunk.text.length)).toBe(chunk.text);
    expect(chunk.line).toBe(whole.slice(0, chunk.start).split("\n").length - 1);
  }
  const omission = source.omission;
  if (!omission) return expect(text(source)).toBe(whole);
  expect(omission.bytes).toBe(source.bytes - source.retainedBytes);
  expect(utf8(whole.slice(omission.start, omission.end))).toBe(omission.bytes);
  expect(text(source)).toBe(whole.slice(0, omission.start) + whole.slice(omission.end));
  for (const at of [omission.start, omission.end]) {
    // No cut splits a surrogate pair or a CRLF.
    expect(/[\uD800-\uDBFF]/.test(whole[at - 1] ?? "") && /[\uDC00-\uDFFF]/.test(whole[at] ?? "")).toBe(false);
    expect(whole[at - 1] === "\r" && whole[at] === "\n").toBe(false);
  }
}

test("an oversized output keeps a quarter for its head, the rest for its tail, and one exact cut", () => {
  const store = createRunStore((flush) => flush(), { toolOutputItemBytes: 100_000, toolOutputRunBytes: 1_000_000 });
  // Multibyte text longer than one 16k-unit encoding piece, so byte accounting crosses pieces.
  const whole = `HEAD\n${"é😀x\r\n".repeat(40_000)}TAIL`;
  store.dispatch(output("large", whole));
  const source = tool(store, "large").output;
  // Fail-first on c04b167: old core publishes the original unbounded string here.
  expect(typeof source, "tool output must be a bounded source, not an unbounded string").toBe("object");
  expect(source.omission).toMatchObject({ kind: "omitted", reason: "item-cap", whole: false });
  expectTruthful(source, whole, 100_000);
  expect(utf8(whole.slice(0, source.omission!.start))).toBeLessThanOrEqual(25_000);
  expect(source.retainedBytes).toBeGreaterThan(99_990);
  expect(text(source).endsWith("TAIL")).toBe(true);
});

test("streamed deltas cut where one whole string cuts: surrogates, CRLF, and lines split at every boundary", () => {
  const whole = Array.from({ length: 900 }, (_, index) => `${index}:é😀\r\n${index % 7 === 0 ? "\r" : ""}`).join("") + "\ud83d";
  for (const size of [1, 2, 3, 5, 64, 997]) {
    const store = createRunStore((flush) => flush(), { toolOutputItemBytes: 4_000, toolOutputRunBytes: 1_000_000 });
    for (let at = 0; at < whole.length; at += size) store.dispatch(output("s", whole.slice(at, at + size)));
    store.dispatch(end("s"));
    const oneShot = createRunStore((flush) => flush(), { toolOutputItemBytes: 4_000, toolOutputRunBytes: 1_000_000 });
    oneShot.dispatch(output("s", whole));
    oneShot.dispatch(end("s"));
    // A high surrogate left at the end never met its low half: it becomes U+FFFD in both.
    const canonical = whole.slice(0, -1) + "\ufffd";
    const streamed = tool(store, "s").output;
    expectTruthful(streamed, canonical, 4_000);
    expectTruthful(tool(oneShot, "s").output, canonical, 4_000);
    expect({ size, omission: streamed.omission, text: text(streamed) }).toEqual({ size, omission: tool(oneShot, "s").output.omission, text: text(tool(oneShot, "s").output) });
  }
});

test("a cut never lands inside an escape sequence, so no control fragment shows", () => {
  const whole = Array.from({ length: 400 }, (_, index) => `\u001b[38;5;${index % 256}mword ${index}\u001b[0m \u001b]8;;https://e.x/${index}\u0007link\u001b]8;;\u0007\n`).join("");
  const sequence = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
  const spans = [...whole.matchAll(sequence)].map((match) => [match.index!, match.index! + match[0].length] as const);
  for (let limit = 3_000; limit < 3_300; limit += 7) {
    const store = createRunStore((flush) => flush(), { toolOutputItemBytes: limit, toolOutputRunBytes: 1_000_000 });
    store.dispatch(output("a", whole));
    for (let at = 0; at < 20; at++) store.dispatch(output("a", "\u001b[31mred\u001b[0m\n"));
    const source = tool(store, "a").output;
    const full = whole + "\u001b[31mred\u001b[0m\n".repeat(20);
    expectTruthful(source, full, limit);
    for (const cut of [source.omission!.start, source.omission!.end])
      expect(spans.find(([from, to]) => from < cut && cut < to), `limit ${limit} cut ${cut}`).toBeUndefined();
  }
});

test("item accounting covers every output-bearing view and result source, in a stable order", () => {
  const cap = 1_000;
  const store = createRunStore((flush) => flush(), { toolOutputItemBytes: cap, toolOutputRunBytes: 100_000 });
  const big = (tag: string, size = 600) => `${tag}${"v".repeat(size)}`;
  store.dispatch({ type: "tool_output", tool_call: call("all"), output: big("out", 1_200), view: { kind: "shell", command: "run", stdout: big("stdout"), stderr: big("stderr") } });
  store.dispatch({ type: "tool_end", tool_call: call("all"), tool_result: { tool_call_id: "all", content: big("final"), is_error: false, blocks: [{ type: "text", text: big("block") }] } });
  const item = tool(store, "all");
  expect(retained(item)).toBeLessThanOrEqual(cap);
  // The primary output comes first and takes the whole budget; every later source keeps its totals and no body.
  expect(item.output.retainedBytes).toBeGreaterThan(cap - 10);
  const later = sources(item).slice(1);
  expect(later.map((source) => [source.retainedBytes, source.omission?.whole])).toEqual(later.map(() => [0, true]));
  // `auto` after a cut cannot tell whether the result repeats the output: it is its own source.
  expect(item.result?.relation).toBe("unknown");
  expect(item.result?.finalContent?.bytes).toBe(utf8(big("final")));
  expect(item.result?.blocks?.[0]?.metadata).toEqual({ type: "text" });
  expect(item.result?.blocks?.[0]?.text?.bytes).toBe(utf8(big("block")));
  expect(item.view?.kind === "shell" && [item.view.stdout!.bytes, item.view.stderr!.bytes]).toEqual([utf8(big("stdout")), utf8(big("stderr"))]);
});

test("each stored view field is bounded even when no output streams", () => {
  const store = createRunStore((flush) => flush(), { toolOutputItemBytes: 500, toolOutputRunBytes: 100_000 });
  const big = "w".repeat(10_000);
  store.dispatch({ type: "tool_start", tool_call: call("edit"), view: { kind: "edit", path: "a.ts", diff: big } });
  store.dispatch({ type: "tool_start", tool_call: call("write"), view: { kind: "write", path: "a.ts", content: big } });
  store.dispatch({ type: "tool_start", tool_call: call("search"), view: { kind: "search", pattern: "w", matches: [big, big] } });
  for (const id of ["edit", "write", "search"]) expect(retained(tool(store, id))).toBeLessThanOrEqual(500);
  const edit = tool(store, "edit").view;
  expect(edit?.kind === "edit" && edit.diff.bytes).toBe(10_000);
});

test("result relations: same, append, replace, and auto with complete output", () => {
  const store = createRunStore((flush) => flush());
  const cases: Array<[string, string, string, "same" | "append" | "replace" | "auto" | undefined, string, string]> = [
    ["same", "streamed", "streamed", "same", "streamed", "same"],
    ["append", "a", "b", "append", "a\nb", "append"],
    ["replace", "old", "new", "replace", "new", "replace"],
    ["auto-substring", "line 1\nline 2\n", "line 2", undefined, "line 1\nline 2\n", "same"],
    ["auto-adds", "partial", "error: boom", "auto", "partial\nerror: boom", "append"],
    ["auto-longer", "ok", "ok and more", undefined, "ok\nok and more", "append"],
    ["same-without-output", "", "only the result", "same", "only the result", "append"],
  ];
  for (const [id, streamed, content, relation, shown, stored] of cases) {
    if (streamed) store.dispatch(output(id, streamed));
    store.dispatch(end(id, false, content, relation));
    expect({ id, shown: text(tool(store, id).output), relation: tool(store, id).result?.relation }).toEqual({ id, shown, relation: stored });
    expect(tool(store, id).result?.finalContent).toBeUndefined();
  }
});

test("run eviction is oldest-first and protects running, failed, non-zero, and newest completed tools", () => {
  const store = createRunStore((flush) => flush(), { toolOutputItemBytes: 100, toolOutputRunBytes: 350 });
  for (let index = 0; index < 8; index++) {
    const id = String(index);
    const view = index === 2 ? { kind: "shell" as const, command: "bad", exitCode: 2 } : undefined;
    store.dispatch({ type: "tool_output", tool_call: call(id), output: id.repeat(100), view });
    if (index !== 3) store.dispatch(end(id, index === 1));
  }
  const omitted = tool(store, "0").output;
  expect(omitted.omission).toEqual({ kind: "omitted", reason: "run-cap", start: 0, end: 100, bytes: 100, whole: true });
  expect([omitted.length, omitted.bytes, omitted.retainedBytes]).toEqual([100, 100, 0]);
  expect(tool(store, "4").output.omission).toMatchObject({ reason: "run-cap", whole: true });
  // Failed (1), non-zero exit (2), running (3), and the newest three completed (5, 6, 7) keep their bodies.
  expect([1, 2, 3, 5, 6, 7].map((id) => retained(tool(store, String(id))))).toEqual([100, 100, 100, 100, 100, 100]);
  // The cap is soft here: six protected bodies alone exceed it.
  expect([0, 1, 2, 3, 4, 5, 6, 7].reduce((sum, id) => sum + retained(tool(store, String(id))), 0)).toBe(600);
});

test("10,000 completed tools stay under the run cap, newest kept, in time linear in the tool count", () => {
  const run = (count: number) => {
    const store = createRunStore((flush) => flush(), { toolOutputItemBytes: 4_096, toolOutputRunBytes: 64 * 1024 });
    const started = performance.now();
    for (let index = 0; index < count; index++) {
      store.dispatch(output(String(index), `${index}`.padEnd(2_048, ".")));
      store.dispatch(end(String(index)));
    }
    const ms = performance.now() - started;
    const items = store.getOutline().map(({ id }) => store.getItem(id) as Tool);
    return { ms, total: items.reduce((sum, item) => sum + retained(item), 0), kept: items.filter((item) => retained(item) > 0).map(({ id }) => id) };
  };
  run(1_000); // warm-up
  const small = run(1_000);
  const large = run(10_000);
  expect(large.total).toBeLessThanOrEqual(64 * 1024);
  expect(large.kept).toEqual(Array.from({ length: 32 }, (_, index) => `tool:${10_000 - 32 + index}`));
  // Linear: 10x the tools costs about 10x; a rescan of every tool per flush would cost about 100x.
  expect(large.ms / small.ms).toBeLessThan(30);
});

test("one flush publishes every cross-item omission atomically and once", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((flush) => jobs.push(flush), { toolOutputItemBytes: 100, toolOutputRunBytes: 450 });
  for (const id of ["a", "b", "c", "d"]) { store.dispatch(output(id, id.repeat(100))); store.dispatch(end(id)); }
  jobs.shift()!();
  const calls = { a: 0, b: 0, c: 0, e: 0 };
  for (const id of Object.keys(calls)) store.subscribe(`tool:${id}`, () => calls[id as keyof typeof calls]++);
  const seen: number[] = [];
  store.subscribe(() => seen.push(["a", "b", "c", "d", "e", "f"].reduce((sum, id) => sum + retained(tool(store, id)), 0)));
  for (const id of ["e", "f"]) { store.dispatch(output(id, id.repeat(100))); store.dispatch(end(id)); }
  jobs.shift()!();
  // One flush evicted the two oldest; every listener saw the final state once.
  expect(calls).toEqual({ a: 1, b: 1, c: 0, e: 1 });
  expect(seen).toEqual([400]);
  expect(tool(store, "a").output.omission?.reason).toBe("run-cap");
});

test("protocol truncation is distinct from a local cut", () => {
  const store = createRunStore((flush) => flush(), { toolOutputItemBytes: 30, toolOutputRunBytes: 1_000 });
  store.dispatch(output("both", "x".repeat(100)));
  store.dispatch({ type: "tool_end", tool_call: call("both"), tool_result: { tool_call_id: "both", content: "", is_error: false, truncated: true } });
  const both = tool(store, "both").output;
  expect([both.protocolTruncated, both.omission?.reason]).toEqual([true, "item-cap"]);
  store.dispatch(output("host", "short"));
  store.dispatch({ type: "tool_end", tool_call: call("host"), tool_result: { tool_call_id: "host", content: "", is_error: false, truncated: true } });
  expect([tool(store, "host").output.protocolTruncated, tool(store, "host").output.omission]).toEqual([true, null]);
});

test("a replacement drops the old generation and old snapshots stay readable while held", () => {
  const store = createRunStore((flush) => flush(), { toolOutputItemBytes: 1_000, toolOutputRunBytes: 10_000 });
  store.dispatch(output("r", "old ".repeat(1_000)));
  const held = tool(store, "r").output;
  const heldText = text(held);
  store.dispatch(output("r", "new", true));
  expect(text(tool(store, "r").output)).toBe("new");
  expect(tool(store, "r").output.omission).toBeNull();
  expect(text(held)).toBe(heldText);
  expect(held.omission?.reason).toBe("item-cap");
});

test("history replay keeps no tool payloads and equals a store that never prepended", () => {
  const cap = { toolOutputItemBytes: 2_048, toolOutputRunBytes: 8_192 };
  const older: RunEvent[] = [{ type: "message_commit", message_id: "old", message: { role: "assistant", content: [{ type: "text", text: "old" }] } }];
  const live = (store: Store, round: number) => {
    for (let index = 0; index < 4; index++) store.dispatch(output(`t${round}-${index}`, `${round}:${index}:`.padEnd(3_000, "z")));
    store.dispatch(end(`t${round}-0`));
  };
  const control = createRunStore((flush) => flush(), cap);
  older.forEach(control.dispatch);
  const store = createRunStore((flush) => flush(), cap);
  store.beginHistory();
  for (let round = 0; round < 3; round++) {
    live(control, round);
    live(store, round);
    if (round === 0) store.prepend(older);
  }
  const view = (target: Store) => target.getOutline().map(({ id }) => {
    const item = target.getItem(id)!;
    return item.type === "tool" ? [id, item.active, item.output.bytes, item.output.retainedBytes, text(item.output)] : [id];
  });
  expect(view(store)).toEqual(view(control));
  // Nine running tools and the newest completed ones are protected, so this run sits above its soft cap, exactly as the control does.
  const total = (target: Store) => target.getOutline().reduce((sum, { id }) => { const item = target.getItem(id)!; return item.type === "tool" ? sum + retained(item) : sum; }, 0);
  expect(total(store)).toBe(total(control));
  expect(store.getOutline().every(({ id }) => { const item = store.getItem(id)!; return item.type !== "tool" || retained(item) <= 2_048; })).toBe(true);
  store.endHistory();
});

test("with history open, the accepted log does not hold streamed tool payloads", () => {
  Bun.gc(true);
  const store = createRunStore((flush) => flush(), { toolOutputItemBytes: 32 * 1024, toolOutputRunBytes: 1024 * 1024 });
  store.beginHistory();
  const before = heapStats().heapSize;
  // 32 MiB of fresh one-mebibyte payloads; the old log kept each one until the history walk ended.
  for (let index = 0; index < 32; index++) store.dispatch(output("big", `${index}`.padEnd(1024 * 1024, "p").toLowerCase()));
  Bun.gc(true);
  const grown = (heapStats().heapSize - before) / (1024 * 1024);
  expect(grown, `heap grew ${grown.toFixed(1)} MiB while history was open`).toBeLessThan(8);
  store.endHistory();
});

test("invalid caps are rejected at creation", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    expect(() => createRunStore(undefined, { toolOutputItemBytes: bad })).toThrow(RangeError);
    expect(() => createRunStore(undefined, { toolOutputRunBytes: bad })).toThrow(RangeError);
  }
});
