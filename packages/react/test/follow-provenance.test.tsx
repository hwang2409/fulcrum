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

describe("timeline scroll provenance", () => {
  test("f1: a non-user clamp to the bottom preserves unseen intent", async () => {
    const geometry = installScrollGeometry();
    try {
      const { append, host, jump, unseen } = mountTimeline();
      act(() => host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 })));
      moveReader(host);
      await settleReader();
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

  test.each(["host scrollTop=0", "scrollIntoView", "find-style scroll"] as const)(
    "%s is reader intent while a streaming end write is pending",
    (kind) => {
      const geometry = installScrollGeometry();
      try {
        const { append, host, jump, unseen } = mountTimeline();
        append(); // streaming writes a new end; its browser scroll callback has not arrived
        const expectedTop = kind === "host scrollTop=0" ? 0 : 3_000;
        if (kind === "scrollIntoView") {
          const row = container!.querySelector<HTMLElement>("[data-virtual-id]")!;
          row.scrollIntoView = () => moveReader(host, expectedTop);
          row.scrollIntoView();
        } else moveReader(host, expectedTop);

        expect(host.scrollTop, `${kind} must consume, not replay, the pending end write`).toBe(expectedTop);
        append();
        expect(unseen(), `${kind} must turn follow off`).toBe("1");
        expect(jump()).not.toBeNull();
        expect(host.scrollTop, `${kind} must not snap back as a row streams`).toBe(expectedTop);
        append();
        expect(unseen(), `${kind} must stay unpinned as another row streams`).toBe("2");
        expect(host.scrollTop, `${kind} must keep the reader position`).toBe(expectedTop);
      } finally {
        geometry.restore();
      }
    },
  );

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

  test("wheel momentum renews one callback at a time, drops follow toward content, and never snaps back", () => {
    const geometry = installScrollGeometry();
    try {
      const { append, host, jump, unseen } = mountTimeline();
      for (const top of [5_000, 4_500, 4_000]) {
        act(() => host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 })));
        moveReader(host, top);
      }
      append();
      expect(unseen(), "momentum toward content must drop follow").toBe("1");
      expect(jump()).not.toBeNull();
      expect(host.scrollTop, "streaming after momentum must not snap to the end").toBe(4_000);
      append();
      expect(host.scrollTop).toBe(4_000);
    } finally { geometry.restore(); }
  });

  test("wheel input without scrollend does not block a later explicit follow", () => {
    const geometry = installScrollGeometry();
    try {
      const { append, follow, host, unseen } = mountTimeline();
      act(() => host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 })));
      moveReader(host);
      append();
      follow();
      expect(host.scrollTop, "explicit follow must not wait for scrollend").toBe(host.scrollHeight - host.clientHeight);
      append();
      expect(unseen()).toBe("0");
      expect(host.scrollTop).toBe(host.scrollHeight - host.clientHeight);
    } finally { geometry.restore(); }
  });

  test.each(["focus", "keyboard keyup"] as const)("%s one-shot expires after the next rendering opportunity", (kind) => {
    const geometry = installScrollGeometry();
    const saved = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    globalThis.requestAnimationFrame = (callback) => { const id = ++nextFrame; frames.set(id, callback); return id; };
    globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
    try {
      const { append, host, jump, unseen } = mountTimeline();
      const row = container!.querySelector<HTMLElement>("[data-virtual-id]")!;
      if (kind === "focus") act(() => row.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
      else act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        document.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowDown", bubbles: true }));
      });
      act(() => { for (const [id, frame] of [...frames]) { frames.delete(id); frame(0); } });
      append();
      act(() => host.dispatchEvent(new Event("scroll")));
      expect(unseen(), `${kind} must not classify a later own write as reader intent`).toBe("0");
      expect(jump()).toBeNull();
    } finally {
      globalThis.requestAnimationFrame = saved.raf;
      globalThis.cancelAnimationFrame = saved.caf;
      geometry.restore();
    }
  });

  test("touch momentum settles after two quiet animation frames without scrollend", () => {
    const geometry = installScrollGeometry();
    const saved = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    globalThis.requestAnimationFrame = (callback) => { const id = ++nextFrame; frames.set(id, callback); return id; };
    globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
    const runFrame = () => act(() => { const current = [...frames]; frames.clear(); for (const [, frame] of current) frame(0); });
    try {
      const { append, follow, host, unseen } = mountTimeline();
      const touch = new Event("touchstart") as TouchEvent;
      Object.defineProperty(touch, "touches", { value: [{ clientY: 100 }] });
      act(() => host.dispatchEvent(touch));
      act(() => host.dispatchEvent(new Event("touchend")));
      moveReader(host, 4_000);
      runFrame();
      moveReader(host, 3_500);
      runFrame();
      runFrame();
      runFrame();
      append();
      follow();
      expect(host.scrollTop, "settled touch must not block explicit follow").toBe(host.scrollHeight - host.clientHeight);
      append();
      expect(unseen()).toBe("0");
    } finally {
      globalThis.requestAnimationFrame = saved.raf;
      globalThis.cancelAnimationFrame = saved.caf;
      geometry.restore();
    }
  });

  test.each(["moves into content", "does not move"] as const)("host focus() without keydown %s", async (behavior) => {
    const geometry = installScrollGeometry();
    try {
      const { append, host, jump, unseen } = mountTimeline();
      await act(settleProgrammaticScroll);
      const row = container!.querySelector<HTMLElement>("[data-virtual-id]")!;
      row.focus = () => {
        act(() => row.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
        if (behavior === "moves into content") moveReader(host, 3_000);
      };
      row.focus();
      const readerTop = host.scrollTop;
      append();
      if (behavior === "moves into content") {
        expect(unseen()).toBe("1");
        expect(jump()).not.toBeNull();
        expect(host.scrollTop, "focus scrolling into content must not snap back").toBe(readerTop);
      } else {
        act(() => host.dispatchEvent(new Event("scroll")));
        expect(unseen()).toBe("0");
        expect(jump()).toBeNull();
        expect(host.scrollTop).toBe(host.scrollHeight - host.clientHeight);
      }
    } finally { geometry.restore(); }
  });

  type RouteContext = { host: HTMLElement; oldEnd: number; geometry: ReturnType<typeof installScrollGeometry> };
  const end = (host: HTMLElement) => host.scrollHeight - host.clientHeight;
  const hostWrite = (host: HTMLElement, top: number) => {
    host.scrollTop = top;
    act(() => host.dispatchEvent(new Event("scroll")));
  };
  const settle = (host: HTMLElement) => act(() => host.dispatchEvent(new Event("scroll")));
  // Every scroll callback reports the real viewport; the route only decides follow intent (rules 1 and 2, F1).
  const routes: ReadonlyArray<{ name: string; run(context: RouteContext): void; pinned: boolean | null; unpinned: boolean | null }> = [
    { name: "own echo", run: ({ host }) => act(() => host.dispatchEvent(new Event("scroll"))), pinned: true, unpinned: false },
    { name: "end clamp at the old end", run: ({ host, oldEnd }) => hostWrite(host, oldEnd), pinned: true, unpinned: false },
    { name: "end clamp at the new end", run: ({ host }) => hostWrite(host, host.scrollHeight), pinned: true, unpinned: null },
    { name: "host write to scrollHeight (F1)", run: ({ host }) => hostWrite(host, host.scrollHeight), pinned: null, unpinned: false },
    // Non-input moves are judged by direction and cause (classifyScroll). Premise: the adapter sets overflow-anchor none,
    // so without input a browser moves scrollTop only up (a clamp). A move down off the end is the host's intent; a move
    // up is layout only within an unseen viewport resize (|resize| + 48) or a content change (scrollHeight); anything else
    // is intent, even within the 48 px threshold. `settle` first reports the current position, so "no size change" means
    // none since the last callback.
    { name: "host write 10 px above a grown end (stale end)", run: ({ host }) => hostWrite(host, end(host) - 10), pinned: false, unpinned: false },
    { name: "small host move (10 px up), no size change", run: ({ host }) => {
      settle(host);
      hostWrite(host, host.scrollTop - 10);
    }, pinned: false, unpinned: false },
    { name: "large host move (100 px up), no size change", run: ({ host }) => {
      settle(host);
      hostWrite(host, host.scrollTop - 100);
    }, pinned: false, unpinned: false },
    { name: "content grew 30 px and the move is within it (20 px up)", run: ({ host, geometry }) => {
      settle(host);
      geometry.addDomExtra(30);
      hostWrite(host, host.scrollTop - 20);
    }, pinned: true, unpinned: false },
    { name: "content grew 30 px and a host moves 20 px down, short of the end", run: ({ host, geometry }) => {
      settle(host);
      geometry.addDomExtra(30);
      hostWrite(host, host.scrollTop + 20);
    }, pinned: false, unpinned: false },
    { name: "content grew 30 px and the move is beyond it (2,000 px up)", run: ({ host, geometry }) => {
      settle(host);
      geometry.addDomExtra(30);
      hostWrite(host, host.scrollTop - 2_000);
    }, pinned: false, unpinned: false },
    // The captured WebKit reconnect route: a banner shrinks the box 3 px and the browser moves the reader 41 px up.
    { name: "viewport shrink moves the reader 41 px up before the resize callback", run: ({ host, geometry }) => {
      settle(host);
      geometry.resizeBy(-3);
      hostWrite(host, host.scrollTop - 41);
    }, pinned: true, unpinned: false },
    { name: "viewport shrink 3 px with a 52 px move up (beyond |resize| + 48) before the resize callback", run: ({ host, geometry }) => {
      settle(host);
      geometry.resizeBy(-3);
      hostWrite(host, host.scrollTop - 52);
    }, pinned: false, unpinned: false },
    { name: "viewport shrink with a 500 px move before the resize callback", run: ({ host, geometry }) => {
      settle(host);
      geometry.resizeBy(-3);
      hostWrite(host, host.scrollTop - 500);
    }, pinned: false, unpinned: false },
    // The sub-agent clock (subagent-check.ts): the host shrinks the box and scrolls down in the same task.
    { name: "sub-agent clock: viewport shrinks 360 px and the host moves 345 px down before the resize callback", run: ({ host, geometry }) => {
      settle(host);
      geometry.resizeBy(-360);
      hostWrite(host, host.scrollTop + 345);
    }, pinned: false, unpinned: false },
    { name: "sub-agent clock: viewport shrinks 360 px and the host moves 143 px down before the resize callback", run: ({ host, geometry }) => {
      settle(host);
      geometry.resizeBy(-360);
      hostWrite(host, host.scrollTop + 143);
    }, pinned: false, unpinned: false },
    // Review-3 M1: reader input that moves up off the end is the reader leaving; reader input at the end stays the reader's.
    { name: "page-level PageUp lease moves 40 px up off the end", run: ({ host }) => {
      act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true })));
      hostWrite(host, host.scrollTop - 40);
      act(() => document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "PageUp", bubbles: true, cancelable: true })));
    }, pinned: false, unpinned: false },
    { name: "scrollbar lease drags 20 px up off the end", run: ({ host }) => {
      host.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 816, bottom: 600, width: 816, height: 600, toJSON: () => ({}) });
      act(() => document.dispatchEvent(new PointerEvent("pointerdown", { clientX: 808, clientY: 300, bubbles: true })));
      hostWrite(host, host.scrollTop - 20);
      act(() => document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
    }, pinned: false, unpinned: false },
    // Gamma's approval click: a card 161 px tall below the rows, focus lands on it, it shrinks, the browser clamps up to the end.
    { name: "focus lease over an end clamp after a 161 px shrink", run: ({ host, geometry }) => {
      geometry.addDomExtra(161);
      settle(host); // the old end: layout, a pinned reader is written to the new end
      settle(host); // our write's echo
      act(() => firstRow().dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
      geometry.addDomExtra(-161);
      settle(host);
    }, pinned: true, unpinned: false },
    { name: "reader lease scroll to the end", run: ({ host }) => {
      act(() => host.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 })));
      hostWrite(host, host.scrollHeight);
    }, pinned: true, unpinned: true },
    { name: "unmatched move into content", run: ({ host }) => hostWrite(host, 2_000), pinned: false, unpinned: false },
  ];
  test.each(routes.flatMap((route) => (["pinned", "unpinned"] as const)
    .filter((state) => route[state] !== null)
    .map((state) => [`${route.name} while ${state}`, route, state] as const)))(
    "scroll route: %s reports the viewport and keeps the intent table",
    async (_, route, state) => {
      const geometry = installScrollGeometry();
      try {
        const { append, host, jump, store, unseen } = mountTimeline();
        if (state === "unpinned") {
          act(() => host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 })));
          moveReader(host);
          await settleReader();
        }
        let oldEnd = state === "unpinned" ? end(host) : 0;
        for (let index = 0; index < 150; index++) {
          if (state === "pinned") oldEnd = end(host);
          append();
        }
        const lastId = () => store.getOutline().at(-1)!.id;
        route.run({ host, oldEnd, geometry });
        const pinnedAfter = route[state]!;
        expect(viewportCoverage(host, lastId()), `${route.name} must leave mounted rows under the viewport`).toStartWith("covered");
        const unseenBefore = Number(unseen());
        const top = host.scrollTop;
        append();
        expect(viewportCoverage(host, lastId())).toStartWith("covered");
        if (pinnedAfter) {
          expect(unseen(), `${route.name} must keep or resume follow`).toBe("0");
          expect(jump()).toBeNull();
          expect(host.scrollTop).toBe(end(host));
        } else {
          expect(unseen(), `${route.name} must leave follow off`).toBe(String(unseenBefore + 1));
          expect(jump()).not.toBeNull();
          expect(host.scrollTop, `${route.name} must not snap back`).toBe(top);
        }
        if (state === "unpinned" && !pinnedAfter) expect(unseenBefore, "the reader still has every unseen row").toBe(150);
      } finally { geometry.restore(); }
    },
  );

  test("a pinned stream's scroll echo adds no React commit", () => {
    const geometry = installScrollGeometry();
    try {
      const store = createRunStore((flush) => flush());
      store.resync(Array.from({ length: 300 }, (_, index) => message(`row-${index}`)));
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      let commits = 0;
      act(() => root!.render(<Profiler id="timeline" onRender={() => { commits++; }}><RunProvider store={store}><Timeline virtual /></RunProvider></Profiler>));
      const host = container.querySelector<HTMLElement>('[data-part="timeline-scroll"]')!;
      hostWrite(host, host.scrollHeight);
      let echoCommits = 0;
      for (let index = 0; index < 200; index++) {
        act(() => store.dispatch(message(`added-${index}`)));
        const before = commits;
        act(() => host.dispatchEvent(new Event("scroll"))); // the browser's echo of our end write
        echoCommits += commits - before;
      }
      expect(echoCommits, "reporting an unchanged viewport must not re-render").toBe(0);
      expect(host.scrollTop).toBe(end(host));
    } finally { geometry.restore(); }
  });

  // Every reader-input lease has one start and guaranteed ends. Two public effects show a lease:
  // a held lease defers the host's follow request, and an armed lease makes the next scroll the reader's
  // (so a non-input scroll to the end re-pins, which F1 forbids for a host write without input).
  type LeaseKind = "wheel" | "focus" | "keyboard" | "scrollbar" | "touch";
  type Transition = "start" | "normal end" | "release without move" | "blur end" | "visibility end" | "detach end" | "end without start" | "duplicate start";
  type Mounted = ReturnType<typeof mountTimeline>;
  const firstRow = () => container!.querySelector<HTMLElement>("[data-virtual-id]")!;
  const rect = (top: number, bottom: number) => () => ({ x: 0, y: top, left: 0, top, right: 816, bottom, width: 816, height: bottom - top, toJSON: () => ({}) });
  const startLease = (kind: LeaseKind, { host }: Mounted) => act(() => {
    if (kind === "wheel") host.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
    else if (kind === "focus") {
      // A focus scrolls only a row that is not fully visible: this one hangs 40 px below the viewport.
      host.getBoundingClientRect = rect(0, 600);
      firstRow().getBoundingClientRect = rect(580, 640);
      firstRow().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    }
    else if (kind === "keyboard") firstRow().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    else if (kind === "scrollbar") {
      host.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 816, bottom: 600, width: 816, height: 600, toJSON: () => ({}) });
      host.dispatchEvent(new PointerEvent("pointerdown", { clientX: 808, clientY: 300, bubbles: true }));
    } else {
      const touch = new Event("touchstart", { bubbles: true }) as TouchEvent;
      Object.defineProperty(touch, "touches", { value: [{ clientY: 100 }] });
      host.dispatchEvent(touch);
    }
  });
  // A key ends at its release event. A scrollbar drag, a wheel, focus, or touch lease ends when its scroll moved and then
  // settled (two frames with no reader callback); without a start, the release or the settle alone changes nothing.
  const endLease = async (kind: LeaseKind, { host }: Mounted, started: boolean) => {
    if (kind === "scrollbar" && started) moveReader(host, host.scrollTop - 40); // a drag before the release
    act(() => {
      if (kind === "keyboard") firstRow().dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowDown", bubbles: true }));
      else if (kind === "scrollbar") document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      else if (kind === "touch") host.dispatchEvent(new Event("touchend", { bubbles: true }));
    });
    if (kind === "keyboard" || (kind === "scrollbar" && !started)) return;
    if (started && kind !== "scrollbar") moveReader(host, host.scrollTop - 40);
    await settleReader();
  };
  const hideDocument = () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try { act(() => document.dispatchEvent(new Event("visibilitychange"))); } finally { delete (document as unknown as Record<string, unknown>).visibilityState; }
  };
  const runTransition = async (kind: LeaseKind, transition: Transition, timeline: Mounted) => {
    if (transition === "end without start") return endLease(kind, timeline, false);
    startLease(kind, timeline);
    if (transition === "release without move") return endLease(kind, timeline, false);
    if (transition === "duplicate start") { startLease(kind, timeline); await endLease(kind, timeline, true); }
    else if (transition === "normal end") await endLease(kind, timeline, true);
    else if (transition === "blur end") act(() => window.dispatchEvent(new Event("blur")));
    else if (transition === "visibility end") hideDocument();
    else if (transition === "detach end") timeline.detach();
  };
  // [held: defers follow, armed: the next scroll is the reader's]; "duplicate start" is two starts and one normal end.
  // A release without a move: a released key stays armed (its scroll may start after keyup); a touch tap or an
  // unmoved scrollbar press has no direction, so it arms nothing.
  const heldKind = { held: [true, true], "normal end": [false, true], "release without move": [false, true], "blur end": [false, false], "visibility end": [false, false], "detach end": [false, false], "end without start": [false, false], "duplicate start": [false, true] } as const;
  const leaseTable: Record<LeaseKind, Record<Transition, readonly [boolean, boolean]>> = {
    keyboard: { ...heldKind, start: heldKind.held },
    scrollbar: { ...heldKind, start: heldKind.held, "normal end": [false, false], "release without move": [false, false], "duplicate start": [false, false] },
    touch: { start: [true, true], "normal end": [false, false], "release without move": [false, false], "blur end": [false, false], "visibility end": [false, false], "detach end": [false, false], "end without start": [false, false], "duplicate start": [false, false] },
    wheel: { start: [false, true], "normal end": [false, false], "release without move": [false, true], "blur end": [false, false], "visibility end": [false, false], "detach end": [false, false], "end without start": [false, false], "duplicate start": [false, false] },
    focus: { start: [false, true], "normal end": [false, false], "release without move": [false, true], "blur end": [false, false], "visibility end": [false, false], "detach end": [false, false], "end without start": [false, false], "duplicate start": [false, false] },
  };
  const leaseRows = (Object.keys(leaseTable) as LeaseKind[]).flatMap((kind) =>
    (Object.keys(leaseTable[kind]) as Transition[]).map((transition) => [kind, transition, ...leaseTable[kind][transition]] as const));
  const unpinnedWithUnseen = async () => {
    const timeline = mountTimeline(true);
    act(() => timeline.host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 })));
    moveReader(timeline.host);
    await settleReader();
    timeline.append();
    expect(timeline.unseen()).toBe("1");
    return timeline;
  };
  test.each(leaseRows)("lease %s %s: held %p, armed %p", async (kind, transition, held, armed) => {
    const geometry = installScrollGeometry();
    try {
      let timeline = await unpinnedWithUnseen();
      await runTransition(kind, transition, timeline);
      timeline.follow();
      expect(timeline.unseen(), held ? "a held lease must defer the follow request" : "no held lease may block the follow request").toBe(held ? "1" : "0");
      act(() => root!.unmount());
      root = undefined;
      container!.remove();

      timeline = await unpinnedWithUnseen();
      await runTransition(kind, transition, timeline);
      hostWrite(timeline.host, timeline.host.scrollHeight);
      expect(timeline.unseen(), armed ? "an armed lease makes the scroll to the end the reader's" : "without a lease a host write to the end must not resume follow (F1)").toBe(armed ? "0" : "1");
    } finally { geometry.restore(); }
  });

  // Input with no direction arms no lease, so it cannot claim our commit's clamp-up as the reader leaving (design review
  // M2, the mermaid commit-clamp route). A focus that needs a scroll still arms, and its scroll down keeps the pin.
  const noDirectionInput = {
    "a row click that focuses a fully visible row": (host: HTMLElement) => {
      const row = [...container!.querySelectorAll<HTMLElement>("[data-virtual-id]")].at(-2)!;
      host.getBoundingClientRect = rect(0, 600);
      row.getBoundingClientRect = rect(400, 450);
      act(() => row.dispatchEvent(new PointerEvent("pointerdown", { clientX: 8, clientY: 420, bubbles: true })));
      act(() => row.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
      act(() => document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
    },
    "a touch tap": (host: HTMLElement) => {
      const touch = new Event("touchstart", { bubbles: true }) as TouchEvent;
      Object.defineProperty(touch, "touches", { value: [{ clientY: 100 }] });
      act(() => host.dispatchEvent(touch));
      act(() => host.dispatchEvent(new Event("touchend", { bubbles: true })));
    },
    "a scrollbar press released without a move": (host: HTMLElement) => {
      host.getBoundingClientRect = rect(0, 600);
      act(() => host.dispatchEvent(new PointerEvent("pointerdown", { clientX: 808, clientY: 300, bubbles: true })));
      act(() => document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
    },
  };
  test.each(Object.keys(noDirectionInput) as Array<keyof typeof noDirectionInput>)("pinned, %s, then our commit's clamp-up and a wrap before the callback: follow stays on", (input) => {
    const geometry = installScrollGeometry();
    const observer = installRowObserver();
    try {
      const { append, host, jump, unseen } = mountTimeline();
      observer.measure(() => 72);
      append();
      const added = [...container!.querySelectorAll<HTMLElement>("[data-virtual-id]")].at(-1)!.dataset.virtualId!;
      const pinnedTop = host.scrollTop;
      expect(host.scrollHeight - host.clientHeight - pinnedTop, "the reader starts at the end").toBeLessThanOrEqual(0.5);
      noDirectionInput[input](host);
      expect(host.scrollTop, `${input} moved nothing`).toBe(pinnedTop);
      observer.measure((id) => id === added ? 34 : undefined); // 38 px under the estimate: the browser clamps up
      const clampedTop = host.scrollTop;
      expect(clampedTop, "our commit shrank the DOM: the browser clamped the reader up").toBeLessThan(pinnedTop - 0.5);
      host.scrollTop = clampedTop; // a browser stores the clamped position (this geometry only clamps on read)
      geometry.addDomExtra(23); // the row wraps before the clamp's scroll callback runs
      act(() => host.dispatchEvent(new Event("scroll")));
      append();
      expect(unseen(), `${input} has no direction: follow must survive our own clamp`).toBe("0");
      expect(jump()).toBeNull();
    } finally {
      observer.restore();
      geometry.restore();
    }
  });

  test("pinned, focus on a last row that hangs below the viewport: the browser scrolls it into view and follow stays on", () => {
    const geometry = installScrollGeometry();
    try {
      const { append, host, jump, unseen } = mountTimeline();
      geometry.addDomExtra(20); // the last row grew 20 px below the viewport before any callback
      const last = [...container!.querySelectorAll<HTMLElement>("[data-virtual-id]")].at(-1)!;
      host.getBoundingClientRect = rect(0, 600);
      last.getBoundingClientRect = rect(560, 620);
      act(() => last.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
      host.scrollTop = host.scrollHeight; // the browser scrolls the focused row into view, down to the end
      act(() => host.dispatchEvent(new Event("scroll")));
      append();
      expect(unseen(), "a focus that scrolls down to the end keeps follow").toBe("0");
      expect(jump()).toBeNull();
      expect(host.scrollHeight - host.clientHeight - host.scrollTop).toBeLessThanOrEqual(0.5);
    } finally { geometry.restore(); }
  });

  // A scroll key counts only when the browser would scroll this host with it.
  test.each(["external textarea", "external listbox that prevents default", "editable inside the timeline", "second timeline", "page body"] as const)(
    "ArrowUp from %s while pinned",
    (source) => {
      const geometry = installScrollGeometry();
      const extra = document.createElement("div");
      document.body.append(extra);
      let otherRoot: Root | undefined;
      try {
        const { append, host, jump, unseen } = mountTimeline();
        let target: Element = document.body;
        if (source === "external textarea") target = extra.appendChild(document.createElement("textarea"));
        else if (source === "external listbox that prevents default") {
          target = extra.appendChild(document.createElement("div"));
          target.setAttribute("role", "listbox");
          target.addEventListener("keydown", (event) => event.preventDefault());
        } else if (source === "editable inside the timeline") target = firstRow().appendChild(document.createElement("input"));
        else if (source === "second timeline") {
          const store = createRunStore((flush) => flush());
          store.resync(Array.from({ length: 300 }, (_, index) => message(`other-${index}`)));
          otherRoot = createRoot(extra);
          act(() => otherRoot!.render(<RunProvider store={store}><Timeline virtual /></RunProvider>));
          target = extra.querySelector("[data-virtual-id]")!;
        }
        act(() => {
          target.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
          target.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowUp", bubbles: true, cancelable: true }));
        });
        append();
        if (source === "page body") {
          expect(unseen(), "a page-level key alone moves no scroller").toBe("0");
          expect(jump()).toBeNull();
        } else {
          expect(unseen(), `ArrowUp from ${source} must not turn follow off`).toBe("0");
          expect(jump()).toBeNull();
          expect(host.scrollTop).toBe(host.scrollHeight - host.clientHeight);
        }
      } finally {
        act(() => otherRoot?.unmount());
        extra.remove();
        geometry.restore();
      }
    },
  );

  test("a page-level PageUp drops follow only on the timeline the browser scrolled", () => {
    const geometry = installScrollGeometry();
    const extra = document.createElement("div");
    document.body.append(extra);
    let otherRoot: Root | undefined;
    try {
      const { append, host, unseen } = mountTimeline();
      const other = createRunStore((flush) => flush());
      other.resync(Array.from({ length: 300 }, (_, index) => message(`other-${index}`)));
      otherRoot = createRoot(extra);
      act(() => otherRoot!.render(<RunProvider store={other}><Timeline virtual /></RunProvider>));
      const otherHost = extra.querySelector<HTMLElement>('[data-part="timeline-scroll"]')!;
      otherHost.scrollTop = otherHost.scrollHeight;
      act(() => otherHost.dispatchEvent(new Event("scroll")));
      act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true })));
      // The browser scrolls one scroller for a page-level key: here the first timeline, one page up.
      hostWrite(host, host.scrollTop - 540);
      act(() => document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "PageUp", bubbles: true, cancelable: true })));
      append();
      act(() => other.dispatch(message("other-added")));
      expect(unseen(), "the timeline the key scrolled stops following").toBe("1");
      expect(extra.querySelector<HTMLElement>('[data-part="timeline"]')!.dataset.unseenCount, "a timeline the key did not scroll keeps following").toBe("0");
      expect(otherHost.scrollTop).toBe(otherHost.scrollHeight - otherHost.clientHeight);
    } finally {
      act(() => otherRoot?.unmount());
      extra.remove();
      geometry.restore();
    }
  });

  // Review-3 M1: a page-level key move up off the end is the reader leaving, as on main when idle.
  test("a page-level 40 px ArrowUp off the end of a pinned timeline drops follow", () => {
    const geometry = installScrollGeometry();
    try {
      const { append, host, jump, unseen } = mountTimeline();
      act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })));
      hostWrite(host, host.scrollTop - 40);
      act(() => document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowUp", bubbles: true, cancelable: true })));
      const readerTop = host.scrollTop;
      append();
      expect(unseen(), "a page-level key move up off the end must drop follow").toBe("1");
      expect(jump()).not.toBeNull();
      expect(host.scrollTop, "the reader's 40 px move must not snap back").toBe(readerTop);
    } finally { geometry.restore(); }
  });

  // Review-3 M1: a held page key or a slow scrollbar drag up escapes a streaming run: 6 x 20 px up, one append after each.
  test.each(["held page-level ArrowUp", "slow scrollbar drag"] as const)("%s escapes while the run streams", (input) => {
    const geometry = installScrollGeometry();
    try {
      const { append, host, jump, unseen } = mountTimeline();
      if (input === "held page-level ArrowUp") act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })));
      else {
        host.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 816, bottom: 600, width: 816, height: 600, toJSON: () => ({}) });
        act(() => document.dispatchEvent(new PointerEvent("pointerdown", { clientX: 808, clientY: 300, bubbles: true })));
      }
      const distances: number[] = [];
      for (let step = 0; step < 6; step++) {
        if (input === "held page-level ArrowUp") act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true, repeat: true })));
        hostWrite(host, host.scrollTop - 20);
        append();
        distances.push(end(host) - host.scrollTop);
      }
      if (input === "held page-level ArrowUp") act(() => document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowUp", bubbles: true, cancelable: true })));
      else act(() => document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
      expect(distances.every((distance, index) => index === 0 ? distance > 0 : distance > distances[index - 1]!), `the distance from the end must grow at every step: ${distances.join(",")}`).toBe(true);
      expect(unseen(), "every append after the reader left is unseen").toBe("6");
      expect(jump()).not.toBeNull();
    } finally { geometry.restore(); }
  });

  // F1: a host write that lands exactly at the end while unpinned does not resume follow; reader input at the end does.
  test.each(["host scrollTop", "scrollIntoView", "find-style scroll"] as const)("F1: %s landing at the end while unpinned keeps follow off until reader input", async (kind) => {
    const geometry = installScrollGeometry();
    try {
      const { append, host, jump, unseen } = mountTimeline();
      act(() => host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 })));
      moveReader(host);
      await settleReader();
      append();
      expect(unseen()).toBe("1");
      if (kind === "scrollIntoView") {
        const row = container!.querySelector<HTMLElement>("[data-virtual-id]")!;
        row.scrollIntoView = () => moveReader(host, end(host));
        row.scrollIntoView();
      } else moveReader(host, kind === "host scrollTop" ? host.scrollHeight : end(host));
      expect(host.scrollTop, `${kind} lands exactly at the end`).toBe(end(host));
      append();
      expect(unseen(), `${kind} at the end must not resume follow (F1)`).toBe("2");
      expect(jump()).not.toBeNull();
      act(() => host.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 })));
      moveReader(host, host.scrollHeight);
      append();
      expect(unseen(), "reader input at the end re-pins").toBe("0");
      expect(jump()).toBeNull();
      expect(host.scrollTop).toBe(end(host));
    } finally { geometry.restore(); }
  });

  // Premise of classifyScroll: the element that really scrolls has overflow-anchor none while attached (no browser
  // anchoring, so non-input moves are only upward clamps), and gets its own value back on detach. A DOM shim cannot
  // run anchoring; the browser probe covers that (scratch premise-probe.log).
  test.each([false, true])("premise: the scroll element has overflow-anchor none while attached (hosted %p)", (hosted) => {
    const geometry = installScrollGeometry();
    try {
      const { host } = mountTimeline(hosted);
      expect(host.style.overflowAnchor, "the element that scrolls must not anchor").toBe("none");
      expect(container!.querySelector<HTMLElement>('[data-part="timeline"]')!.style.overflowAnchor, "rows are never anchor candidates").toBe("none");
      act(() => root!.unmount());
      root = undefined;
      expect(host.style.overflowAnchor, "detach restores the element's own value").toBe("");
    } finally { geometry.restore(); }
  });

  // Gamma's approval click: focus lands on the approve button, the card shrinks, and the browser clamps to the new end.
  test("a focus click that shrinks its card keeps a pinned stream following", () => {
    const geometry = installScrollGeometry();
    try {
      const { append, host, jump, unseen } = mountTimeline();
      geometry.addDomExtra(161);
      append();
      act(() => firstRow().dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
      geometry.addDomExtra(-161);
      settle(host);
      append();
      expect(unseen(), "the end clamp under a focus lease is not intent").toBe("0");
      expect(jump()).toBeNull();
      expect(host.scrollTop).toBe(host.scrollHeight - host.clientHeight);
    } finally { geometry.restore(); }
  });

  // Content outside the rows (a host's artifact list inside the scroll host) can change the DOM end while a pinned reader
  // is idle; a later host move (find, scrollIntoView) far from the end is still the host's intent.
  test.each([false, true])("idle content growth outside the rows, then a far host move, drops follow without a snap (hosted %p)", async (hosted) => {
    const geometry = installScrollGeometry();
    try {
      const { append, host, jump, unseen } = mountTimeline(hosted);
      geometry.addDomExtra(200);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const target = host.scrollHeight - host.clientHeight - 3_000;
      hostWrite(host, target);
      expect(host.scrollTop, "the host's far move is kept, not written back to the end").toBe(target);
      append();
      expect(unseen()).toBe("1");
      expect(jump()).not.toBeNull();
      expect(host.scrollTop).toBe(target);
    } finally { geometry.restore(); }
  });

  test("arrow keys on a focused row move between rows; arrow keys in a control inside a row stay with the control", async () => {
    const geometry = installScrollGeometry();
    try {
      mountTimeline();
      const rows = [...container!.querySelectorAll<HTMLElement>("[data-virtual-id]")];
      const row = rows[rows.length - 2]!;
      const index = Number(row.dataset.virtualIndex);
      act(() => row.focus());
      const onRow = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
      act(() => { row.dispatchEvent(onRow); });
      expect(onRow.defaultPrevented, "ArrowUp on a focused row navigates").toBeTrue();
      await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      expect((document.activeElement as HTMLElement | null)?.dataset.virtualIndex, "focus moves to the previous row").toBe(String(index - 1));

      const input = rows[rows.length - 1]!.appendChild(document.createElement("input"));
      act(() => input.focus());
      const inControl = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
      act(() => { input.dispatchEvent(inControl); });
      expect(inControl.defaultPrevented, "ArrowUp in a control inside a row belongs to the control").toBeFalse();
      await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      expect(document.activeElement).toBe(input);
    } finally { geometry.restore(); }
  });

  test("an overlay scrollbar drag to the end re-pins, and a row click starts no scrollbar lease", async () => {
    const geometry = installScrollGeometry();
    try {
      let timeline = await unpinnedWithUnseen();
      // Overlay scrollbars take no gutter: the drag's pointerdown lands on the host itself.
      act(() => timeline.host.dispatchEvent(new PointerEvent("pointerdown", { clientX: 400, clientY: 300, bubbles: true })));
      hostWrite(timeline.host, timeline.host.scrollHeight);
      act(() => document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
      expect(timeline.unseen(), "a scrollbar drag down to the end re-pins").toBe("0");
      act(() => root!.unmount());
      root = undefined;
      container!.remove();

      timeline = await unpinnedWithUnseen();
      act(() => firstRow().dispatchEvent(new PointerEvent("pointerdown", { clientX: 400, clientY: 300, bubbles: true })));
      timeline.follow();
      expect(timeline.unseen(), "a row click must not hold a scrollbar lease").toBe("0");
    } finally { geometry.restore(); }
  });

  // A row can change height after our last write (a streaming marker, a font, an image, late highlighting).
  test.each([["grows", 6.5], ["shrinks", -6.5]] as const)("a row above the anchor that %s after the last write keeps the anchor's offset", (_, delta) => {
    const geometry = installScrollGeometry();
    const observer = installRowObserver();
    try {
      const { host, unseen } = mountTimeline();
      observer.measure(() => 72);
      moveReader(host, 3_000);
      observer.measure(() => 72);
      const ids = [...container!.querySelectorAll<HTMLElement>("[data-virtual-id]")].map((row) => row.dataset.virtualId!);
      const anchorIndex = ids.findIndex((id) => (rowOffset(host, id) ?? -1) >= 0);
      const anchorId = ids[anchorIndex]!;
      const above = ids[anchorIndex - 2]!;
      const before = rowOffset(host, anchorId)!;
      const top = host.scrollTop;
      observer.measure((id) => id === above ? 72 + delta : undefined);
      echo(host, top);
      expect(Math.abs(rowOffset(host, anchorId)! - before), `${anchorId} must keep its offset when ${above} changes height`).toBeLessThanOrEqual(0.5);
      expect(unseen()).toBe("0");
    } finally {
      observer.restore();
      geometry.restore();
    }
  });

  test("the last row growing after the last write keeps a pinned reader at the bottom", () => {
    const geometry = installScrollGeometry();
    const observer = installRowObserver();
    try {
      const { append, host, jump, unseen } = mountTimeline();
      observer.measure(() => 72);
      const last = [...container!.querySelectorAll<HTMLElement>("[data-virtual-id]")].at(-1)!.dataset.virtualId!;
      const top = host.scrollTop;
      observer.measure((id) => id === last ? 102 : undefined);
      echo(host, top);
      expect(host.scrollHeight - host.clientHeight - host.scrollTop, "a pinned reader stays at the bottom").toBeLessThanOrEqual(0.5);
      append();
      expect(unseen()).toBe("0");
      expect(jump()).toBeNull();
    } finally {
      observer.restore();
      geometry.restore();
    }
  });

  // Review 4 B1: browsers animate wheel and key scrolls, so one reader gesture reaches the end over several frames and
  // scroll callbacks. A reader who scrolls all the way down re-pins, however many frames the gesture takes.
  test.each(["wheel one tick", "End key, keyup after frame 1"] as const)("an animated reader scroll down to the end re-pins (%s)", (gesture) => {
    const geometry = installScrollGeometry();
    const observer = installRowObserver();
    const nextFrame = () => observer.measure(() => undefined);
    try {
      const { append, host, jump, unseen } = mountTimeline();
      observer.measure(() => 72);
      act(() => host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 })));
      moveReader(host, host.scrollHeight - host.clientHeight - 600);
      nextFrame(); // two frames with no reader callback settle the reader's scroll
      nextFrame();
      append();
      expect(unseen(), "the reader starts unpinned with one unseen row").toBe("1");
      const start = host.scrollTop;
      const distance = host.scrollHeight - host.clientHeight - start;
      const key = (type: "keydown" | "keyup") => act(() => document.body.dispatchEvent(new KeyboardEvent(type, { key: "End", bubbles: true, cancelable: true })));
      if (gesture !== "wheel one tick") clickRow();
      if (gesture === "wheel one tick") act(() => host.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 })));
      else key("keydown");
      [0.4, 0.75, 0.95, 1].forEach((share, frame) => {
        moveReader(host, share === 1 ? host.scrollHeight : start + distance * share); // the browser's animation frame
        if (frame === 0 && gesture !== "wheel one tick") key("keyup");
        nextFrame();
      });
      expect(host.scrollTop, "the gesture ends exactly at the end").toBe(host.scrollHeight - host.clientHeight);
      append();
      expect(unseen(), "a reader who scrolled down to the end follows again").toBe("0");
      expect(jump(), "the jump control leaves once the reader is at the end").toBeNull();
    } finally {
      observer.restore();
      geometry.restore();
    }
  });

  // Round 5: a lease settles after two frames with no reader callback. Our own writes are not reader callbacks, so a
  // pinned stream that writes every frame must not keep one wheel tick's lease alive: the WebKit banner clamp later
  // (3 px shrink, 41 px up, no input) is still layout and the reader keeps following.
  test("our own writes never extend a reader lease: after a wheel re-pin and a pinned stream, the banner clamp is layout", () => {
    const geometry = installScrollGeometry();
    const observer = installRowObserver();
    const nextFrame = () => observer.measure(() => undefined);
    try {
      const { append, host, unseen } = mountTimeline();
      observer.measure(() => 72);
      act(() => host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 })));
      moveReader(host, host.scrollHeight - host.clientHeight - 600);
      nextFrame();
      nextFrame();
      append();
      expect(unseen(), "the reader starts unpinned").toBe("1");
      // One wheel tick down: the browser's scroll lands at the end and the reader follows again; the lease is now moving.
      act(() => host.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 })));
      moveReader(host, host.scrollHeight - host.clientHeight);
      // A pinned stream: our end write and its echo every frame. Only reader callbacks keep a lease alive.
      for (let frame = 0; frame < 6; frame++) {
        const before = host.scrollTop;
        append();
        echo(host, before);
        nextFrame();
      }
      expect(unseen(), "the stream keeps the reader pinned").toBe("0");
      expect(host.scrollTop, "the stream keeps the reader at the end").toBe(host.scrollHeight - host.clientHeight);
      geometry.resizeBy(-3);
      host.scrollTop -= 41; // the browser's clamp (WebKit banner capture), no input
      act(() => host.dispatchEvent(new Event("scroll")));
      append();
      expect(unseen(), "the banner clamp after the stream is layout, not the reader leaving").toBe("0");
    } finally {
      observer.restore();
      geometry.restore();
    }
  });

  // Gamma CI (chromium, CPU 12x, run s-long): measured rows replace larger estimates, the DOM end shrinks (821 -> 682),
  // and the browser clamps scrollTop down (227 -> 88) with the gap to the end still 0. The clamp's scroll callback came
  // late, after main's 50 ms ignore window, and main unpinned the timeline (unseen 8 -> 384, the last row never mounted).
  // A clamp at the DOM end with no input is layout however late it arrives.
  test("pinned: rows measure smaller than their estimates, and the browser's clamp to the new end arrives late: the reader stays pinned", async () => {
    const geometry = installScrollGeometry();
    const observer = installRowObserver();
    try {
      const { append, host, jump, unseen } = mountTimeline();
      expect(unseen()).toBe("0");
      const lastId = () => [...container!.querySelectorAll<HTMLElement>("[data-virtual-id]")].at(-1)!.dataset.virtualId!;
      const before = host.scrollTop;
      // Every mounted row is 42 px smaller than the 72 px message estimate. The browser clamps scrollTop to the new DOM
      // end at layout; under load the clamp's scroll callback runs before the measurement frame, and late.
      const shrink = 42 * container!.querySelectorAll("[data-virtual-id]").length;
      geometry.addDomExtra(-shrink); // rows are in flow: the DOM end shrinks at once; the engine learns it at its frame
      observer.measure(() => 30, false);
      expect(host.scrollHeight - host.clientHeight, "the DOM end shrank").toBeLessThan(before);
      await new Promise((resolve) => setTimeout(resolve, 80)); // past any short ignore window
      act(() => host.dispatchEvent(new Event("scroll"))); // the browser's late clamp callback, at the DOM end
      geometry.addDomExtra(shrink); // the measurement frame moves the shrink into the rows' own size
      for (let frame = 0; frame < 3; frame++) observer.measure(() => undefined);
      expect(host.scrollTop, "the clamp leaves the reader at the DOM end").toBe(host.scrollHeight - host.clientHeight);
      append();
      observer.measure(() => 30);
      expect(unseen(), "a late clamp to the DOM end is layout: the reader stays pinned").toBe("0");
      expect(jump()).toBeNull();
      expect(lastId(), "the newest row is mounted").toBe("message:added-300");
    } finally {
      observer.restore();
      geometry.restore();
    }
  });

  // Arming (round 5): a lease starts only for input the browser will use to scroll this host. Input that another
  // scroller takes, or that has no room to move, arms nothing, so a later host write at the end stays the host's (F1)
  // and a layout clamp stays layout. An armed lease that never moved ends at other input, a pointer press, or blur.
  const nestedScroller = () => {
    const nested = container!.querySelector("[data-virtual-id]")!.appendChild(document.createElement("div"));
    nested.style.overflowY = "auto";
    nested.tabIndex = 0;
    return nested;
  };
  const noArmCases = {
    "PageDown with focus in a nested scroller": (host: HTMLElement) => act(() => nestedScroller().dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true }))),
    "a wheel over a nested scroller": (host: HTMLElement) => act(() => nestedScroller().dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true }))),
    "a page-level PageDown after a click outside every timeline": () => {
      const outside = document.body.appendChild(document.createElement("div"));
      act(() => outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
      act(() => document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
      act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true })));
      outside.remove();
    },
    "a page-level PageDown after a click in another scroller": () => {
      const other = document.body.appendChild(document.createElement("div"));
      other.style.overflowY = "auto";
      act(() => other.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
      act(() => document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
      act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true })));
      other.remove();
    },
    "an unmoved wheel lease, then a row click": (host: HTMLElement) => {
      act(() => host.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 })));
      clickRow();
    },
    "an unmoved wheel lease, then a key that scrolls nothing": (host: HTMLElement) => {
      act(() => host.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 })));
      act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true })));
      act(() => document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true, cancelable: true })));
    },
    "an unmoved wheel lease, then window blur": (host: HTMLElement) => {
      act(() => host.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 })));
      act(() => window.dispatchEvent(new Event("blur")));
    },
  } as const;
  test.each(Object.keys(noArmCases) as Array<keyof typeof noArmCases>)("%s: a host write at the end afterwards does not resume follow (F1)", async (name) => {
    const geometry = installScrollGeometry();
    try {
      const { append, host, jump, unseen } = mountTimeline();
      act(() => host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 })));
      moveReader(host);
      await settleReader();
      append();
      expect(unseen(), "the reader starts unpinned").toBe("1");
      noArmCases[name](host);
      hostWrite(host, host.scrollHeight);
      append();
      expect(unseen(), `after ${name}, a host write at the end must not resume follow`).toBe("2");
      expect(jump()).not.toBeNull();
    } finally { geometry.restore(); }
  });
  test.each(["PageDown with focus in a nested scroller", "a wheel over a nested scroller"] as const)("%s while pinned: the banner clamp stays layout", (name) => {
    const geometry = installScrollGeometry();
    try {
      const { append, host, unseen } = mountTimeline();
      const nested = nestedScroller();
      act(() => nested.dispatchEvent(name.startsWith("PageDown")
        ? new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true })
        : new WheelEvent("wheel", { deltaY: 100, bubbles: true })));
      geometry.resizeBy(-3);
      host.scrollTop -= 41; // the browser's clamp (WebKit banner capture), no input
      act(() => host.dispatchEvent(new Event("scroll")));
      append();
      expect(unseen(), `the banner clamp after ${name} is layout, not the reader leaving`).toBe("0");
    } finally { geometry.restore(); }
  });
  test("End at the DOM end arms nothing: a later host write at the end does not resume follow (F1)", async () => {
    const geometry = installScrollGeometry();
    try {
      const { append, host, jump, unseen } = mountTimeline();
      act(() => host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 })));
      moveReader(host);
      await settleReader();
      append();
      hostWrite(host, host.scrollHeight); // F1: the host lands at the end; follow stays off
      expect(unseen()).toBe("1");
      clickRow();
      act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })));
      act(() => document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "End", bubbles: true, cancelable: true })));
      append();
      hostWrite(host, host.scrollHeight);
      append();
      expect(unseen(), "End with no room below arms nothing, so the host write stays the host's").toBe("3");
      expect(jump()).not.toBeNull();
    } finally { geometry.restore(); }
  });
  test("a page-level End after a click in the timeline arms it, and the reader's scroll to the end follows again", async () => {
    const geometry = installScrollGeometry();
    try {
      const { append, host, jump, unseen } = mountTimeline();
      act(() => host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 })));
      moveReader(host);
      await settleReader();
      append();
      expect(unseen()).toBe("1");
      clickRow();
      act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })));
      act(() => document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "End", bubbles: true, cancelable: true })));
      moveReader(host, host.scrollHeight);
      append();
      expect(unseen(), "the reader's End scroll to the end follows again").toBe("0");
      expect(jump()).toBeNull();
    } finally { geometry.restore(); }
  });

  // Reader moves never read as layout, for every input kind, animated over 4 callbacks or done in 1: a reader who
  // scrolls down to the end follows again; a reader who scrolls up off the end stops following.
  const gestureKinds = ["wheel", "keyboard", "touch", "scrollbar"] as const;
  const gestureRows = gestureKinds.flatMap((kind) => ([1, 4] as const).flatMap((callbacks) =>
    (["down to the end", "up off the end"] as const).map((direction) => [kind, callbacks, direction] as const)));
  test.each(gestureRows)("reader %s gesture over %p callback(s), %s", (kind, callbacks, direction) => {
    const geometry = installScrollGeometry();
    const observer = installRowObserver();
    const nextFrame = () => observer.measure(() => undefined);
    try {
      const { append, host, unseen } = mountTimeline();
      observer.measure(() => 72);
      if (direction === "down to the end") {
        act(() => host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 })));
        moveReader(host, host.scrollHeight - host.clientHeight - 600);
        nextFrame(); // two frames with no reader callback settle the reader's scroll
        nextFrame();
        append();
        expect(unseen(), "the reader starts unpinned").toBe("1");
      }
      const up = direction === "up off the end";
      const begin = () => act(() => {
        if (kind === "wheel") host.dispatchEvent(new WheelEvent("wheel", { deltaY: up ? -100 : 100 }));
        else if (kind === "keyboard") document.body.dispatchEvent(new KeyboardEvent("keydown", { key: up ? "PageUp" : "End", bubbles: true }));
        else if (kind === "scrollbar") host.dispatchEvent(new PointerEvent("pointerdown", { clientX: 808, clientY: 300, bubbles: true }));
        else {
          const touch = new Event("touchstart", { bubbles: true }) as TouchEvent;
          Object.defineProperty(touch, "touches", { value: [{ clientY: 100 }] });
          host.dispatchEvent(touch);
        }
      });
      const release = () => act(() => {
        if (kind === "keyboard") document.body.dispatchEvent(new KeyboardEvent("keyup", { key: up ? "PageUp" : "End", bubbles: true }));
        else if (kind === "scrollbar") document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        else if (kind === "touch") host.dispatchEvent(new Event("touchend", { bubbles: true }));
      });
      const start = host.scrollTop;
      const end = host.scrollHeight - host.clientHeight;
      if (kind === "keyboard") clickRow();
      begin();
      for (let frame = 1; frame <= callbacks; frame++) {
        moveReader(host, up ? start - 20 * frame * (4 / callbacks) : frame === callbacks ? end : start + (end - start) * frame / (callbacks + 1));
        if (frame === 1) release(); // the release lands mid-animation; the browser keeps scrolling
        nextFrame();
      }
      if (callbacks === 1) release();
      if (!up) expect(host.scrollTop, "the gesture ends at the end").toBe(host.scrollHeight - host.clientHeight);
      append();
      if (up) expect(unseen(), "a reader who scrolled up off the end stops following").toBe("1");
      else {
        expect(unseen(), "a reader who scrolled down to the end follows again").toBe("0");
        expect(host.scrollTop, "and follows the new row to the new end").toBe(host.scrollHeight - host.clientHeight);
      }
    } finally {
      observer.restore();
      geometry.restore();
    }
  });

  // mermaid-check "swap virtual bottom": a new row mounts at its estimate, measures smaller, and our own commit shrinks
  // the DOM, so the browser clamps a pinned reader to the new end with no callback yet. The row then wraps taller
  // before that callback runs: the reader must still be at the end, not read as moving up.
  test("our commit shrinks the DOM under a pinned reader, then the last row grows before the callback: the reader stays pinned", () => {
    const geometry = installScrollGeometry();
    const observer = installRowObserver();
    try {
      const { append, host, jump, unseen } = mountTimeline();
      observer.measure(() => 72);
      append();
      const added = [...container!.querySelectorAll<HTMLElement>("[data-virtual-id]")].at(-1)!.dataset.virtualId!;
      const pinnedTop = host.scrollTop;
      expect(host.scrollHeight - host.clientHeight - pinnedTop, "the reader starts at the end").toBeLessThanOrEqual(0.5);
      observer.measure((id) => id === added ? 34 : undefined); // 38 px under the estimate: the browser clamps up
      const clampedTop = host.scrollTop;
      expect(clampedTop, "our commit shrank the DOM: the browser clamped the reader up").toBeLessThan(pinnedTop - 0.5);
      host.scrollTop = clampedTop; // a browser stores the clamped position (this geometry only clamps on read)
      geometry.addDomExtra(23); // the row wraps before the clamp's scroll callback runs
      act(() => host.dispatchEvent(new Event("scroll")));
      expect(host.scrollHeight - host.clientHeight - host.scrollTop, "a pinned reader stays at the end after the clamp and the wrap").toBeLessThanOrEqual(0.5);
      append();
      expect(unseen(), "follow must survive our own clamp").toBe("0");
      expect(jump()).toBeNull();
    } finally {
      observer.restore();
      geometry.restore();
    }
  });

  test("a late row resize while the reader's key scroll is in flight: the reader's scroll wins, nothing snaps back", () => {
    const geometry = installScrollGeometry();
    const observer = installRowObserver();
    try {
      const { append, host, jump, unseen } = mountTimeline();
      observer.measure(() => 72);
      const last = [...container!.querySelectorAll<HTMLElement>("[data-virtual-id]")].at(-1)!.dataset.virtualId!;
      clickRow();
      act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true })));
      const readerTop = host.scrollTop - 540;
      host.scrollTop = readerTop; // the browser moved the reader; its scroll callback has not run yet
      observer.measure((id) => id === last ? 102 : undefined);
      expect(host.scrollTop, "a late resize must not overwrite the reader's unreported move").toBe(readerTop);
      act(() => host.dispatchEvent(new Event("scroll")));
      act(() => document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "PageUp", bubbles: true, cancelable: true })));
      append();
      expect(host.scrollTop, "the reader's scroll wins").toBe(readerTop);
      expect(unseen()).toBe("1");
      expect(jump()).not.toBeNull();
    } finally {
      observer.restore();
      geometry.restore();
    }
  });
});
