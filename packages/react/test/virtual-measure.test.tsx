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

    const wheel = new Event("wheel");
    Object.defineProperty(wheel, "deltaY", { value: -100 });
    act(() => host.dispatchEvent(wheel));
    host.scrollTop = physicalHeight - host.clientHeight - 120;
    act(() => host.dispatchEvent(new Event("scroll")));
    act(() => store.dispatch(commits("detached", 1)[0]!));
    physicalHeight -= 200;
    host.scrollTop = host.scrollTop;
    act(() => host.dispatchEvent(new Event("scroll")));
    expect(container.querySelector('[data-part="jump-to-latest"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
    restoreProperty(globalThis, "ResizeObserver", saved.ResizeObserver);
    restoreProperty(globalThis, "requestAnimationFrame", saved.requestAnimationFrame);
    restoreProperty(globalThis, "cancelAnimationFrame", saved.cancelAnimationFrame);
    for (const [key, descriptor] of Object.entries(dimensions)) restoreProperty(HTMLElement.prototype, key, descriptor);
  }
});

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
    expect(scrollHeight - 600 - scrollTop, "the same ResizeObserver delivery must restore the DOM end before the next paint").toBeLessThanOrEqual(0.5);
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

test("touch movement wins over an owned end write when the row observer arrives first", () => {
  const observers: Array<{ report: ResizeObserverCallback; observed: Set<Element> }> = [];
  const saved = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    private entry = { report: (() => {}) as ResizeObserverCallback, observed: new Set<Element>() };
    constructor(callback: ResizeObserverCallback) { this.entry.report = callback; observers.push(this.entry); }
    observe(element: Element) { this.entry.observed.add(element); }
    unobserve(element: Element) { this.entry.observed.delete(element); }
    disconnect() { this.entry.observed.clear(); }
  } as unknown as typeof ResizeObserver;
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    const store = createRunStore((flush) => flush());
    store.resync(commits("touch-row", 201));
    act(() => root.render(<RunProvider store={store}><Timeline virtual /></RunProvider>));
    const scroll = container.querySelector<HTMLElement>('[data-part="timeline-scroll"]')!;
    const scrollHeight = () => Number.parseFloat(container.querySelector<HTMLElement>('[data-part="timeline"]')!.style.height) + 16;
    let scrollTop = scrollHeight() - 600;
    Object.defineProperty(scroll, "scrollTop", { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
    Object.defineProperty(scroll, "scrollHeight", { configurable: true, get: scrollHeight });
    act(() => scroll.dispatchEvent(new Event("touchstart")));
    scrollTop -= 30;
    const rows = observers.find(({ observed }) => [...observed].some((element) => element.hasAttribute("data-virtual-id")))!;
    const target = [...rows.observed][0]!;
    act(() => rows.report([{ target, borderBoxSize: [{ blockSize: 120, inlineSize: 800 }], contentRect: { height: 120 } }] as unknown as ResizeObserverEntry[], {} as ResizeObserver));
    expect(scrollHeight() - 600 - scrollTop, "the row observer must not acknowledge the stale owned end after reader touch movement").toBeGreaterThan(4);
    const readerTop = scrollTop;
    act(() => store.dispatch(commits("touch-next", 1)[0]!));
    expect(scrollTop, "the next append must not restore the stale owned end").toBe(readerTop);
  } finally {
    act(() => root.unmount());
    container.remove();
    globalThis.ResizeObserver = saved;
    if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
  }
});

test("host removal invalidates stale ResizeObserver completion", () => {
  const observers: Array<{ report: ResizeObserverCallback; observed: Set<Element> }> = [];
  const saved = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    private entry = { report: (() => {}) as ResizeObserverCallback, observed: new Set<Element>() };
    constructor(callback: ResizeObserverCallback) { this.entry.report = callback; observers.push(this.entry); }
    observe(element: Element) { this.entry.observed.add(element); }
    unobserve(element: Element) { this.entry.observed.delete(element); }
    disconnect() { this.entry.observed.clear(); }
  } as unknown as typeof ResizeObserver;
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  const scrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
  const positions = new WeakMap<HTMLElement, number>();
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => Number.parseFloat(document.querySelector<HTMLElement>('[data-part="timeline"]')?.style.height ?? "0") });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", { configurable: true, get() { return positions.get(this as HTMLElement) ?? 0; }, set(value: number) { positions.set(this as HTMLElement, value); } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const ref = { current: null as HTMLElement | null };
  const store = createRunStore((flush) => flush());
  store.resync(commits("stale", 201));
  const view = (target: "old" | "new") => <RunProvider store={store}>
    <div key={target} data-testid={`${target}-stale-host`} ref={ref}><span data-testid={`${target}-sibling`} /><Timeline virtual scrollRef={ref} renderJumpToLatest={(control) => control} /></div>
  </RunProvider>;
  try {
    act(() => root.render(view("old")));
    const host = container.querySelector<HTMLElement>('[data-testid="old-stale-host"]')!;
    host.scrollTop = host.scrollHeight - host.clientHeight;
    act(() => host.dispatchEvent(new Event("scroll")));
    const rows = observers.find(({ observed }) => [...observed].some((element) => element.hasAttribute("data-virtual-id")))!;
    const viewport = observers.find(({ observed }) => observed.has(host))!;
    const sibling = observers.find(({ observed }) => [...observed].some((element) => element.getAttribute("data-testid") === "old-sibling"))!;
    const target = [...rows.observed][0]!;
    act(() => root.render(view("new")));
    const newHost = container.querySelector<HTMLElement>('[data-testid="new-stale-host"]')!;
    expect(ref.current).toBe(newHost);
    const newTop = newHost.scrollTop;
    host.scrollTop = 1_000;
    Object.defineProperty(host, "scrollHeight", { configurable: true, get: () => 50_000 });
    act(() => sibling.report([], {} as ResizeObserver));
    expect(host.scrollTop, "a stale sibling completion must not write the removed host").toBe(1_000);
    expect(newHost.scrollTop, "a stale sibling completion must not write the replacement host").toBe(newTop);
    act(() => viewport.report([], {} as ResizeObserver));
    expect(host.scrollTop, "a stale viewport completion must not write the removed host").toBe(1_000);
    const detachedTop = host.scrollTop;
    act(() => rows.report([{ target, borderBoxSize: [{ blockSize: 120, inlineSize: 800 }], contentRect: { height: 120 } }] as unknown as ResizeObserverEntry[], {} as ResizeObserver));
    expect(host.scrollTop, "a stale row completion must not write the removed host").toBe(detachedTop);
    act(() => store.dispatch(commits("stale-next", 1)[0]!));
    expect(newHost.scrollTop, "stale completions must not cancel follow on the replacement host").toBeGreaterThan(newTop);
  } finally {
    act(() => root.unmount());
    container.remove();
    globalThis.ResizeObserver = saved;
    if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight); else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
    if (scrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight); else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
    if (scrollTop) Object.defineProperty(HTMLElement.prototype, "scrollTop", scrollTop); else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTop;
  }
});
