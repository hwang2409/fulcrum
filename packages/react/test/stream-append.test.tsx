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

// Test-only spy: every String.prototype call on a stream-sized string (>= `min` UTF-16 units). A compare reads both
// strings in full; any other call can make the engine flatten a concatenated (rope) string, a full copy.
const COMPARES = ["startsWith", "endsWith"] as const;
const READS = ["slice", "substring", "charCodeAt", "codePointAt", "at", "charAt", "indexOf", "lastIndexOf", "includes", "match", "matchAll", "split", "replace", "search"] as const;
function spyStrings(min: number) {
  const counts = { compares: 0, reads: 0, chars: 0 };
  const proto = String.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const originals = [...COMPARES, ...READS].map((name) => [name, proto[name]!] as const);
  for (const [name, original] of originals) {
    const compare = (COMPARES as readonly string[]).includes(name);
    proto[name] = function (this: string, ...args: unknown[]) {
      if (this.length >= min) {
        if (compare) counts.compares++;
        else counts.reads++;
        counts.chars += this.length;
      }
      return original.apply(this, args);
    };
  }
  return { counts, restore: () => { for (const [name, original] of originals) proto[name] = original; } };
}

const big = (lines: number) => "x\n".repeat(lines);

// Appends `appends` deltas to an open viewer over `lines` lines; returns the spied work per append.
function appendWork(lines: number, appends: number) {
  const store = createRunStore((job) => job());
  store.dispatch(start("a"));
  store.dispatch(out("a", big(lines)));
  mount(store, ["a"]);
  openViewer("a");
  expect(card("a").querySelector('[data-part="text-viewer"]')).not.toBeNull();
  const spy = spyStrings(Math.min(lines, 10_000));
  try {
    for (let index = 0; index < appends; index++) act(() => store.dispatch(out("a", `\npaired tail ${index}`)));
  } finally {
    spy.restore();
  }
  return { compares: spy.counts.compares / appends, reads: spy.counts.reads / appends, chars: spy.counts.chars / appends };
}

test("an append to a 2,000,000-character open output compares and reads none of the old text", () => {
  const work = appendWork(1_000_000, 10);
  console.log(`per append: ${work.compares} full compares, ${work.reads} full reads, ${work.chars} chars handed to string methods`);
  expect(work.compares).toBe(0);
  expect(work.reads).toBe(0);
  expect(count("a")).toBe("1,000,010 lines · 2,000,140 characters");
});

test("per-append work is flat in the stream length (31,250 vs 1,000,000 lines)", () => {
  const small = appendWork(31_250, 10);
  act(() => root?.unmount());
  container.remove();
  const large = appendWork(1_000_000, 10);
  // 32x the text; a cost proportional to the text grows 32x. The limit is near the geometric middle (sqrt 32 ~ 5.7).
  const ratio = (large.chars + 1) / (small.chars + 1);
  console.log(`chars per append: ${small.chars} at 31,250 lines, ${large.chars} at 1,000,000 lines (${ratio.toFixed(2)}x)`);
  expect(ratio).toBeLessThan(5.7);
});

const ESC = "\u001b";
type Case = { name: string; events: (id: string) => RunEvent[]; text: string };
const cases: Case[] = [
  { name: "plain append", events: (id) => [out(id, "a\n"), out(id, "b"), out(id, "c\n")], text: "a\nbc\n" },
  { name: "append splitting CRLF", events: (id) => [out(id, "a\r"), out(id, "\nb\r"), out(id, "\n")], text: "a\r\nb\r\n" },
  { name: "append splitting an ANSI escape", events: (id) => [out(id, `x ${ESC}[3`), out(id, "1mred"), out(id, `${ESC}[0m done\n`)], text: "x red done\n" },
  { name: "append splitting a surrogate pair", events: (id) => [out(id, "a\ud83d"), out(id, "\ude00b")], text: "a\ud83d\ude00b" },
  { name: "append splitting a line", events: (id) => [out(id, "hel"), out(id, "lo\nwor"), out(id, "ld\n")], text: "hello\nworld\n" },
  { name: "replace", events: (id) => [out(id, "old text\n"), out(id, "new\n", true), out(id, "more\n")], text: "new\nmore\n" },
  { name: "tool_end then a new tool on the same id", events: (id) => [out(id, "first\n"), end(id), start(id), out(id, "second\n")], text: "second\n" },
];

// Each step's display after every event equals a fresh render of the same events (the full path), at a size that
// opens the viewer (incremental) and at a small size (inline).
for (const { name, events, text } of cases) for (const prefix of ["", big(60_000)]) {
  test(`${name} (${prefix ? "open viewer" : "inline"}): every step shows what a fresh render shows`, () => {
    const live = createRunStore((job) => job());
    live.dispatch(start("a"));
    if (prefix) live.dispatch(out("a", prefix));
    mount(live, ["a"]);
    openViewer("a");
    const steps = events("a");
    const seen: Array<[string, string]> = [];
    for (const event of steps) {
      act(() => live.dispatch(event));
      seen.push([shown("a"), count("a")]);
    }
    expect(seen.at(-1)![0].endsWith(text) || seen.at(-1)![0] === text).toBe(true);
    act(() => root?.unmount());
    container.remove();
    for (let step = 0; step < steps.length; step++) {
      const fresh = createRunStore((job) => job());
      fresh.dispatch(start("a"));
      if (prefix) fresh.dispatch(out("a", prefix));
      steps.slice(0, step + 1).forEach(fresh.dispatch);
      mount(fresh, ["a"]);
      openViewer("a");
      expect([shown("a"), count("a")]).toEqual(seen[step]!);
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
