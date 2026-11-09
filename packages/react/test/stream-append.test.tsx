import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRunStore, type RunEvent } from "@fulcrum/core";
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
const start = (id: string): RunEvent => ({ type: "tool_start", tool_call: call(id), view: { kind: "shell", command: "log" } });
const out = (id: string, output: string, replace?: boolean): RunEvent => ({ type: "tool_output", tool_call: call(id), output, ...(replace ? { replace } : {}) });
const end = (id: string): RunEvent => ({ type: "tool_end", tool_call: call(id), tool_result: { tool_call_id: id, content: "" } });

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
const READS = ["slice", "substring", "charCodeAt", "codePointAt", "at", "charAt", "indexOf", "lastIndexOf", "includes", "match", "matchAll", "split", "replace", "search", "trim", "toLowerCase", "normalize", "localeCompare"] as const;
function spyStrings(min: number) {
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
          const site = `${kind} ${name} in ${caller.replace(/^at /, "").replace(/ \(.*\/(src|test)\//, " (").replace(/:\d+\)$/, ")")}`;
          sites[site] = (sites[site] ?? 0) + 1;
          chars += this.length;
        }
      }
      return original.apply(this, args);
    };
  }
  return { result: () => ({ sites, chars }), restore: () => { for (const [name, original] of originals) proto[name] = original; } };
}

const big = (lines: number) => "x\n".repeat(lines);
const red = (lines: number) => "\u001b[31mx\u001b[0m\n".repeat(lines);

// Appends `appends` deltas to an open output viewer over `text`; returns the spied full-length work of those appends.
function appendWork(text: string, appends: number, delta: (index: number) => string, open = true) {
  const store = createRunStore((job) => job());
  store.dispatch(start("a"));
  store.dispatch(out("a", text));
  mount(store, ["a"]);
  if (open) openViewer("a");
  expect(card("a").querySelector(open ? '[data-part="text-viewer"]' : '[data-action="open-viewer"]')).not.toBeNull();
  const spy = spyStrings(10_000);
  try {
    for (let index = 0; index < appends; index++) act(() => store.dispatch(out("a", delta(index))));
  } finally {
    spy.restore();
  }
  const work = spy.result();
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  return work;
}

const plainTail = (index: number) => `\npaired tail ${index}`;
const ansiTail = (index: number) => `\u001b[32mgreen ${index}\u001b[0m\n`;
const paths = [
  { name: "plain output", small: big(31_250), large: big(1_000_000), delta: plainTail },
  { name: "ANSI output", small: red(6_250), large: red(200_000), delta: ansiTail },
];

for (const { name, large, delta } of paths) for (const open of [true, false]) test(`an append to a large ${name} in the ${open ? "open viewer" : "closed preview"} does no full-length compare or read (exact, by hook)`, () => {
  const work = appendWork(large, 10, delta, open);
  console.log(`${name}: ${work.chars} chars of full-length work over 10 appends`, work.sites);
  // An entry names the hook and string method that touched the whole text on an append; there must be none.
  expect(work.sites).toEqual({});
});

for (const { name, small, large, delta } of paths) for (const open of [true, false]) test(`per-append work for the ${name} in the ${open ? "open viewer" : "closed preview"} is flat in its length (32x span)`, () => {
  const low = appendWork(small, 10, delta, open);
  const high = appendWork(large, 10, delta, open);
  // 32x the text; a cost proportional to the text grows 32x. The limit is near the geometric middle (sqrt 32 ~ 5.7).
  const ratio = (high.chars + 1) / (low.chars + 1);
  console.log(`${name}: ${low.chars} vs ${high.chars} chars of full-length work (${ratio.toFixed(2)}x)`);
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
const display = (id: string) => [shown(id), count(id) || (card(id).querySelector('[data-action="open-viewer"]')?.textContent ?? "")];
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
