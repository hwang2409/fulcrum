import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, Profiler } from "react";
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
    get: () => Number.parseFloat(document.querySelector<HTMLElement>('[data-part="timeline"]')?.style.height.match(/[\d.]+/)?.[0] ?? "0") + domExtra,
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

// `hosted` puts the scroll on a host element the app owns, so a test can move the Timeline to a second host.
function mountTimeline(hosted = false) {
  const store = createRunStore((flush) => flush());
  store.resync(Array.from({ length: 300 }, (_, index) => message(`row-${index}`)));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  let followRequest = 0;
  let target: "a" | "b" = "a";
  const scrollRef = { current: null as HTMLElement | null };
  const render = () => root!.render(<RunProvider store={store}>
    {hosted ? (
      <div data-host="b" ref={target === "b" ? scrollRef : undefined}>
        <div data-host="a" ref={target === "a" ? scrollRef : undefined}>
          <Timeline virtual followRequest={followRequest} scrollRef={scrollRef} renderJumpToLatest={(control) => <aside>{control}</aside>} />
        </div>
      </div>
    ) : <Timeline virtual followRequest={followRequest} />}
  </RunProvider>);
  act(render);
  const currentHost = () => hosted ? scrollRef.current! : container!.querySelector<HTMLElement>('[data-part="timeline-scroll"]')!;
  const append = () => act(() => store.dispatch(message(`added-${store.getOutline().length}`)));
  const jump = () => container!.querySelector<HTMLElement>('[data-part="jump-to-latest"]');
  const unseen = () => container!.querySelector<HTMLElement>('[data-part="timeline"]')!.dataset.unseenCount;
  const follow = () => act(() => { followRequest++; render(); });
  // Moves the Timeline to the app's outer scroll host: the inner host is released.
  const detach = () => act(() => { target = "b"; render(); });
  const first = currentHost();
  first.scrollTop = first.scrollHeight;
  act(() => first.dispatchEvent(new Event("scroll")));
  return { append, detach, follow, get host() { return currentHost(); }, jump, store, unseen };
}

// A row observer and a frame queue the test drives: rows report measured sizes, and frames run when the test says.
function installRowObserver() {
  const saved = { ResizeObserver: globalThis.ResizeObserver, raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
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
  return {
    /** Reports the size `size(id)` gives each observed row (undefined: no report), then runs the browser's next frame
     * unless `frame` is false (a frame that has not run yet, as under heavy CPU load). */
    measure(size: (id: string) => number | undefined, frame = true) {
      const rows = observers.find(({ observed }) => [...observed].some((element) => element.hasAttribute("data-virtual-id")))!;
      const entries = [...rows.observed].flatMap((target) => {
        const blockSize = size(target.getAttribute("data-virtual-id")!);
        return blockSize === undefined ? [] : [{ target, borderBoxSize: [{ blockSize, inlineSize: 800 }], contentRect: { height: blockSize } }];
      });
      act(() => rows.report(entries as unknown as ResizeObserverEntry[], {} as ResizeObserver));
      if (frame) act(() => { for (const next of frames.splice(0)) next(0); });
    },
    restore() {
      globalThis.ResizeObserver = saved.ResizeObserver;
      globalThis.requestAnimationFrame = saved.raf;
      globalThis.cancelAnimationFrame = saved.caf;
    },
  };
}

// A row's top relative to the viewport top (rows are absolutely placed by translateY).
function rowOffset(host: HTMLElement, id: string) {
  const row = container!.querySelector<HTMLElement>(`[data-virtual-id="${id}"]`);
  if (!row) return null;
  return Number(/translateY\((-?[\d.]+)px\)/.exec(row.style.transform)![1]) - host.scrollTop;
}

// The browser's scroll callback for a position change since `before`; none when nothing moved.
function echo(host: HTMLElement, before: number) {
  if (host.scrollTop !== before) act(() => host.dispatchEvent(new Event("scroll")));
}

// The reader's scroll settles: two animation frames pass with no reader callback (the lease rule; scrollend ends nothing).
const settleReader = () => act(async () => { for (let frame = 0; frame < 3; frame++) await new Promise((resolve) => requestAnimationFrame(resolve)); });

// The reader clicks a row (focus stays on the page body): a page-level key then scrolls this timeline.
function clickRow() {
  act(() => container!.querySelector("[data-virtual-id]")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  act(() => document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
}

function moveReader(host: HTMLElement, top = 3_000) {
  host.scrollTop = top;
  act(() => host.dispatchEvent(new Event("scroll")));
}

// The mounted rows must cover the DOM viewport: a stale engine position leaves the reader on a blank spacer.
function viewportCoverage(host: HTMLElement, lastId: string) {
  const rows = [...container!.querySelectorAll<HTMLElement>("[data-virtual-id]")]
    .filter((row) => row.style.opacity !== "0")
    .map((row) => ({ id: row.dataset.virtualId!, start: Number(/translateY\((-?[\d.]+)px\)/.exec(row.style.transform)![1]) }))
    .sort((a, b) => a.start - b.start);
  const top = host.scrollTop;
  const bottom = top + host.clientHeight;
  const first = rows[0]!;
  const last = rows.at(-1)!;
  const covered = first.start <= top && (last.start >= bottom || last.id === lastId);
  return `${covered ? "covered" : "blank"}: rows ${first.id}@${first.start}..${last.id}@${last.start}, viewport ${top}..${bottom}`;
}

const settleProgrammaticScroll = () => new Promise((resolve) => setTimeout(resolve, 60));

describe("timeline scroll position", () => {
  test("a host write to the bottom resumes follow by position", () => {
    const geometry = installScrollGeometry();
    try {
      const { append, host, jump, unseen } = mountTimeline();
      host.scrollTop -= 10;
      act(() => host.dispatchEvent(new Event("scroll")));
      append();
      expect(unseen()).toBe("1");

      host.scrollTop = host.scrollHeight;
      act(() => host.dispatchEvent(new Event("scroll")));
      expect(unseen(), "a final bottom position must resume follow").toBe("0");
      expect(jump()).toBeNull();
      append();
      expect(unseen()).toBe("0");
      expect(host.scrollHeight - host.clientHeight - host.scrollTop).toBeLessThanOrEqual(1);
    } finally {
      geometry.restore();
    }
  });

  test.each([[3, true], [5, false]] as const)("a settled position %d px from the end sets follow to %s", (gap, following) => {
    const geometry = installScrollGeometry();
    try {
      const { append, host, jump, unseen } = mountTimeline();
      host.scrollTop = host.scrollHeight - host.clientHeight - gap;
      act(() => host.dispatchEvent(new Event("scroll")));
      append();
      expect(unseen()).toBe(following ? "0" : "1");
      expect(jump() === null).toBe(following);
      if (following) expect(host.scrollHeight - host.clientHeight - host.scrollTop).toBeLessThanOrEqual(1);
    } finally {
      geometry.restore();
    }
  });

  test("a pinned append uses one end transaction", () => {
    const geometry = installScrollGeometry();
    try {
      const { append, host, jump, unseen } = mountTimeline();
      append();
      expect(unseen()).toBe("0");
      expect(jump()).toBeNull();
      expect(host.scrollHeight - host.clientHeight - host.scrollTop).toBeLessThanOrEqual(1);
    } finally {
      geometry.restore();
    }
  });

  test("a viewport resize keeps a pinned reader at the physical end", () => {
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
      geometry.resizeBy(-200);
      const viewport = observers.find(({ observed }) => observed.has(host))!;
      act(() => viewport.report([], viewport as unknown as ResizeObserver));
      append();
      expect(unseen()).toBe("0");
      expect(jump()).toBeNull();
      expect(host.scrollHeight - host.clientHeight - host.scrollTop).toBeLessThanOrEqual(1);
    } finally {
      globalThis.ResizeObserver = saved;
      geometry.restore();
    }
  });
});
