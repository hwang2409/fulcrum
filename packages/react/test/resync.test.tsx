import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRunStore, type RunEvent } from "@fulcrum/core";
import { createRunSearch } from "@fulcrum/core/search";
import { RunProvider, Timeline, useItem } from "../src/index.js";

// A resync is a discontinuity: the store publishes `change: null` and every consumer of the outline takes it whole.
// One row per resync case; one column per store consumer that reacts to the outline change. A new consumer is one
// more probe below and one more column in `expected`.

const call = (id: string) => ({ id, name: "read", arguments: {} });
const tool = (id: string): RunEvent[] => [
  { type: "tool_start", tool_call: call(id) },
  { type: "tool_end", tool_call: call(id), tool_result: { tool_call_id: id, content: `out ${id}`, is_error: false } },
];
const tools = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => tool(`${prefix}${index}`)).flat();
const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `tool:${prefix}${index}`);

type Observed = {
  /** Outline subscriber notes and what the store published after the resync. */
  store: { notes: number; change: "null" | "edit" | "none" };
  /** Keyed subscriptions on these ids: how many times each listener ran. */
  keyed: Record<string, number>;
  /** createRunSearch results for "read" (the tool name), in outline order. */
  search: string[];
  /** Live region text of the virtual Timeline after the announce window. */
  announce: string;
  /** Virtual Timeline: outline size, last mounted row, and reading position (scrollTop, distance from the bottom, unseen). */
  virtual: { rows: number; lastMounted: string | undefined; scrollTop: number; fromBottom: number; unseen: number };
  /** Plain Timeline: rendered row ids and its live region text. */
  plain: { rows: string[]; announce: string };
};
type Row = {
  name: string;
  setup: RunEvent[];
  /** Dispatched and flushed by a read (as apps/web does before resync), but its frame has not run. */
  pending?: RunEvent[];
  replay: RunEvent[];
  reader: "following" | "reading";
  expected: Observed;
};

const watchedIds = ["tool:a0", "tool:a19", "tool:b0", "tool:new", "tool:x"];
const keyedFor = (...touched: string[]) => Object.fromEntries(touched.map((id) => [id, 1]));
const noKeyed: Record<string, number> = {};
// 20 tool rows at the 120 px estimate in a 600 px viewport: the bottom is scrollTop 1,800; a reader 1,000 px up sits at 800.
const following = (scrollTop: number) => ({ scrollTop, fromBottom: 0, unseen: 0 });

const rows: Row[] = [
  {
    name: "empty -> rows", setup: [], replay: tools("a", 20), reader: "following",
    expected: { store: { notes: 1, change: "null" }, keyed: keyedFor("tool:a0", "tool:a19"), search: ids("a", 20), announce: "", virtual: { rows: 20, lastMounted: "tool:a19", ...following(1_800) }, plain: { rows: ids("a", 20), announce: "" } },
  },
  {
    name: "same ids, nothing pending", setup: tools("a", 20), replay: tools("a", 20), reader: "following",
    expected: { store: { notes: 0, change: "null" }, keyed: keyedFor("tool:a0", "tool:a19"), search: ids("a", 20), announce: "", virtual: { rows: 20, lastMounted: "tool:a19", ...following(1_800) }, plain: { rows: ids("a", 20), announce: "" } },
  },
  {
    name: "reconnect with one missed row (following)", setup: tools("a", 20), replay: [...tools("a", 20), ...tool("new")], reader: "following",
    expected: { store: { notes: 1, change: "null" }, keyed: keyedFor("tool:a0", "tool:a19", "tool:new"), search: [...ids("a", 20), "tool:new"], announce: "tool read finished", virtual: { rows: 21, lastMounted: "tool:new", ...following(1_920) }, plain: { rows: [...ids("a", 20), "tool:new"], announce: "tool read finished" } },
  },
  {
    name: "reconnect with one missed row (reading older rows)", setup: tools("a", 20), replay: [...tools("a", 20), ...tool("new")], reader: "reading",
    expected: { store: { notes: 1, change: "null" }, keyed: keyedFor("tool:a0", "tool:a19", "tool:new"), search: [...ids("a", 20), "tool:new"], announce: "tool read finished", virtual: { rows: 21, lastMounted: "tool:a16", scrollTop: 800, fromBottom: 1_120, unseen: 0 }, plain: { rows: [...ids("a", 20), "tool:new"], announce: "tool read finished" } },
  },
  {
    name: "same ids, pending change", setup: tools("a", 20), pending: tool("x"), replay: [...tools("a", 20), ...tool("x")], reader: "following",
    expected: { store: { notes: 1, change: "null" }, keyed: keyedFor("tool:a0", "tool:a19", "tool:x"), search: [...ids("a", 20), "tool:x"], announce: "tool read finished", virtual: { rows: 21, lastMounted: "tool:x", ...following(1_920) }, plain: { rows: [...ids("a", 20), "tool:x"], announce: "tool read finished" } },
  },
  {
    name: "different ids (reading older rows)", setup: tools("a", 20), replay: tools("b", 20), reader: "reading",
    expected: { store: { notes: 1, change: "null" }, keyed: keyedFor("tool:a0", "tool:a19", "tool:b0"), search: ids("b", 20), announce: "", virtual: { rows: 20, lastMounted: "tool:b16", scrollTop: 800, fromBottom: 1_000, unseen: 0 }, plain: { rows: ids("b", 20), announce: "" } },
  },
  {
    name: "rows -> empty", setup: tools("a", 20), replay: [], reader: "following",
    expected: { store: { notes: 1, change: "null" }, keyed: keyedFor("tool:a0", "tool:a19"), search: [], announce: "", virtual: { rows: 0, lastMounted: undefined, ...following(0) }, plain: { rows: [], announce: "" } },
  },
  {
    name: "pending change, empty replacement", setup: tools("a", 20), pending: tool("x"), replay: [], reader: "following",
    expected: { store: { notes: 1, change: "null" }, keyed: keyedFor("tool:a0", "tool:a19", "tool:x"), search: [], announce: "", virtual: { rows: 0, lastMounted: undefined, ...following(0) }, plain: { rows: [], announce: "" } },
  },
];

const descriptors = new Map<string, PropertyDescriptor | undefined>();
const positions = new WeakMap<HTMLElement, number>();
beforeAll(() => {
  for (const key of ["clientHeight", "scrollHeight", "scrollTop"]) descriptors.set(key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key));
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) { return Number.parseFloat(this.querySelector<HTMLElement>('[data-part="timeline"]')?.style.height || "0"); },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) { return positions.get(this) ?? 0; },
    set(this: HTMLElement, value: number) { positions.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))); },
  });
});
afterAll(() => {
  for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
  GlobalRegistrator.unregister();
});

let root: Root | undefined;
let container: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
});

test.each(rows)("resync reaches every outline consumer whole: $name", async ({ setup, pending, replay, reader, expected }) => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  const drain = () => act(() => { while (jobs.length > 0) jobs.shift()!(); });
  setup.forEach(store.dispatch);
  drain();

  // probes: store outline notes, keyed listeners, search, and two Timelines (virtual and plain) on the same store.
  let notes = 0;
  store.subscribeOutline(() => { notes++; });
  const keyed: Record<string, number> = {};
  for (const id of watchedIds) store.subscribe(id, () => { keyed[id] = (keyed[id] ?? 0) + 1; });
  const search = createRunSearch(store, { maxItems: 1_000, maxCharsPerItem: 10_000 });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(
    <RunProvider store={store}>
      <section data-probe="virtual"><Timeline virtual /></section>
      <section data-probe="plain"><Timeline virtual={false} /></section>
    </RunProvider>,
  ));
  const part = (probe: string, name: string) => container!.querySelector<HTMLElement>(`[data-probe="${probe}"] [data-part="${name}"]`)!;
  const scroller = part("virtual", "timeline-scroll");
  if (reader === "reading" && scroller.scrollHeight > 600) {
    scroller.scrollTop -= 1_000;
    act(() => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      scroller.dispatchEvent(new Event("scroll"));
    });
  }

  if (pending) pending.forEach(store.dispatch), store.getState();
  act(() => store.resync(replay));
  const published = store.getOutlineSnapshot();
  drain();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_050)); });

  const timeline = part("virtual", "timeline");
  const observed: Observed = {
    store: { notes, change: published.change === null ? "null" : published.change.splices.length > 0 ? "edit" : "none" },
    keyed,
    search: search.query("read").results.map(({ id }) => id),
    announce: part("virtual", "timeline-live").textContent ?? "",
    virtual: {
      rows: Number(timeline.querySelector("[data-virtual-id]")?.getAttribute("aria-setsize") ?? 0),
      lastMounted: [...timeline.querySelectorAll<HTMLElement>("[data-virtual-id]")].at(-1)?.dataset.virtualId,
      scrollTop: scroller.scrollTop,
      fromBottom: Math.max(0, scroller.scrollHeight - scroller.clientHeight) - scroller.scrollTop,
      unseen: Number(timeline.dataset.unseenCount ?? 0),
    },
    plain: {
      rows: [...part("plain", "timeline").querySelectorAll<HTMLElement>(':scope > [data-id]')].map((row) => row.dataset.id!),
      announce: part("plain", "timeline-live").textContent ?? "",
    },
  };
  search.dispose();
  expect(observed).toEqual(expected);
});

// notify delivers a snapshot: a resync called from inside a store listener reaches every consumer on the next pass.
// The keyed caller resyncs from tool:a1's listener, after tool:a0's listener already ran in the same pass.
test.each(["global", "outline", "keyed"] as const)("resync called from a %s listener reaches every consumer", (from) => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  const drain = () => act(() => { while (jobs.length > 0) jobs.shift()!(); });
  let resynced = false;
  const trigger = () => { if (!resynced) resynced = true, store.resync(tool("b0")); };
  if (from === "global") store.subscribe(trigger);
  if (from === "outline") store.subscribeOutline(trigger);
  if (from === "keyed") store.subscribe("tool:a1", trigger);
  const Probe = ({ id }: { id: string }) => <i data-probe-item={id}>{useItem(id)?.id ?? "missing"}</i>;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(
    <RunProvider store={store}>
      {["tool:a0", "tool:a1", "tool:b0"].map((id) => <Probe key={id} id={id} />)}
      <section data-probe="plain"><Timeline virtual={false} /></section>
    </RunProvider>,
  ));
  tools("a", 2).forEach(store.dispatch);
  drain();
  const probes = Object.fromEntries([...container.querySelectorAll<HTMLElement>("[data-probe-item]")].map((el) => [el.dataset.probeItem!, el.textContent]));
  const rows = [...container.querySelectorAll<HTMLElement>('[data-probe="plain"] [data-part="timeline"] > [data-id]')].map((row) => row.dataset.id);
  expect({ resynced, probes, rows }).toEqual({
    resynced: true,
    probes: { "tool:a0": "missing", "tool:a1": "missing", "tool:b0": "tool:b0" },
    rows: ["tool:b0"],
  });
});
