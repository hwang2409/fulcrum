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
  // Every scroll callback reports the real viewport; the route only decides follow intent (rules 1 and 2, F1).
  const routes: ReadonlyArray<{ name: string; run(context: RouteContext): void; pinned: boolean | null; unpinned: boolean | null }> = [
    { name: "own echo", run: ({ host }) => act(() => host.dispatchEvent(new Event("scroll"))), pinned: true, unpinned: false },
    { name: "end clamp at the old end", run: ({ host, oldEnd }) => hostWrite(host, oldEnd), pinned: true, unpinned: false },
    { name: "end clamp at the new end", run: ({ host }) => hostWrite(host, host.scrollHeight), pinned: true, unpinned: null },
    { name: "host write to scrollHeight (F1)", run: ({ host }) => hostWrite(host, host.scrollHeight), pinned: null, unpinned: false },
    // Cause, not distance: with no size change since our last write, a host move is intent even inside the engine's 48 px
    // bottom threshold (the pinned stale-end cell below is that 10 px case: a pinned reader's end is never stale);
    // with a content or viewport size change since then, it is layout and a pinned reader keeps follow.
    { name: "host write 10 px above a grown end (stale end)", run: ({ host }) => hostWrite(host, end(host) - 10), pinned: false, unpinned: false },
    { name: "host move 100 px up, no size change", run: ({ host }) => hostWrite(host, end(host) - 100), pinned: false, unpinned: null },
    { name: "host write 10 px above the end after content grew", run: ({ host, geometry }) => {
      geometry.addDomExtra(30);
      hostWrite(host, end(host) - 10);
    }, pinned: true, unpinned: null },
    // The captured WebKit reconnect route: a banner shrinks the box 3 px and the browser moves the reader 41 px up.
    { name: "viewport shrink moves the reader 41 px up before the resize callback", run: ({ host, geometry }) => {
      geometry.resizeBy(-3);
      hostWrite(host, end(host) - 44);
    }, pinned: true, unpinned: null },
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
    (_, route, state) => {
      const geometry = installScrollGeometry();
      try {
        const { append, host, jump, store, unseen } = mountTimeline();
        if (state === "unpinned") {
          act(() => host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 })));
          moveReader(host);
          act(() => host.dispatchEvent(new Event("scrollend")));
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
  type Transition = "start" | "normal end" | "blur end" | "visibility end" | "detach end" | "end without start" | "duplicate start";
  type Mounted = ReturnType<typeof mountTimeline>;
  const firstRow = () => container!.querySelector<HTMLElement>("[data-virtual-id]")!;
  const startLease = (kind: LeaseKind, { host }: Mounted) => act(() => {
    if (kind === "wheel") host.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
    else if (kind === "focus") firstRow().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
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
  const endLease = (kind: LeaseKind, { host }: Mounted) => act(() => {
    if (kind === "keyboard") firstRow().dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowDown", bubbles: true }));
    else if (kind === "scrollbar") document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    else {
      if (kind === "touch") host.dispatchEvent(new Event("touchend", { bubbles: true }));
      host.dispatchEvent(new Event("scrollend"));
    }
  });
  const hideDocument = () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try { act(() => document.dispatchEvent(new Event("visibilitychange"))); } finally { delete (document as unknown as Record<string, unknown>).visibilityState; }
  };
  const runTransition = (kind: LeaseKind, transition: Transition, timeline: Mounted) => {
    if (transition === "end without start") return endLease(kind, timeline);
    startLease(kind, timeline);
    if (transition === "duplicate start") { startLease(kind, timeline); endLease(kind, timeline); }
    else if (transition === "normal end") endLease(kind, timeline);
    else if (transition === "blur end") act(() => window.dispatchEvent(new Event("blur")));
    else if (transition === "visibility end") hideDocument();
    else if (transition === "detach end") timeline.detach();
  };
  // [held: defers follow, armed: the next scroll is the reader's]; "duplicate start" is two starts and one normal end.
  const heldKind = { held: [true, true], "normal end": [false, true], "blur end": [false, false], "visibility end": [false, false], "detach end": [false, false], "end without start": [false, false], "duplicate start": [false, true] } as const;
  const leaseTable: Record<LeaseKind, Record<Transition, readonly [boolean, boolean]>> = {
    keyboard: { ...heldKind, start: heldKind.held },
    scrollbar: { ...heldKind, start: heldKind.held },
    touch: { start: [true, true], "normal end": [false, false], "blur end": [false, false], "visibility end": [false, false], "detach end": [false, false], "end without start": [false, false], "duplicate start": [false, false] },
    wheel: { start: [false, true], "normal end": [false, false], "blur end": [false, false], "visibility end": [false, false], "detach end": [false, false], "end without start": [false, false], "duplicate start": [false, false] },
    focus: { start: [false, true], "normal end": [false, false], "blur end": [false, false], "visibility end": [false, false], "detach end": [false, false], "end without start": [false, false], "duplicate start": [false, false] },
  };
  const leaseRows = (Object.keys(leaseTable) as LeaseKind[]).flatMap((kind) =>
    (Object.keys(leaseTable[kind]) as Transition[]).map((transition) => [kind, transition, ...leaseTable[kind][transition]] as const));
  const unpinnedWithUnseen = () => {
    const timeline = mountTimeline(true);
    act(() => timeline.host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 })));
    moveReader(timeline.host);
    act(() => timeline.host.dispatchEvent(new Event("scrollend")));
    timeline.append();
    expect(timeline.unseen()).toBe("1");
    return timeline;
  };
  test.each(leaseRows)("lease %s %s: held %p, armed %p", (kind, transition, held, armed) => {
    const geometry = installScrollGeometry();
    try {
      let timeline = unpinnedWithUnseen();
      runTransition(kind, transition, timeline);
      timeline.follow();
      expect(timeline.unseen(), held ? "a held lease must defer the follow request" : "no held lease may block the follow request").toBe(held ? "1" : "0");
      act(() => root!.unmount());
      root = undefined;
      container!.remove();

      timeline = unpinnedWithUnseen();
      runTransition(kind, transition, timeline);
      hostWrite(timeline.host, timeline.host.scrollHeight);
      expect(timeline.unseen(), armed ? "an armed lease makes the scroll to the end the reader's" : "without a lease a host write to the end must not resume follow (F1)").toBe(armed ? "0" : "1");
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
          expect(unseen(), "a page-level scroll key is reader intent").toBe("1");
          expect(jump()).not.toBeNull();
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

  // Known limit of the cause rule: a host move that coincides with a content-size change our write has not seen yet
  // (same frame, before the scroll callback) is read as layout, so a pinned reader snaps back to the end.
  test("known limit: a far host move in the same frame as unseen content growth is layout while pinned", () => {
    const geometry = installScrollGeometry();
    try {
      const { append, host, jump, unseen } = mountTimeline();
      geometry.addDomExtra(30);
      const row = container!.querySelector<HTMLElement>("[data-virtual-id]")!;
      row.scrollIntoView = () => moveReader(host, host.scrollHeight - host.clientHeight - 3_000);
      row.scrollIntoView();
      expect(host.scrollTop, "the move is read as layout and the pinned reader is written back to the end").toBe(host.scrollHeight - host.clientHeight);
      append();
      expect(unseen()).toBe("0");
      expect(jump()).toBeNull();
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

  test("an overlay scrollbar drag to the end re-pins, and a row click starts no scrollbar lease", () => {
    const geometry = installScrollGeometry();
    try {
      let timeline = unpinnedWithUnseen();
      // Overlay scrollbars take no gutter: the drag's pointerdown lands on the host itself.
      act(() => timeline.host.dispatchEvent(new PointerEvent("pointerdown", { clientX: 400, clientY: 300, bubbles: true })));
      hostWrite(timeline.host, timeline.host.scrollHeight);
      act(() => document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
      expect(timeline.unseen(), "a scrollbar drag down to the end re-pins").toBe("0");
      act(() => root!.unmount());
      root = undefined;
      container!.remove();

      timeline = unpinnedWithUnseen();
      act(() => firstRow().dispatchEvent(new PointerEvent("pointerdown", { clientX: 400, clientY: 300, bubbles: true })));
      timeline.follow();
      expect(timeline.unseen(), "a row click must not hold a scrollbar lease").toBe("0");
    } finally { geometry.restore(); }
  });
});
