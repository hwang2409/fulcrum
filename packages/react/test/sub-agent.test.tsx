import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRunStore, type RunEvent, type RunSource, type SubAgentEvent } from "@fulcrum/core";
import { Approval, RunNavigator, RunProvider, Timeline, useRunNavigation, type Renderers } from "../src/index.js";

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
  const keys = ["clientHeight", "scrollHeight", "scrollTop"] as const;
  const saved = keys.map((key) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, key));
  const positions = new WeakMap<HTMLElement, number>();
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get() { return Number.parseFloat((this as HTMLElement).querySelector<HTMLElement>('[data-part="timeline"]')?.style.height ?? "0"); } });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() { return positions.get(this as HTMLElement) ?? 0; },
    set(value: number) { positions.set(this as HTMLElement, Math.min(value, Math.max(0, (this as HTMLElement).scrollHeight - (this as HTMLElement).clientHeight))); },
  });
  restore.push(() => keys.forEach((key, index) => saved[index] && Object.defineProperty(HTMLElement.prototype, key, saved[index]!)));
}
const frames = async (count = 3) => { for (let i = 0; i < count; i++) await act(() => new Promise((resolve) => setTimeout(resolve, 20))); };
const userScroll = (scroller: HTMLElement, top: number) => act(() => {
  scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
  scroller.scrollTop = top;
  scroller.dispatchEvent(new Event("scroll"));
});

beforeEach(() => history.replaceState(null, ""));

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

  // The root crumb jumps two levels back through browser history.
  act(() => q('[data-part="run-breadcrumb"] button').click());
  await frames();
  expect(crumbs()).toEqual(["root"]);
  expect([held.get("a"), held.get("a1")]).toEqual([0, 0]);
  expect(document.activeElement).toBe(q('[data-part="sub-agent"]'));
});

test("Escape and browser back both return one level", async () => {
  const runs = { a: storeOf([commit("in-a"), child("a1")]), a1: storeOf([]) };
  const { source } = fakeSource(runs);
  mount(<RunNavigator store={storeOf([child("a")]).store} source={source} virtual={false} />);
  act(() => q('[data-part="sub-agent"]').click());
  act(() => q('[data-part="sub-agent"]').click());
  expect(all('[data-part="run-breadcrumb"] li')).toHaveLength(3);

  act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await frames();
  expect(all('[data-part="run-breadcrumb"] li')).toHaveLength(2);

  act(() => history.back());
  await frames();
  expect(all('[data-part="run-breadcrumb"] li')).toHaveLength(1);
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
  const scroller = () => q('[data-part="run-scroll"]');
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
  act(() => history.back());
  await frames();
  const node = container.querySelector<HTMLElement>('[data-part="run-scroll"]')!;
  expect(node.scrollTop).toBe(node.scrollHeight - node.clientHeight);
  expect(container.querySelector('[data-part="jump-to-latest"]')).toBeNull();
});
