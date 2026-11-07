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
    // A history rebuild (a reconnect, a page that renumbers ids) commits before the frame that flushes the resize.
    act(() => store.resync(commits("b", 201)));
    expect(frames.length).toBe(1);
    expect(() => act(() => { for (const frame of frames.splice(0)) frame(0); })).not.toThrow();
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
