import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRunStore, type RunEvent } from "@fulcrum/core";
import { RunProvider, Timeline } from "../src/index.js";

afterAll(() => GlobalRegistrator.unregister());

const message = (id: string): RunEvent => ({
  type: "message_commit",
  message_id: id,
  message: { role: "assistant", content: [{ type: "text", text: id }] },
});

let root: Root | undefined;
let container: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
});

function installScrollGeometry() {
  const descriptors = {
    clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
    clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth"),
    scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight"),
    scrollTop: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop"),
  };
  const positions = new WeakMap<HTMLElement, number>();
  let viewportHeight = 600;
  let domExtra = 0;
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => viewportHeight });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => Number.parseFloat(document.querySelector<HTMLElement>('[data-part="timeline"]')?.style.height ?? "0") + domExtra,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() { return Math.min(positions.get(this as HTMLElement) ?? 0, Math.max(0, this.scrollHeight - this.clientHeight)); },
    set(value: number) { positions.set(this as HTMLElement, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))); },
  });
  return {
    addDomExtra(value: number) { domExtra += value; },
    resizeBy(value: number) { viewportHeight += value; },
    restore() {
      for (const [name, descriptor] of Object.entries(descriptors)) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      }
    },
  };
}

function mountTimeline() {
  const store = createRunStore((flush) => flush());
  store.resync(Array.from({ length: 300 }, (_, index) => message(`row-${index}`)));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<RunProvider store={store}><Timeline virtual /></RunProvider>));
  const host = container.querySelector<HTMLElement>('[data-part="timeline-scroll"]')!;
  const append = () => act(() => store.dispatch(message(`added-${store.getOutline().length}`)));
  const jump = () => container!.querySelector<HTMLElement>('[data-part="jump-to-latest"]');
  const unseen = () => container!.querySelector<HTMLElement>('[data-part="timeline"]')!.dataset.unseenCount;
  host.scrollTop = host.scrollHeight;
  act(() => host.dispatchEvent(new Event("scroll")));
  return { append, host, jump, unseen };
}

function moveReader(host: HTMLElement, top = 3_000) {
  host.scrollTop = top;
  act(() => host.dispatchEvent(new Event("scroll")));
}

const settleProgrammaticScroll = () => new Promise((resolve) => setTimeout(resolve, 60));

describe("timeline scroll provenance", () => {
  test("f1: a non-user clamp to the bottom preserves unseen intent", () => {
    const geometry = installScrollGeometry();
    try {
      const { append, host, jump, unseen } = mountTimeline();
      act(() => host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 })));
      moveReader(host);
      act(() => host.dispatchEvent(new Event("scrollend")));
      append();
      expect(unseen()).toBe("1");

      host.scrollTop = host.scrollHeight;
      act(() => host.dispatchEvent(new Event("scroll")));
      expect(unseen(), "a layout clamp must not turn follow back on").toBe("1");
      expect(jump()).not.toBeNull();
    } finally {
      geometry.restore();
    }
  });

  test.each(["scroll first", "resize first"] as const)(
    "f3: a viewport shrink preserves follow intent with %s",
    async (order) => {
      const geometry = installScrollGeometry();
      const saved = globalThis.ResizeObserver;
      const observers: Array<{ report: ResizeObserverCallback; observed: Set<Element> }> = [];
      globalThis.ResizeObserver = class {
        private entry = { report: (() => {}) as ResizeObserverCallback, observed: new Set<Element>() };
        constructor(callback: ResizeObserverCallback) { this.entry.report = callback; observers.push(this.entry); }
        observe(element: Element) { this.entry.observed.add(element); }
        unobserve(element: Element) { this.entry.observed.delete(element); }
        disconnect() { this.entry.observed.clear(); }
      } as unknown as typeof ResizeObserver;
      try {
        const { append, host, jump, unseen } = mountTimeline();
        await act(settleProgrammaticScroll);
        geometry.resizeBy(-313);
        const viewport = observers.find(({ observed }) => observed.has(host))!;
        const scroll = () => host.dispatchEvent(new Event("scroll"));
        const resize = () => viewport.report([], viewport as unknown as ResizeObserver);
        if (order === "scroll first") {
          host.scrollTop -= 1;
          act(scroll);
        }
        act(resize);
        if (order === "resize first") act(scroll);
        append();
        expect(unseen(), `follow was lost when ${order}`).toBe("0");
        expect(jump()).toBeNull();
        expect(host.scrollHeight - host.clientHeight - host.scrollTop).toBeLessThan(0.5);
      } finally {
        globalThis.ResizeObserver = saved;
        geometry.restore();
      }
    },
  );

  test("replacement clamp: a non-user upward callback at the engine end keeps follow across a 2 px dom disagreement", async () => {
    const geometry = installScrollGeometry();
    try {
      const { append, host, jump, unseen } = mountTimeline();
      await act(settleProgrammaticScroll);
      geometry.addDomExtra(2);
      append();
      expect(host.scrollTop).toBe(host.scrollHeight - host.clientHeight);
      const engineEnd = host.scrollHeight - host.clientHeight - 2;
      host.scrollTop = engineEnd;
      act(() => host.dispatchEvent(new Event("scroll")));

      expect(unseen(), "the replacement clamp must keep follow intent").toBe("0");
      expect(jump()).toBeNull();
      expect(host.scrollTop, "the replacement clamp must reapply the dom end").toBe(host.scrollHeight - host.clientHeight);
      append();
      expect(unseen()).toBe("0");
      expect(host.scrollTop).toBe(host.scrollHeight - host.clientHeight);
    } finally {
      geometry.restore();
    }
  });

  test("f2: an equal remeasure cannot erase an undelivered pinned append target", () => {
    const geometry = installScrollGeometry();
    const saved = {
      ResizeObserver: globalThis.ResizeObserver,
      raf: globalThis.requestAnimationFrame,
      caf: globalThis.cancelAnimationFrame,
    };
    const observers: Array<{ report: ResizeObserverCallback; observed: Set<Element> }> = [];
    const frames: FrameRequestCallback[] = [];
    globalThis.ResizeObserver = class {
      private entry = { report: (() => {}) as ResizeObserverCallback, observed: new Set<Element>() };
      constructor(callback: ResizeObserverCallback) { this.entry.report = callback; observers.push(this.entry); }
      observe(element: Element) { this.entry.observed.add(element); }
      unobserve(element: Element) { this.entry.observed.delete(element); }
      disconnect() { this.entry.observed.clear(); }
    } as unknown as typeof ResizeObserver;
    globalThis.requestAnimationFrame = (callback) => (frames.push(callback), frames.length);
    globalThis.cancelAnimationFrame = () => {};
    try {
      const { append, host, jump, unseen } = mountTimeline();
      const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop")!;
      let blockWrite = true;
      Object.defineProperty(host, "scrollTop", {
        configurable: true,
        get: () => descriptor.get!.call(host),
        set: (value: number) => { if (!blockWrite) descriptor.set!.call(host, value); },
      });
      append();
      blockWrite = false;
      expect(host.scrollTop).toBeLessThan(host.scrollHeight - host.clientHeight);

      const rows = observers.find(({ observed }) => [...observed].some((element) => element.hasAttribute("data-virtual-id")))!;
      const target = [...rows.observed][0]!;
      act(() => rows.report([{ target, borderBoxSize: [{ blockSize: 72, inlineSize: 800 }], contentRect: { height: 72 } }] as unknown as ResizeObserverEntry[], {} as ResizeObserver));
      host.scrollTop -= 1;
      act(() => host.dispatchEvent(new Event("scroll")));
      act(() => { for (const frame of frames.splice(0)) frame(0); });
      expect(unseen(), "an equal remeasure must not lose follow intent").toBe("0");
      expect(jump()).toBeNull();
      expect(host.scrollTop).toBe(host.scrollHeight - host.clientHeight);
    } finally {
      globalThis.ResizeObserver = saved.ResizeObserver;
      globalThis.requestAnimationFrame = saved.raf;
      globalThis.cancelAnimationFrame = saved.caf;
      geometry.restore();
    }
  });

  test.each(["scrollIntoView", "focus", "scrollbar", "page keyboard"] as const)(
    "%s scroll without container input is reader intent",
    async (kind) => {
      const geometry = installScrollGeometry();
      try {
        const { append, host, jump, unseen } = mountTimeline();
        await act(settleProgrammaticScroll);
        const row = container!.querySelector<HTMLElement>("[data-virtual-id]")!;
        if (kind === "scrollIntoView") {
          row.scrollIntoView = () => moveReader(host);
          row.scrollIntoView();
        } else {
          if (kind === "focus") act(() => row.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
          else if (kind === "scrollbar") {
            host.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 816, bottom: 600, width: 816, height: 600, toJSON: () => ({}) });
            act(() => document.dispatchEvent(new PointerEvent("pointerdown", { clientX: 808, clientY: 300, bubbles: true })));
          }
          else act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true })));
          moveReader(host);
        }
        const readerTop = host.scrollTop;
        append();
        expect(unseen(), `${kind} must turn follow off`).toBe("1");
        expect(jump()).not.toBeNull();
        expect(host.scrollTop, `${kind} must not snap back to the bottom`).toBe(readerTop);
        append();
        expect(unseen(), `${kind} must stay unpinned as another row streams`).toBe("2");
        expect(host.scrollTop, `${kind} must keep the reader position as another row streams`).toBe(readerTop);
      } finally {
        geometry.restore();
      }
    },
  );
});
