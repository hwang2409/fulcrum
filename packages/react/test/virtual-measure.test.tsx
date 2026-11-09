import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createRunStore, type RunEvent } from "@fulcrum/core";
import { RunProvider, Timeline, type TimelineViewport } from "../src/index.js";

afterAll(() => GlobalRegistrator.unregister());

const commits = (prefix: string, count: number): RunEvent[] => Array.from({ length: count }, (_, index) => (
  { type: "message_commit", message_id: `${prefix}-${index}`, message: { role: "assistant", content: [{ type: "text", text: `${prefix}-${index}` }] } }
));

test("same-run replay drops the cached height of a changed streamed row", () => {
  const observers: Array<{ report: ResizeObserverCallback; observed: Set<Element> }> = [];
  const frames: FrameRequestCallback[] = [];
  const saved = { ResizeObserver: globalThis.ResizeObserver, raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
  globalThis.ResizeObserver = class {
    private entry = { report: (() => {}) as ResizeObserverCallback, observed: new Set<Element>() };
    constructor(callback: ResizeObserverCallback) { this.entry.report = callback; observers.push(this.entry); }
    observe(element: Element) { this.entry.observed.add(element); }
    unobserve(element: Element) { this.entry.observed.delete(element); }
    disconnect() { this.entry.observed.clear(); }
  } as unknown as typeof ResizeObserver;
  globalThis.requestAnimationFrame = (callback) => (frames.push(callback), frames.length);
  globalThis.cancelAnimationFrame = () => {};
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let unmounted = false;
  try {
    const events = commits("row", 201);
    const first = createRunStore((flush) => flush(), { runId: "same-run" });
    first.resync(events);
    const second = createRunStore((flush) => flush(), { runId: "same-run" });
    second.resync(events.map((event, index) => index === 200 && event.type === "message_commit"
      ? { ...event, message: { ...event.message, content: [{ type: "text", text: "final text ".repeat(40) }] } }
      : event));
    let viewport: TimelineViewport | undefined;
    const view = (store: typeof first) => <RunProvider store={store}><Timeline virtual onViewport={(next) => { viewport = next; }} /></RunProvider>;
    act(() => root.render(view(first)));
    const rows = observers.find(({ observed }) => [...observed].some((element) => element.hasAttribute("data-virtual-id")))!;
    const entries = [...rows.observed].map((target) => ({ target, borderBoxSize: [{ blockSize: target.getAttribute("data-virtual-id") === "message:row-200" ? 80 : 40, inlineSize: 800 }], contentRect: { height: 40 } }));
    act(() => rows.report(entries as unknown as ResizeObserverEntry[], {} as ResizeObserver));
    act(() => { for (const frame of frames.splice(0)) frame(0); });
    act(() => root.render(view(second)));
    act(() => root.unmount());
    unmounted = true;
    expect(viewport?.cache?.sizes).toContainEqual(["message:row-199", 40]);
    expect(viewport?.cache?.sizes.find(([id]) => id === "message:row-200")).toBeUndefined();
  } finally {
    if (!unmounted) act(() => root.unmount());
    container.remove();
    globalThis.ResizeObserver = saved.ResizeObserver;
    globalThis.requestAnimationFrame = saved.raf;
    globalThis.cancelAnimationFrame = saved.caf;
    if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
  }
});

test("a pinned late row measurement re-applies the bottom after the browser shifts the range", () => {
  const observers: Array<{ report: ResizeObserverCallback; observed: Set<Element> }> = [];
  const frames: FrameRequestCallback[] = [];
  const saved = { ResizeObserver: globalThis.ResizeObserver, raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
  globalThis.ResizeObserver = class {
    private entry = { report: (() => {}) as ResizeObserverCallback, observed: new Set<Element>() };
    constructor(callback: ResizeObserverCallback) { this.entry.report = callback; observers.push(this.entry); }
    observe(element: Element) { this.entry.observed.add(element); }
    unobserve(element: Element) { this.entry.observed.delete(element); }
    disconnect() { this.entry.observed.clear(); }
  } as unknown as typeof ResizeObserver;
  globalThis.requestAnimationFrame = (callback) => (frames.push(callback), frames.length);
  globalThis.cancelAnimationFrame = () => {};
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    const store = createRunStore((flush) => flush());
    store.resync(commits("late", 201));
    act(() => root.render(<RunProvider store={store}><Timeline virtual /></RunProvider>));
    const scroll = container.querySelector<HTMLElement>('[data-part="timeline-scroll"]');
    expect(scroll).not.toBeNull();
    // The pinned reader sits where the adapter put it, the engine's end; a browser cannot hold another position
    // without a scroll callback. The DOM range is two pixels taller than the virtualizer's measured range, as WebKit
    // can report after reconnect, so the row observer must take the reader to the DOM end.
    let scrollTop = 201 * 72 + 16 - 600;
    const scrollHeight = 201 * 72 + 16 + 2;
    Object.defineProperty(scroll!, "scrollTop", { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
    Object.defineProperty(scroll!, "scrollHeight", { configurable: true, get: () => scrollHeight });
    const rows = observers.find(({ observed }) => [...observed].some((element) => element.hasAttribute("data-virtual-id")));
    expect(rows).toBeDefined();
    const target = [...rows!.observed][0]!;
    const timeline = container.querySelector<HTMLElement>('[data-part="timeline"]')!;
    const heightBefore = Number.parseFloat(timeline.style.height);
    act(() => rows!.report([{ target, borderBoxSize: [{ blockSize: 120, inlineSize: 800 }], contentRect: { height: 120 } }] as unknown as ResizeObserverEntry[], {} as ResizeObserver));
    expect(Number.parseFloat(timeline.style.height), "the ResizeObserver delivery must commit the measured extent before the next frame").toBeGreaterThan(heightBefore);
    act(() => { for (const frame of frames.splice(0)) frame(0); });
    expect(scrollHeight - 600 - scrollTop).toBeLessThanOrEqual(0.5);
  } finally {
    act(() => root.unmount());
    container.remove();
    globalThis.ResizeObserver = saved.ResizeObserver;
    globalThis.requestAnimationFrame = saved.raf;
    globalThis.cancelAnimationFrame = saved.caf;
    if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
  }
});

test("a row resize reported just before a resync replaces its id is not measured into the new outline", () => {
  // A controllable ResizeObserver and frame queue: the browser reports a resize, then React commits before the frame.
  // Timeline has two observers (rows and the viewport); keep each one's callback and targets.
  const observers: Array<{ report: ResizeObserverCallback; observed: Set<Element> }> = [];
  const frames: FrameRequestCallback[] = [];
  const saved = { ResizeObserver: globalThis.ResizeObserver, raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
  globalThis.ResizeObserver = class {
    private entry = { report: (() => {}) as ResizeObserverCallback, observed: new Set<Element>() };
    constructor(callback: ResizeObserverCallback) { this.entry.report = callback; observers.push(this.entry); }
    observe(element: Element) { this.entry.observed.add(element); }
    unobserve(element: Element) { this.entry.observed.delete(element); }
    disconnect() { this.entry.observed.clear(); }
  } as unknown as typeof ResizeObserver;
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  globalThis.cancelAnimationFrame = () => {};
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    const store = createRunStore((flush) => flush());
    store.resync(commits("a", 201));
    act(() => root.render(<RunProvider store={store}><Timeline virtual /></RunProvider>));
    const rows = observers.find(({ observed }) => [...observed].some((element) => element.hasAttribute("data-virtual-id")));
    expect(rows).toBeDefined();
    const entries = [...rows!.observed].map((target) => ({ target, borderBoxSize: [{ blockSize: 41, inlineSize: 800 }], contentRect: { height: 41 } }));
    act(() => rows!.report(entries as unknown as ResizeObserverEntry[], {} as ResizeObserver));
    // The delivery is complete before a history rebuild can replace the measured ids; no deferred frame remains.
    act(() => store.resync(commits("b", 201)));
    expect(frames.length).toBe(0);
    expect(container.querySelector('[data-virtual-id^="message:b-"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
    globalThis.ResizeObserver = saved.ResizeObserver;
    globalThis.requestAnimationFrame = saved.raf;
    globalThis.cancelAnimationFrame = saved.caf;
    if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
  }
});
