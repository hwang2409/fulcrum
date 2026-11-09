import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRunStore, type RunEvent, type ToolView } from "@fulcrum/core";
import { RunProvider, ToolCall } from "../src/index.js";

// A 600 px viewport, so the virtual viewer mounts rows (happy-dom has no layout).
const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
afterAll(() => {
  if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
  GlobalRegistrator.unregister();
});
let root: Root | undefined;
let container: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
});

const call = (id: string) => ({ id, name: "bash", arguments: { command: "log" } });
const start = (id: string, view: ToolView = { kind: "shell", command: "log" }): RunEvent => ({ type: "tool_start", tool_call: call(id), view });
const out = (id: string, output: string, replace?: boolean): RunEvent => ({ type: "tool_output", tool_call: call(id), output, ...(replace ? { replace } : {}) });
const end = (id: string): RunEvent => ({ type: "tool_end", tool_call: call(id), tool_result: { tool_call_id: id, content: "", is_error: false } });

function mount(store: ReturnType<typeof createRunStore>, ids: string[]) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<RunProvider store={store}>{ids.map((id) => <ToolCall key={id} id={`tool:${id}`} />)}</RunProvider>));
}
const card = (id: string) => container.querySelector(`[data-id="tool:${id}"]`) as HTMLDetailsElement;
function openViewer(id: string) {
  const details = card(id);
  if (!details.open) act(() => { details.open = true; details.dispatchEvent(new Event("toggle")); });
  const button = details.querySelector<HTMLButtonElement>('[data-action="open-viewer"]');
  if (button) act(() => button.click());
}
const count = (id: string) => card(id).querySelector('[data-part="text-viewer-count"]')?.textContent ?? "";
const shown = (id: string) => [...card(id).querySelectorAll('[data-part="text-viewer-row"], [data-part="tool-output"]')].map((row) => row.textContent).join("");

// Test-only spy: every String.prototype call on a stream-sized string (>= `min` UTF-16 units), keyed by its caller.
// A compare (startsWith, endsWith) reads both strings in full; any other call on a concatenated (rope) string makes the
// engine flatten it, a full copy. So the count is the per-append full-length work, and the key names the hook doing it.
const COMPARES = ["startsWith", "endsWith"] as const;
const READS = ["slice", "substring", "charCodeAt", "codePointAt", "at", "charAt", "indexOf", "lastIndexOf", "includes", "match", "matchAll", "split", "replace", "search", "trim", "trimStart", "trimEnd", "toLowerCase", "normalize", "localeCompare"] as const;
function spyStrings(min: number, arrayMin = 256) {
  const sites: Record<string, number> = {};
  let chars = 0;
  const proto = String.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const originals = [...COMPARES, ...READS].map((name) => [name, proto[name]!] as const);
  for (const [name, original] of originals) {
    const kind = (COMPARES as readonly string[]).includes(name) ? "compare" : "read";
    proto[name] = function (this: string, ...args: unknown[]) {
      if (this.length >= min) {
        const caller = new Error().stack!.split("\n")[2]!.trim();
        // React's development build reads changed props to log renders; the production build does not.
        if (!caller.includes("react-dom-client.development")) {
          const site = `${kind} ${name} in ${caller.replace(/^at /, "").replace(/ \(.*\/(src|test)\//, " (").replace(/(:\d+)+\)$/, ")")}`;
          sites[site] = (sites[site] ?? 0) + 1;
          chars += this.length;
        }
      }
      return original.apply(this, args);
    };
  }
  // Arrays too: a step that copies or visits an array of every segment or row (the segment index, the virtual list's
  // rows, sizes, or offsets) costs O(n) per append. Counted when the array has at least `arrayMin` entries.
  const arrayProto = Array.prototype as unknown as Record<PropertyKey, (...args: unknown[]) => unknown>;
  const arrayOriginals = ARRAY_METHODS.map((name) => [name, arrayProto[name]!] as const);
  let elements = 0;
  const arraySites: Record<string, number> = {};
  for (const [name, original] of arrayOriginals) {
    arrayProto[name] = function (this: unknown[], ...args: unknown[]) {
      // slice copies only its result; every other method here visits (or copies) the whole array.
      if (counting && (name === "slice" ? sliceLength(this.length, args) : this.length) >= arrayMin) {
        counting = false; // the stack read below must not count itself
        const caller = new Error().stack!.split("\n")[2]!.trim();
        // Only fulcrum's own code (packages/*/src or dist), not React, the DOM shim, or this test.
        if (/\/packages\/[^/]+\/(src|dist)\//.test(caller)) {
          const site = `array ${String(name)} in ${caller.replace(/^at /, "").replace(/ \(.*\/(src|dist)\//, " (").replace(/(:\d+)+\)$/, ")")}`;
          arraySites[site] = (arraySites[site] ?? 0) + 1;
          elements += this.length;
        }
        counting = true;
      }
      return original.apply(this, args);
    };
  }
  let counting = true;
  return {
    result: () => ({ sites, chars, arraySites, elements }),
    restore: () => {
      counting = false;
      for (const [name, original] of originals) proto[name] = original;
      for (const [name, original] of arrayOriginals) arrayProto[name] = original;
    },
  };
}
const sliceLength = (length: number, [start = 0, end = length]: unknown[]) => {
  const at = (value: unknown) => { const index = Number(value); return index < 0 ? Math.max(length + index, 0) : Math.min(index, length); };
  return Math.max(at(end) - at(start), 0);
};
const ARRAY_METHODS: PropertyKey[] = ["slice", "map", "filter", "forEach", "indexOf", "lastIndexOf", "find", "findIndex", "findLast", "findLastIndex", "concat", "reduce", "reduceRight", "some", "every", "includes", "join", "flat", "flatMap", "fill", "sort", "reverse", "splice", "entries", "keys", "values", "toSorted", "toSpliced", "with", "copyWithin", Symbol.iterator];

const big = (lines: number) => "x\n".repeat(lines);
const red = (lines: number) => "\u001b[31mx\u001b[0m\n".repeat(lines);

// Appends `appends` deltas to an output over `text`, then ends the tool; returns the spied full-length work of the
// appends, and of the end separately.
// `min`: the shortest string that counts as the whole text; it stays above the appended text, whose own reads are the
// tail's cost.
function appendWork(text: string, appends: number, delta: (index: number) => string, open = true, view?: ToolView, min = 10_000) {
  const store = createRunStore((job) => job());
  store.dispatch(start("a", view));
  store.dispatch(out("a", text));
  mount(store, ["a"]);
  if (open) openViewer("a");
  expect(card("a").querySelector(open ? '[data-part="text-viewer"]' : '[data-action="open-viewer"]')).not.toBeNull();
  const spy = spyStrings(min);
  try {
    for (let index = 0; index < appends; index++) act(() => store.dispatch(out("a", delta(index))));
  } finally {
    spy.restore();
  }
  const work = spy.result();
  const endSpy = spyStrings(min);
  try {
    act(() => store.dispatch(end("a")));
  } finally {
    endSpy.restore();
  }
  expect(card("a").dataset.state).toBe("done");
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  return { ...work, end: endSpy.result().sites, endArrays: endSpy.result().arraySites };
}

const plainTail = (index: number) => `\npaired tail ${index}`;
const ansiTail = (index: number) => `\u001b[32mgreen ${index}\u001b[0m\n`;
// The end's only full read is JSON detection of the finished plain output, once (ANSI output is never JSON).
const source = (lines: number) => Array.from({ length: lines }, (_, index) => ["let a = 1;\n", "a++;\n", "f(a);\n", "// c\n"][index % 4]).join("");
// The layout gate's scaling probe: a file read (numbered lines), each append one 65,536-character line.
const longLine = () => `\n${"x".repeat(65_535)}`;
const paths: Array<{ name: string; small: string; large: string; delta: (index: number) => string; end: Record<string, number>; view?: ToolView; min?: number }> = [
  { name: "file read", small: source(16_000), large: source(512_000), delta: longLine, end: {}, view: { kind: "read", path: "src/huge.ts" }, min: 100_000 },
  { name: "plain output", small: big(31_250), large: big(1_000_000), delta: plainTail, end: { "read trimStart in jsonText (tools/json.ts)": 1 } },
  { name: "ANSI output", small: red(6_250), large: red(200_000), delta: ansiTail, end: {} },
];

// Array steps that may run on an append, each named: anything else that visits or copies an array of at least 256
// entries (every segment, row, size, or offset) fails the test.
const allowedArrays = new Set([
  // shortcut: an append that seals a segment copies the segment arrays (O(n / 2,000) references), because
  // useVirtualList applies an outline only when its identity changes; the next test bounds it to sealing appends.
  // Remove this entry once virtual.tsx takes an in-place append.
  "array Symbol(Symbol.iterator) in useSegments (tools/text-viewer.tsx)",
  // Row-local: one mounted row's own spans (at most one per character of a 2,000-character segment).
  "array entries in AnsiRun (tools/text-viewer.tsx)",
]);

for (const { name, large, delta, end: atEnd, view, min } of paths) for (const open of [true, false]) test(`an append to a large ${name} in the ${open ? "open viewer" : "closed preview"} does no full-length compare or read (exact, by hook)`, () => {
  const work = appendWork(large, 10, delta, open, view, min);
  console.log(`${name}: ${work.chars} chars of full-length work over 10 appends`, work.sites, work.arraySites, "at the end", work.end, work.endArrays);
  // An entry names the hook and string method that touched the whole text on an append; there must be none.
  expect(work.sites).toEqual({});
  expect(Object.keys(work.arraySites).filter((site) => !allowedArrays.has(site))).toEqual([]);
  expect(work.end).toEqual(atEnd);
  expect(Object.keys(work.endArrays).filter((site) => !allowedArrays.has(site))).toEqual([]);
});

test("the segment arrays are copied only by an append that seals a segment, once per append", () => {
  const copy = "array Symbol(Symbol.iterator) in useSegments (tools/text-viewer.tsx)";
  const store = createRunStore((job) => job());
  store.dispatch(start("a"));
  store.dispatch(out("a", big(1_000_000)));
  mount(store, ["a"]);
  openViewer("a");
  const copies = (delta: string) => {
    const spy = spyStrings(10_000);
    try {
      act(() => store.dispatch(out("a", delta)));
    } finally {
      spy.restore();
    }
    return spy.result().arraySites[copy] ?? 0;
  };
  // The open segment holds up to 2,000 characters: fill it to the edge without sealing, one character at a time.
  copies("\n"); // a newline ends the last full segment's text, so what follows starts a fresh open segment
  let unsealed = 0;
  for (let index = 0; index < 50; index++) unsealed += copies("y");
  expect(unsealed).toBe(0);
  // One append that seals 33 segments copies the two arrays (segments, their texts) once, not per segment.
  expect(copies("z".repeat(66_000))).toBe(2);
});

for (const { name, small, large, delta, view, min } of paths) for (const open of [true, false]) test(`per-append work for the ${name} in the ${open ? "open viewer" : "closed preview"} is flat in its length (32x span)`, () => {
  const low = appendWork(small, 10, delta, open, view, min);
  const high = appendWork(large, 10, delta, open, view, min);
  // 32x the text; a cost proportional to the text grows 32x. The limit is near the geometric middle (sqrt 32 ~ 5.7).
  const ratio = (high.chars + 1) / (low.chars + 1);
  console.log(`${name}: ${low.chars} vs ${high.chars} chars of full-length work (${ratio.toFixed(2)}x); array entries visited ${low.elements} vs ${high.elements}`);
  expect(ratio).toBeLessThan(5.7);
});

test("the appended plain output is counted and shown", () => {
  const store = createRunStore((job) => job());
  store.dispatch(start("a"));
  store.dispatch(out("a", big(1_000_000)));
  mount(store, ["a"]);
  openViewer("a");
  for (let index = 0; index < 10; index++) act(() => store.dispatch(out("a", plainTail(index))));
  expect(count("a")).toBe("1,000,011 lines · 2,000,140 characters");
  expect(shown("a").endsWith("\npaired tail 8\npaired tail 9")).toBe(true);
});

const ESC = "\u001b";
type Case = { name: string; events: (id: string) => RunEvent[]; text: string };
const cases: Case[] = [
  { name: "plain append", events: (id) => [out(id, "a\n"), out(id, "b"), out(id, "c\n")], text: "a\nbc\n" },
  { name: "append splitting CRLF", events: (id) => [out(id, "a\r"), out(id, "\nb\r"), out(id, "\n")], text: "a\r\nb\r\n" },
  { name: "append splitting an ANSI escape", events: (id) => [out(id, `x ${ESC}[3`), out(id, "1mred"), out(id, `${ESC}[0m done\n`)], text: "x red done\n" },
  { name: "append splitting a surrogate pair", events: (id) => [out(id, "a\ud83d"), out(id, "\ude00b")], text: "a\ud83d\ude00b" },
  { name: "append splitting a line", events: (id) => [out(id, "hel"), out(id, "lo\nwor"), out(id, "ld\n")], text: "hello\nworld\n" },
  { name: "appends longer than the preview's tail window, with graphemes at the cuts", events: (id) => [out(id, "y".repeat(3_000)), out(id, "e\u0301".repeat(1_500)), out(id, "\n\ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb".repeat(300))], text: "\n\ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb" },
  { name: "replace", events: (id) => [out(id, "old text\n"), out(id, "new\n", true), out(id, "more\n")], text: "new\nmore\n" },
  { name: "tool_end then a new tool on the same id", events: (id) => [out(id, "first\n"), end(id), start(id), out(id, "second\n")], text: "second\n" },
];

// Each step's display after every event equals a fresh render of the same events (the full path): small (inline),
// and large in the open viewer and in the closed preview (both incremental).
const modes = [["inline", ""], ["open viewer", big(60_000)], ["closed preview", big(60_000)]] as const;
// The shown text, its count, and each styled run as `class:text`, so ANSI spans are compared too, not only the text.
const styled = (id: string) => [...card(id).querySelectorAll('[data-part="text-viewer-row"] span[class], [data-part="tool-output"] span[class]')].map((span) => `${span.className}:${span.textContent}`).join("|");
const display = (id: string) => [shown(id), count(id) || (card(id).querySelector('[data-action="open-viewer"]')?.textContent ?? ""), styled(id)];
function show(mode: string) {
  if (mode === "open viewer") return openViewer("a");
  const details = card("a");
  if (!details.open) act(() => { details.open = true; details.dispatchEvent(new Event("toggle")); });
}
for (const { name, events, text } of cases) for (const [mode, prefix] of modes) {
  test(`${name} (${mode}): every step shows what a fresh render shows`, () => {
    const live = createRunStore((job) => job());
    live.dispatch(start("a"));
    if (prefix) live.dispatch(out("a", prefix));
    mount(live, ["a"]);
    show(mode);
    const steps = events("a");
    const seen: string[][] = [];
    for (const event of steps) {
      act(() => live.dispatch(event));
      seen.push(display("a"));
    }
    expect(seen.at(-1)![0]!.endsWith(text)).toBe(true);
    if (mode !== "inline") expect(seen[0]![1]).not.toBe(""); // the first step is still large
    act(() => root?.unmount());
    container.remove();
    for (let step = 0; step < steps.length; step++) {
      const fresh = createRunStore((job) => job());
      fresh.dispatch(start("a"));
      if (prefix) fresh.dispatch(out("a", prefix));
      steps.slice(0, step + 1).forEach(fresh.dispatch);
      mount(fresh, ["a"]);
      show(mode);
      expect(display("a")).toEqual(seen[step]!);
      act(() => root?.unmount());
      container.remove();
    }
  });
}

test("a resync to a different history starts the text over, then appends to the new text", () => {
  const history = [start("a"), out("a", `${big(59_000)}other\n`)];
  const store = createRunStore((job) => job());
  store.dispatch(start("a"));
  store.dispatch(out("a", big(60_000)));
  mount(store, ["a"]);
  openViewer("a");
  act(() => store.resync(history));
  expect(count("a")).toBe("59,001 lines · 118,006 characters");
  act(() => store.dispatch(out("a", "tail\n")));
  const seen = [shown("a"), count("a")];
  expect(seen[1]).toBe("59,002 lines · 118,011 characters");
  act(() => root?.unmount());
  container.remove();
  const fresh = createRunStore((job) => job());
  [...history, out("a", "tail\n")].forEach(fresh.dispatch);
  mount(fresh, ["a"]);
  openViewer("a");
  expect([shown("a"), count("a")]).toEqual(seen);
});

// A long-lived open viewer keeps only what the appends added: after warm-up, retained heap over 200 appends of 100
// characters stays within a small multiple of the added text. Before stream tails, each append left a full-text
// sized copy alive (about 2 MB per append on a 1,000,000-line output in Chromium).
test("a long-lived open viewer retains about the text its appends add, not a copy of the whole text", () => {
  const { heapSize } = require("bun:jsc") as { heapSize: () => number };
  const store = createRunStore((job) => job());
  store.dispatch(start("a"));
  store.dispatch(out("a", big(1_000_000)));
  mount(store, ["a"]);
  openViewer("a");
  const tail = `\n${"p".repeat(99)}`;
  let index = 0;
  const appendSome = (count: number) => { for (const end = index + count; index < end; index++) act(() => store.dispatch(out("a", tail))); };
  appendSome(100);
  Bun.gc(true);
  const before = heapSize();
  appendSome(200);
  Bun.gc(true);
  const growth = heapSize() - before;
  console.log(`retained over 200 appends of 100 characters: ${(growth / 1024).toFixed(0)} KiB`);
  // 20,000 characters added. A copy of the 2,000,000-character text is 2 MB (one-byte) or 4 MB; even one copy fails.
  expect(growth).toBeLessThan(1024 * 1024);
});
