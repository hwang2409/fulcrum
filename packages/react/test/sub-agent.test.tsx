import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost:3000/gallery.html" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { domShimAlarm, shimGlobal, shimProperty } from "../../../test-support/dom-shim.js";
domShimAlarm(import.meta.path);
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRunStore, type RunEvent, type RunSource, type SubAgentEvent } from "@fulcrum/core";
import { Approval, RunNavigator, RunProvider, SubAgentNavigationProvider, subAgentRow, Timeline, useHistoryRunPath, useRunNavigation, type Renderers, type RunNavigatorProps } from "../src/index.js";

afterAll(() => GlobalRegistrator.unregister());

let root: Root | undefined;
let container: HTMLElement;
const restore: Array<() => void> = [];
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  restore.splice(0).forEach((undo) => undo());
});
function mount(node: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}
const q = (selector: string) => container.querySelector(selector) as HTMLElement;
const all = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)];
const message = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const commit = (id: string): RunEvent => ({ type: "message_commit", message_id: id, message: message(id) });
const child = (childRunId: string, more: Partial<SubAgentEvent> = {}): RunEvent => ({ type: "sub_agent", childRunId, status: "running", ...more });

function storeOf(events: RunEvent[]) {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  const flush = () => jobs.splice(0).forEach((job) => job());
  events.forEach(store.dispatch);
  flush();
  return { store, send: (...more: RunEvent[]) => act(() => { more.forEach(store.dispatch); flush(); }) };
}

// A fake harness: runs it knows open, the rest are unavailable. Counts leases so tests can see releases.
function fakeSource(runs: Record<string, ReturnType<typeof storeOf>>) {
  const held = new Map<string, number>();
  const source: RunSource = {
    open(runId) {
      held.set(runId, (held.get(runId) ?? 0) + 1);
      let released = false;
      return { store: runs[runId]!.store, release() { if (released) return; released = true; held.set(runId, held.get(runId)! - 1); } };
    },
    unavailable: (runId) => (runs[runId] ? undefined : "started before child runs were recorded"),
  };
  return { source, held };
}

// happy-dom has no layout: every box is 600 px tall and scrolls the virtual timeline's estimated height.
function fakeLayout() {
  const positions = new WeakMap<HTMLElement, number>();
  restore.push(shimProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 }));
  restore.push(shimProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get() { return Number.parseFloat((this as HTMLElement).querySelector<HTMLElement>('[data-part="timeline"]')?.style.height ?? "0"); } }));
  restore.push(shimProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() { return positions.get(this as HTMLElement) ?? 0; },
    set(value: number) { positions.set(this as HTMLElement, Math.min(value, Math.max(0, (this as HTMLElement).scrollHeight - (this as HTMLElement).clientHeight))); },
  }));
}
const frames = async (count = 3) => { for (let i = 0; i < count; i++) await act(() => new Promise((resolve) => setTimeout(resolve, 20))); };
const userScroll = (scroller: HTMLElement, top: number) => act(() => {
  scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
  scroller.scrollTop = top;
  scroller.dispatchEvent(new Event("scroll"));
});

beforeEach(() => history.replaceState(null, "", "/gallery.html"));

test("the default timeline renders a sub-agent row with its facts, and with no navigator it has no drill-in", () => {
  const { store } = storeOf([
    child("a", { name: "reviewer", task: "audit auth", status: "done", toolCount: 7, latestActivity: "$ bun test", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:02:14Z" }),
  ]);
  mount(<RunProvider store={store}><Timeline /></RunProvider>);
  const row = q('[data-part="sub-agent"]');
  expect(row.tagName).toBe("DIV");
  expect(row.dataset.available).toBe("false");
  expect(q('[data-part="sub-agent-reason"]').textContent).toBe("details unavailable");
  expect(container.querySelector('[data-part="item"]')).toBeNull();
  expect(q('[data-part="sub-agent-name"]').textContent).toBe("reviewer");
  expect(q('[data-part="sub-agent-task"]').textContent).toBe("audit auth");
  expect(q('[data-part="sub-agent-status"]').textContent).toBe("done");
  expect(q('[data-part="sub-agent-meta"]').textContent).toBe("2m 14s · 7 tools");
  expect(q('[data-part="sub-agent-activity"]').textContent).toBe("$ bun test");
});

test("subAgentRow derives the badge, text, accessible name, and drill-in from the item alone", () => {
  const item = (more: Partial<SubAgentEvent>) => {
    const { store } = storeOf([child("a", more)]);
    return store.getItem("sub-agent:a") as Parameters<typeof subAgentRow>[0];
  };
  const opens = { open() {}, unavailable: () => undefined };
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  const done = subAgentRow(item({ name: "reviewer", task: "audit\n  auth", status: "done", toolCount: 1, summary: "all green", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T01:02:03Z" }), opens, 0);
  expect(done).toEqual({
    live: false, status: "done", name: "reviewer", task: "audit auth", meta: "1h 2m · 1 tool", activity: "all green", reason: undefined, canOpen: true,
    title: "reviewer\naudit auth\n1h 2m · 1 tool\nall green", label: "open reviewer sub-agent: audit auth, done, 1h 2m, 1 tool",
  });
  // Live: the elapsed time comes from the clock, and a summary is not shown as activity until the run ends.
  const live = subAgentRow(item({ startedAt: "2026-01-01T00:00:00Z", summary: "half way" }), opens, t0 + 75_000);
  expect([live.live, live.meta, live.task, live.activity, live.label]).toEqual([true, "1m 15s", "half way", undefined, "open sub-agent: half way, running, 1m 15s"]);
  // Not live without a start time, or once terminal; a terminal row with no end time stops at its last update.
  expect(subAgentRow(item({}), opens, t0).live).toBe(false);
  expect(subAgentRow(item({ status: "error", startedAt: "2026-01-01T00:00:00Z" }), opens, t0 + 9_000)).toMatchObject({ live: false, status: "failed", meta: undefined });
  expect(subAgentRow(item({ status: "canceled", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:09Z" }), opens, t0 + 99_000)).toMatchObject({ live: false, meta: "9s" });
  expect(subAgentRow(item({ status: "idle", startedAt: "2026-01-01T00:00:00Z" }), opens, t0 + 3_000)).toMatchObject({ live: true, meta: "3s" });
  expect(subAgentRow(item({ startedAt: "not a date" }), opens, t0)).toMatchObject({ live: false, meta: undefined });
  // A name with no task has no task line; nothing at all reads "sub-agent".
  expect(subAgentRow(item({ name: "tester" }), opens, 0)).toMatchObject({ name: "tester", task: undefined });
  expect(subAgentRow(item({}), opens, 0)).toMatchObject({ name: undefined, task: "sub-agent" });
  // No navigator, or one that cannot open the child: no drill-in, and the reason is the second line.
  expect(subAgentRow(item({ name: "old" }), null, 0)).toMatchObject({ canOpen: false, reason: "details unavailable", title: "old\ndetails unavailable" });
  expect(subAgentRow(item({}), { open() {}, unavailable: () => "gone" }, 0)).toMatchObject({ canOpen: false, reason: "gone" });
});

// IntersectionObserver as the browser reports it, driven by the test; and the 1 s intervals that are running.
function fakeVisibility() {
  const observers = new Set<{ callback: IntersectionObserverCallback; targets: Set<Element> }>();
  const restoreObserver = shimGlobal("IntersectionObserver", class {
    entry = { callback: (() => {}) as IntersectionObserverCallback, targets: new Set<Element>() };
    constructor(callback: IntersectionObserverCallback) { this.entry.callback = callback; observers.add(this.entry); }
    observe(target: Element) { this.entry.targets.add(target); }
    unobserve(target: Element) { this.entry.targets.delete(target); }
    disconnect() { this.entry.targets.clear(); observers.delete(this.entry); }
  } as unknown as typeof IntersectionObserver);
  const timers = new Set<unknown>();
  const [setTimer, clearTimer] = [globalThis.setInterval, globalThis.clearInterval];
  globalThis.setInterval = ((run: () => void, ms?: number) => {
    const timer = setTimer(run, ms);
    if (ms === 1_000) timers.add(timer);
    return timer;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => { timers.delete(timer); clearTimer(timer); }) as typeof clearInterval;
  let hidden = false;
  const restoreHidden = shimProperty(document, "hidden", { configurable: true, get: () => hidden });
  restore.push(() => {
    restoreHidden();
    globalThis.setInterval = setTimer;
    globalThis.clearInterval = clearTimer;
    restoreObserver();
  });
  return {
    timers: () => timers.size,
    show: (target: Element, isIntersecting: boolean) => act(() => observers.forEach((observer) => {
      if (observer.targets.has(target)) observer.callback([{ target, isIntersecting } as IntersectionObserverEntry], observer as never);
    })),
    hide: (value: boolean) => act(() => { hidden = value; document.dispatchEvent(new Event("visibilitychange")); }),
  };
}

test("the elapsed clock runs only while a live row is in view and the page is visible", () => {
  const visibility = fakeVisibility();
  const started = Date.now() - 5_000;
  const { store } = storeOf([child("a", { task: "live", startedAt: new Date(started).toISOString() }), child("b", { task: "also live", startedAt: new Date(started).toISOString() })]);
  mount(<RunProvider store={store}><Timeline virtual={false} /></RunProvider>);
  const [a, b] = all('[data-part="sub-agent"]');
  // Mounted, but outside the scroll viewport (an overscan row): no clock.
  expect(visibility.timers()).toBe(0);
  visibility.show(a!, true);
  visibility.show(b!, true);
  expect(visibility.timers()).toBe(1);
  expect(a!.querySelector('[data-part="sub-agent-meta"]')!.textContent).toBe("5s");
  visibility.show(a!, false);
  expect(visibility.timers()).toBe(1);
  visibility.show(b!, false);
  expect(visibility.timers()).toBe(0);

  visibility.show(a!, true);
  visibility.hide(true);
  expect(visibility.timers()).toBe(0);
  // Back from a background tab, the row shows the real time at once, not the time it was hidden at.
  const now = Date.now;
  Date.now = () => started + 65_000;
  restore.push(() => { Date.now = now; });
  visibility.hide(false);
  expect(visibility.timers()).toBe(1);
  expect(a!.querySelector('[data-part="sub-agent-meta"]')!.textContent).toBe("1m 5s");
  act(() => root!.unmount());
  root = undefined;
  expect(visibility.timers()).toBe(0);
});

test("each state reads in words, and a pending approval is a badge on the row", () => {
  const states = [
    child("run", { task: "running task" }),
    child("approve", { status: "waiting_approval", urgency: "approval", task: "needs a yes" }),
    child("input", { status: "waiting_input", urgency: "input" }),
    child("idle", { status: "idle" }),
    child("fail", { status: "error", summary: "tests failed" }),
    child("stop", { status: "canceled" }),
  ];
  const runs = Object.fromEntries(["run", "approve", "input", "idle", "fail", "stop"].map((id) => [id, storeOf([])]));
  const { source } = fakeSource(runs);
  mount(<RunNavigator store={storeOf(states).store} source={source} virtual={false} />);
  const words = all('[data-part="sub-agent-status"]').map((node) => node.textContent);
  expect(words).toEqual(["running", "needs approval", "needs input", "idle", "failed", "canceled"]);
  const approve = q('[data-part="sub-agent"][data-id="sub-agent:approve"]');
  expect(approve.tagName).toBe("BUTTON");
  expect(approve.dataset.urgency).toBe("approval");
  expect(approve.getAttribute("aria-label")).toBe("open sub-agent: needs a yes, needs approval");
  // With no name or task the row falls back to its summary, then to "sub-agent".
  expect(q('[data-id="sub-agent:fail"] [data-part="sub-agent-task"]').textContent).toBe("tests failed");
  expect(q('[data-id="sub-agent:idle"] [data-part="sub-agent-task"]').textContent).toBe("sub-agent");
});

test("an unavailable child shows its row and the reason, with no drill-in", () => {
  const { source, held } = fakeSource({});
  mount(<RunNavigator store={storeOf([child("old", { name: "migrator", status: "done" })]).store} source={source} virtual={false} />);
  const row = q('[data-part="sub-agent"]');
  expect(row.tagName).toBe("DIV");
  expect(row.dataset.available).toBe("false");
  expect(q('[data-part="sub-agent-reason"]').textContent).toBe("started before child runs were recorded");
  expect(held.size).toBe(0);
});

test("opening a row resolves the child through the source, nests, and releases what back leaves", async () => {
  const runs = { a: storeOf([commit("in-a"), child("a1", { name: "tester" })]), a1: storeOf([commit("in-a1")]) };
  const { source, held } = fakeSource(runs);
  mount(<RunNavigator store={storeOf([child("a", { name: "reviewer" })]).store} source={source} label="root" virtual={false} />);
  const crumbs = () => all('[data-part="run-breadcrumb"] li').map((node) => node.textContent);
  expect(crumbs()).toEqual(["root"]);

  act(() => q('[data-part="sub-agent"]').click());
  expect(crumbs()).toEqual(["root", "reviewer"]);
  expect(q('[data-part="message"]').textContent).toBe("in-a");
  expect(document.activeElement).toBe(q('[aria-current="page"]'));

  act(() => q('[data-part="sub-agent"]').click());
  expect(crumbs()).toEqual(["root", "reviewer", "tester"]);
  expect(q('[data-part="message"]').textContent).toBe("in-a1");
  expect([held.get("a"), held.get("a1")]).toEqual([1, 1]);

  // The root crumb jumps two levels back.
  act(() => q('[data-part="run-breadcrumb"] button').click());
  await frames();
  expect(crumbs()).toEqual(["root"]);
  expect([held.get("a"), held.get("a1")]).toEqual([0, 0]);
  expect(document.activeElement).toBe(q('[data-part="sub-agent"]'));
});

test("Escape and the back button each return one level, and the default navigator never touches browser history", async () => {
  const runs = { a: storeOf([commit("in-a"), child("a1")]), a1: storeOf([]) };
  const { source } = fakeSource(runs);
  const calls: string[] = [];
  for (const name of ["pushState", "replaceState", "go", "back", "forward"] as const) {
    const real = history[name];
    history[name] = ((...args: unknown[]) => { calls.push(name); return (real as (...a: unknown[]) => unknown).apply(history, args); }) as never;
    restore.push(() => { history[name] = real as never; });
  }
  const length = history.length;
  mount(<RunNavigator store={storeOf([child("a")]).store} source={source} virtual={false} />);
  act(() => q('[data-part="sub-agent"]').click());
  act(() => q('[data-part="sub-agent"]').click());
  expect(all('[data-part="run-breadcrumb"] li')).toHaveLength(3);

  act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await frames();
  expect(all('[data-part="run-breadcrumb"] li')).toHaveLength(2);
  act(() => q('[data-part="run-back"]').click());
  await frames();
  expect(all('[data-part="run-breadcrumb"] li')).toHaveLength(1);
  expect(calls).toEqual([]);
  expect(history.length).toBe(length);
});

test("a controlled path renders what the app says and reports every move through onPathChange", async () => {
  const runs = { a: storeOf([commit("in-a"), child("a1", { name: "tester" })]), a1: storeOf([commit("in-a1")]) };
  const { source, held } = fakeSource(runs);
  const parent = storeOf([child("a", { name: "reviewer" })]).store;
  const changes: Array<[readonly string[], boolean]> = [];
  const props = (path: readonly string[]): RunNavigatorProps => ({ store: parent, source, path, onPathChange: (next, { replace }) => changes.push([next, replace]), virtual: false });
  mount(<RunNavigator {...props(["a"])} />);
  expect(q('[data-part="message"]').textContent).toBe("in-a");
  // The app owns the path: a click asks, and nothing moves until the app answers.
  act(() => q('[data-part="sub-agent"]').click());
  expect(changes).toEqual([[["a", "a1"], false]]);
  expect(q('[data-part="message"]').textContent).toBe("in-a");
  act(() => root!.render(<RunNavigator {...props(["a", "a1"])} />));
  expect(q('[data-part="message"]').textContent).toBe("in-a1");
  expect([held.get("a"), held.get("a1")]).toEqual([1, 1]);
  // A new array with the same ids is the same path: no lease is taken again.
  act(() => root!.render(<RunNavigator {...props(["a", "a1"])} />));
  expect([held.get("a"), held.get("a1")]).toEqual([1, 1]);
  act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  act(() => q('[data-part="run-back"]').click());
  act(() => q('[data-part="run-breadcrumb"] button').click());
  expect(changes.slice(1)).toEqual([[["a"], false], [["a"], false], [[], false]]);
  act(() => root!.render(<RunNavigator {...props([])} />));
  expect([held.get("a"), held.get("a1")]).toEqual([0, 0]);
});

test("a deep link to a run that cannot open falls back to its deepest valid ancestor, with a notice", async () => {
  const runs = { a: storeOf([commit("in-a"), child("gone", { name: "migrator" })]) };
  const { source, held } = fakeSource(runs);
  const changes: Array<[readonly string[], boolean]> = [];
  mount(<RunNavigator store={storeOf([child("a")]).store} source={source} path={["a", "gone", "deeper"]} onPathChange={(next, { replace }) => changes.push([next, replace])} virtual={false} />);
  await frames(1);
  expect(q('[data-part="message"]').textContent).toBe("in-a");
  expect(changes).toEqual([[["a"], true]]);
  expect(q('[data-part="run-notice"]').textContent).toBe("could not open migrator: started before child runs were recorded");
  expect(held.get("a")).toBe(1);
});

test("a path that repeats a run, or the root, is a cycle: it stops at the first repeat", async () => {
  const runs = { a: storeOf([commit("in-a"), child("root"), child("a")]) };
  const { source, held } = fakeSource(runs);
  const changes: Array<readonly string[]> = [];
  mount(<RunNavigator store={storeOf([child("a")]).store} runId="root" source={source} path={["a", "a"]} onPathChange={(next) => changes.push(next)} virtual={false} />);
  await frames(1);
  expect(changes).toEqual([["a"]]);
  expect(q('[data-part="run-notice"]').textContent).toBe("could not open sub-agent: already open above");
  expect(held.get("a")).toBe(1);
  // Inside a, the rows for the root and for a itself say why they cannot open.
  expect(all('[data-part="sub-agent-reason"]').map((node) => node.textContent)).toEqual(["already open above", "already open above"]);
});

// A source whose opens settle when the test says, in any order.
function deferredSource(runs: Record<string, ReturnType<typeof storeOf>>) {
  type Call = { runId: string; signal: AbortSignal; released: boolean; resolve(): void; reject(reason: Error): void };
  const calls: Call[] = [];
  const source: RunSource = {
    open: (runId, { signal }) => new Promise((resolve, reject) => {
      const call: Call = {
        runId, signal, released: false, reject,
        resolve: () => resolve({ store: runs[runId]!.store, release() { call.released = true; } }),
      };
      calls.push(call);
    }),
  };
  const settle = (call: Call, how: "resolve" | "reject") => act(async () => {
    if (how === "resolve") call.resolve();
    else call.reject(new Error(`${call.runId} broke`));
    await new Promise((done) => setTimeout(done, 0));
  });
  return { source, calls, settle };
}

test("only the latest open shows: a stale resolve is released at once, a stale failure never shows", async () => {
  const runs = { a: storeOf([commit("in-a")]), b: storeOf([commit("in-b")]) };
  const { source, calls, settle } = deferredSource(runs);
  mount(<RunNavigator store={storeOf([child("a", { name: "first" }), child("b", { name: "second" })]).store} source={source} virtual={false} />);
  const open = (runId: string) => act(() => q(`[data-part="sub-agent"][data-id="sub-agent:${runId}"]`).click());
  open("a");
  expect(q('[data-part="run-navigator"]').getAttribute("aria-busy")).toBe("true");
  open("b");
  const [a, b] = calls;
  expect(a!.signal.aborted).toBe(true);
  expect(b!.signal.aborted).toBe(false);
  // The newer open lands first, then the older one: the older is released and never shown.
  await settle(b!, "resolve");
  expect(q('[data-part="message"]').textContent).toBe("in-b");
  await settle(a!, "resolve");
  expect(a!.released).toBe(true);
  expect(q('[data-part="message"]').textContent).toBe("in-b");
  expect(b!.released).toBe(false);
  expect(q('[data-part="run-navigator"]').hasAttribute("aria-busy")).toBe(false);

  // Back at the root: an older open fails after a newer one starts. Its error never shows.
  act(() => q('[data-part="run-back"]').click());
  expect(b!.released).toBe(true);
  open("a");
  open("b");
  const [a2, b2] = calls.slice(2);
  await settle(a2!, "reject");
  expect(q('[data-part="run-notice"]').textContent).toBe("");
  // The newer one failing does show.
  await settle(b2!, "reject");
  expect(q('[data-part="run-notice"]').textContent).toBe("could not open second: b broke");
  expect(all('[data-part="run-breadcrumb"] li')).toHaveLength(1);
});

test("Escape cancels a pending open, and unmount aborts pending opens and releases late leases", async () => {
  const runs = { a: storeOf([commit("in-a")]) };
  const { source, calls, settle } = deferredSource(runs);
  mount(<RunNavigator store={storeOf([child("a")]).store} source={source} virtual={false} />);
  act(() => q('[data-part="sub-agent"]').click());
  act(() => q('[data-part="sub-agent"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(calls[0]!.signal.aborted).toBe(true);
  await settle(calls[0]!, "resolve");
  expect(calls[0]!.released).toBe(true);
  expect(all('[data-part="run-breadcrumb"] li')).toHaveLength(1);

  act(() => q('[data-part="sub-agent"]').click());
  act(() => root!.unmount());
  root = undefined;
  expect(calls[1]!.signal.aborted).toBe(true);
  await settle(calls[1]!, "resolve");
  expect(calls[1]!.released).toBe(true);
});

test("a new root store while drilled in returns to the root, releases the children, and says so", async () => {
  const runs = { a: storeOf([commit("in-a")]) };
  const { source, held } = fakeSource(runs);
  const changes: Array<[readonly string[], boolean]> = [];
  const onPathChange: RunNavigatorProps["onPathChange"] = (next, { replace }) => changes.push([next, replace]);
  mount(<RunNavigator store={storeOf([child("a")]).store} source={source} label="root" onPathChange={onPathChange} virtual={false} />);
  act(() => q('[data-part="sub-agent"]').click());
  expect(held.get("a")).toBe(1);
  act(() => root!.render(<RunNavigator store={storeOf([commit("new-root")]).store} source={source} label="root" onPathChange={onPathChange} virtual={false} />));
  expect(all('[data-part="run-breadcrumb"] li')).toHaveLength(1);
  expect(q('[data-part="message"]').textContent).toBe("new-root");
  expect(held.get("a")).toBe(0);
  expect(q('[data-part="run-notice"]').textContent).toBe("the run changed; back at root");
  expect(changes).toEqual([[["a"], false], [[], true]]);

  // A controlled path is the app's to reset: the child stays open under the new root until the app moves it.
  const next = storeOf([child("a")]).store;
  act(() => root!.render(<RunNavigator store={next} source={source} path={["a"]} virtual={false} />));
  act(() => root!.render(<RunNavigator store={storeOf([]).store} source={source} path={["a"]} virtual={false} />));
  expect(q('[data-part="message"]').textContent).toBe("in-a");
  expect(held.get("a")).toBe(1);
});

function HistoryNavigator({ historyKey = "run", ...props }: Omit<RunNavigatorProps, "path" | "onPathChange"> & { historyKey?: string }) {
  return <RunNavigator {...props} {...useHistoryRunPath(historyKey)} />;
}
const historyRuns = () => {
  const runs = { a: storeOf([commit("in-a"), child("a1", { name: "tester" })]), a1: storeOf([commit("in-a1")]) };
  return { ...fakeSource(runs), store: storeOf([child("a", { name: "reviewer" })]).store };
};
const crumbs = (scope: ParentNode = container) => scope.querySelectorAll('[data-part="run-breadcrumb"] li').length;
const runParams = (key = "run") => new URL(location.href).searchParams.getAll(key);
const escape = () => act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
const browserBack = async () => {
  act(() => history.back());
  await frames();
};

test("useHistoryRunPath: every user move pushes like a link, browser back follows the URL, other URL parts stay", async () => {
  const { source, store } = historyRuns();
  history.replaceState({ app: 1 }, "", "/gallery.html?theme=dracula#demo");
  const start = history.length;
  mount(<HistoryNavigator store={store} source={source} virtual={false} />);
  act(() => q('[data-part="sub-agent"]').click());
  act(() => q('[data-part="sub-agent"]').click());
  expect(crumbs()).toBe(3);
  expect(runParams()).toEqual(["a", "a1"]);
  expect(new URL(location.href).searchParams.get("theme")).toBe("dracula");
  expect(location.hash).toBe("#demo");
  expect(history.state.app).toBe(1);
  expect(history.length).toBe(start + 2);
  await browserBack();
  expect(crumbs()).toBe(2);
  expect(runParams()).toEqual(["a"]);
  // Escape is a move up, like a link to the parent: one new entry, and browser back returns to where it was.
  escape();
  await frames();
  expect(crumbs()).toBe(1);
  expect(runParams()).toEqual([]);
  expect(history.state.app).toBe(1);
  await browserBack();
  expect(crumbs()).toBe(2);
  expect(runParams()).toEqual(["a"]);
  act(() => q('[data-part="run-back"]').click());
  await frames();
  expect(runParams()).toEqual([]);
  expect(location.hash).toBe("#demo");
});

test("useHistoryRunPath: unmounting after a host router moved on leaves the router's URL", async () => {
  const { source, store, held } = historyRuns();
  history.replaceState(null, "", "/route-a");
  mount(<HistoryNavigator store={store} source={source} virtual={false} />);
  act(() => q('[data-part="sub-agent"]').click());
  expect(location.pathname + location.search).toBe("/route-a?run=a");
  // A router opens its next route, keeping the query and merging history state, then unmounts the old page.
  history.pushState({ ...history.state, router: "b" }, "", "/route-b?run=a");
  const length = history.length;
  act(() => root!.unmount());
  root = undefined;
  await frames(5);
  expect(location.pathname + location.search).toBe("/route-b?run=a");
  expect(history.state.router).toBe("b");
  expect(history.length).toBe(length);
  expect(held.get("a")).toBe(0);
});

test("useHistoryRunPath: a hash entry made after opening a run does not stop back from closing it", async () => {
  const { source, store } = historyRuns();
  history.replaceState(null, "", "/gallery.html");
  mount(<HistoryNavigator store={store} source={source} virtual={false} />);
  act(() => q('[data-part="sub-agent"]').click());
  act(() => { location.hash = "section"; });
  await frames();
  expect(runParams()).toEqual(["a"]);
  expect(crumbs()).toBe(2);
  act(() => q('[data-part="run-back"]').click());
  await frames();
  expect(crumbs()).toBe(1);
  expect(runParams()).toEqual([]);
  expect(location.hash).toBe("#section");
});

test("useHistoryRunPath: reload and deep links open the URL's path without writing; a run that cannot open is corrected in place", async () => {
  const { source, store } = historyRuns();
  history.replaceState({ app: 1 }, "", "/gallery.html?run=a&run=a1");
  const length = history.length;
  mount(<HistoryNavigator store={store} source={source} virtual={false} />);
  await frames(1);
  expect(crumbs()).toBe(3);
  expect(q('[data-part="message"]').textContent).toBe("in-a1");
  expect(history.length).toBe(length);
  act(() => root!.unmount());
  root = undefined;
  expect(location.search).toBe("?run=a&run=a1");

  history.replaceState(null, "", "/gallery.html?run=a&run=nope");
  mount(<HistoryNavigator store={store} source={source} virtual={false} />);
  await frames(1);
  expect(crumbs()).toBe(2);
  expect(runParams()).toEqual(["a"]);
  expect(history.length).toBe(length);
  expect(q('[data-part="run-notice"]').textContent).toBe("could not open nope: started before child runs were recorded");
});

test("useHistoryRunPath: two navigators with different keys each follow their own parameter", async () => {
  const left = historyRuns();
  const right = historyRuns();
  history.replaceState(null, "", "/gallery.html");
  mount(<>
    <div id="left"><HistoryNavigator historyKey="left" store={left.store} source={left.source} virtual={false} /></div>
    <div id="right"><HistoryNavigator historyKey="right" store={right.store} source={right.source} virtual={false} /></div>
  </>);
  const [one, two] = [q("#left"), q("#right")];
  act(() => one.querySelector<HTMLElement>('[data-part="sub-agent"]')!.click());
  act(() => two.querySelector<HTMLElement>('[data-part="sub-agent"]')!.click());
  expect([runParams("left"), runParams("right")]).toEqual([["a"], ["a"]]);
  expect([crumbs(one), crumbs(two)]).toEqual([2, 2]);
  await browserBack();
  expect([runParams("left"), runParams("right")]).toEqual([["a"], []]);
  expect([crumbs(one), crumbs(two)]).toEqual([2, 1]);
});

test("useHistoryRunPath: strict mode's double mount writes nothing and unmount leaves the URL", async () => {
  const { source, store } = historyRuns();
  history.replaceState(null, "", "/gallery.html?run=a");
  const length = history.length;
  mount(<StrictMode><HistoryNavigator store={store} source={source} virtual={false} /></StrictMode>);
  await frames();
  expect(crumbs()).toBe(2);
  expect(history.length).toBe(length);
  act(() => q('[data-part="sub-agent"]').click());
  expect(runParams()).toEqual(["a", "a1"]);
  act(() => root!.unmount());
  root = undefined;
  await frames(5);
  expect(runParams()).toEqual(["a", "a1"]);
  expect(history.length).toBe(length + 1);
});

test("run-history.ts never moves through the history list", async () => {
  const source = await Bun.file(new URL("../src/run-history.ts", import.meta.url)).text();
  expect(["history.back", "history.go(", "traverseTo", "history.forward"].filter((call) => source.includes(call))).toEqual([]);
});

test("a pending approval in a child shows on the parent row and the breadcrumb, and resolves from inside the child", async () => {
  const parent = storeOf([child("a", { name: "reviewer", status: "waiting_approval", urgency: "approval" })]);
  const runs = { a: storeOf([{ type: "approval_request", request_id: "r1", tool_call: { id: "t1", name: "bash", arguments: { command: "rm -rf .cache" } }, delegated: true }]) };
  const { source } = fakeSource(runs);
  const decided: string[] = [];
  function RoutedApproval({ id }: { id: string }) {
    const { path } = useRunNavigation()!;
    const runId = path.at(-1)!.runId!;
    return <Approval id={id} onApprove={(requestId) => {
      decided.push(`${runId}:${requestId}`);
      runs.a.send({ type: "approval_end", request_id: requestId });
      parent.send(child(runId, { status: "running" }));
    }} />;
  }
  const renderers: Renderers = { approval: RoutedApproval };
  mount(<RunNavigator store={parent.store} source={source} renderers={renderers} virtual={false} />);
  expect(q('[data-part="sub-agent"]').dataset.urgency).toBe("approval");
  act(() => q('[data-part="sub-agent"]').click());
  expect(q('[data-part="run-breadcrumb"] [aria-current="page"] [data-part="run-urgency"]').textContent).toBe("needs approval");

  act(() => q('[data-action="approve"]').click());
  expect(decided).toEqual(["a:r1"]);
  expect(container.querySelector('[data-part="run-urgency"]')).toBeNull();
  // The resolved approval's buttons are gone, so focus fell to the body; Escape there still goes back.
  (document.activeElement as HTMLElement | null)?.blur();
  act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await frames();
  expect(q('[data-part="sub-agent"]').dataset.urgency).toBeUndefined();
});

test("back restores the parent's exact scroll anchor and released follow mode", async () => {
  fakeLayout();
  const events = Array.from({ length: 300 }, (_, index) => (index === 150 ? child("a", { name: "reviewer" }) : commit(`m${index}`)));
  const parent = storeOf(events);
  const { source } = fakeSource({ a: storeOf(Array.from({ length: 50 }, (_, index) => commit(`c${index}`))) });
  mount(<RunNavigator store={parent.store} source={source} />);
  const scroller = () => q('[data-part="timeline-scroll"]');
  await frames();
  const bottom = scroller().scrollHeight - scroller().clientHeight;
  expect(scroller().scrollTop).toBe(bottom);
  // 150 messages at the 72 px estimate put the row at 10,800 px; read from 30 px above it.
  userScroll(scroller(), 10_770);
  await frames();
  const rowTop = scroller().scrollTop;
  expect(rowTop).toBe(10_770);

  act(() => q('[data-part="sub-agent"]').click());
  await frames();
  expect(q('[data-part="message"]').textContent).toStartWith("c");
  // A never-viewed child opens at its newest item.
  expect(scroller().scrollTop).toBe(scroller().scrollHeight - scroller().clientHeight);
  parent.send(commit("while-away"));

  act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await frames();
  expect(scroller().scrollTop).toBe(rowTop);
  expect(document.activeElement).toBe(q('[data-part="sub-agent"]'));
  // Follow stays released: a new parent item does not pull the view down.
  parent.send(commit("after-return"));
  await frames();
  expect(scroller().scrollTop).toBe(rowTop);

  // A child read before reopens where it was left, not at its newest item.
  act(() => q('[data-part="sub-agent"]').click());
  await frames();
  userScroll(scroller(), 1_000);
  await frames();
  act(() => q('[data-part="run-back"]').click());
  await frames();
  act(() => q('[data-part="sub-agent"]').click());
  await frames();
  expect(scroller().scrollTop).toBe(1_000);
});

test("back to a parent that was following resumes at its new bottom", async () => {
  fakeLayout();
  const parent = storeOf([...Array.from({ length: 250 }, (_, index) => commit(`m${index}`)), child("a")]);
  const { source } = fakeSource({ a: storeOf([commit("c")]) });
  mount(<RunNavigator store={parent.store} source={source} />);
  await frames();
  act(() => q('[data-part="sub-agent"]').click());
  await frames();
  parent.send(commit("while-away-1"), commit("while-away-2"));
  act(() => q('[data-part="run-back"]').click());
  await frames();
  const node = container.querySelector<HTMLElement>('[data-part="timeline-scroll"]')!;
  expect(node.scrollTop).toBe(node.scrollHeight - node.clientHeight);
  expect(container.querySelector('[data-part="jump-to-latest"]')).toBeNull();
});
