import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createRunStore, type RunEvent } from "@fulcrum/core";
import { RunProvider, Timeline } from "../src/index.js";

afterAll(() => GlobalRegistrator.unregister());

const commits = (prefix: string, count: number): RunEvent[] => Array.from({ length: count }, (_, index) => (
  { type: "message_commit", message_id: `${prefix}-${index}`, message: { role: "assistant", content: [{ type: "text", text: `${prefix}-${index}` }] } }
));

const restoreProperty = (target: object, key: PropertyKey, descriptor?: PropertyDescriptor) => {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
};

test("two row growths before measurement keep a pinned reader at the physical end", async () => {
  const observers: Array<{ report: ResizeObserverCallback; observed: Set<Element> }> = [];
  const frames: FrameRequestCallback[] = [];
  const saved = {
    ResizeObserver: Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver"),
    requestAnimationFrame: Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame"),
    cancelAnimationFrame: Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame"),
  };
  const dimensions = {
    clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
    scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight"),
    scrollTop: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop"),
  };
  const positions = new WeakMap<HTMLElement, number>();
  let physicalHeight = 0;
  globalThis.ResizeObserver = class {
    private entry = { report: (() => {}) as ResizeObserverCallback, observed: new Set<Element>() };
    constructor(callback: ResizeObserverCallback) { this.entry.report = callback; observers.push(this.entry); }
    observe(element: Element) { this.entry.observed.add(element); }
    unobserve(element: Element) { this.entry.observed.delete(element); }
    disconnect() { this.entry.observed.clear(); }
  } as unknown as typeof ResizeObserver;
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  globalThis.cancelAnimationFrame = () => {};
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => physicalHeight });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() { return positions.get(this as HTMLElement) ?? 0; },
    set(value: number) { positions.set(this as HTMLElement, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))); },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    const store = createRunStore((flush) => flush());
    store.resync(commits("growth", 201));
    act(() => root.render(<RunProvider store={store}><Timeline virtual /></RunProvider>));
    const host = container.querySelector<HTMLElement>('[data-part="timeline-scroll"]')!;
    physicalHeight = Number.parseFloat(container.querySelector<HTMLElement>('[data-part="timeline"]')!.style.height);
    await Bun.sleep(60);
    host.scrollTop = physicalHeight;
    act(() => host.dispatchEvent(new Event("scroll")));
    const viewport = observers.find(({ observed }) => observed.has(host))!;
    act(() => viewport.report([{ target: host }] as unknown as ResizeObserverEntry[], {} as ResizeObserver));
    await Bun.sleep(60);
    physicalHeight -= 100;
    host.scrollTop = host.scrollTop;
    act(() => host.dispatchEvent(new Event("scroll")));
    const rows = observers.find(({ observed }) => [...observed].some((element) => element.hasAttribute("data-virtual-id")))!;
    const target = [...rows.observed].find((element) => element.hasAttribute("data-virtual-id"))!;
    for (const height of [100, 200]) {
      physicalHeight += 100;
      act(() => rows.report([{ target, borderBoxSize: [{ blockSize: height, inlineSize: 800 }], contentRect: { height } }] as unknown as ResizeObserverEntry[], {} as ResizeObserver));
      if (height === 100) act(() => host.dispatchEvent(new Event("scroll")));
    }
    expect(physicalHeight - host.clientHeight - host.scrollTop).toBeLessThanOrEqual(4);
  } finally {
    act(() => root.unmount());
    container.remove();
    restoreProperty(globalThis, "ResizeObserver", saved.ResizeObserver);
    restoreProperty(globalThis, "requestAnimationFrame", saved.requestAnimationFrame);
    restoreProperty(globalThis, "cancelAnimationFrame", saved.cancelAnimationFrame);
    for (const [key, descriptor] of Object.entries(dimensions)) restoreProperty(HTMLElement.prototype, key, descriptor);
  }
});

test("a row resize reported just before a resync replaces its id is not measured into the new outline", () => {
  // A controllable ResizeObserver and frame queue: the browser reports a resize, then React commits before the frame.
  // Timeline has two observers (rows and the viewport); keep each one's callback and targets.
  const observers: Array<{ report: ResizeObserverCallback; observed: Set<Element> }> = [];
  const frames: FrameRequestCallback[] = [];
  const saved = {
    ResizeObserver: Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver"),
    requestAnimationFrame: Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame"),
    cancelAnimationFrame: Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame"),
  };
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
    // A history rebuild (a reconnect, a page that renumbers ids) commits before the frame that flushes the resize.
    act(() => store.resync(commits("b", 201)));
    expect(frames.length).toBe(1);
    expect(() => act(() => { for (const frame of frames.splice(0)) frame(0); })).not.toThrow();
    expect(container.querySelector('[data-virtual-id^="message:b-"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
    restoreProperty(globalThis, "ResizeObserver", saved.ResizeObserver);
    restoreProperty(globalThis, "requestAnimationFrame", saved.requestAnimationFrame);
    restoreProperty(globalThis, "cancelAnimationFrame", saved.cancelAnimationFrame);
    restoreProperty(HTMLElement.prototype, "clientHeight", clientHeight);
  }
});
