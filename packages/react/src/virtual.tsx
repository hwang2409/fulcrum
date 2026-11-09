import {
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type RefCallback,
  type RefObject,
} from "react";
import {
  createVirtualizer,
  formatVirtualDebug,
  type OutlineItem,
  type OutlineUpdate,
  type ScrollSource,
  type VirtualOptions,
  type VirtualCache,
  type VirtualSnapshot,
  type Virtualizer,
} from "@fulcrum/virtual";
import { classifyScroll } from "./scroll-class.js";

const isIOSWebKit = () => navigator.userAgent.includes("iP");

type ScrollLeaseKind = "wheel" | "focus" | "keyboard" | "scrollbar" | "touch";
type HeldLeaseKind = "keyboard" | "scrollbar" | "touch";
type ScrollDirection = -1 | 1;
type ScrollLeases = ReturnType<typeof createScrollLeases>;

/**
 * The one owner of reader-input leases for one scroll host. A lease follows motion that continues in the input's
 * direction and bounded reach; it does not expire between sparse browser callbacks. An inconsistent callback ends it.
 * Native scrollend is not an end signal because Chromium can send it in the middle of a key animation.
 */
function createScrollLeases(onSettled: () => void) {
  const held = new Set<HeldLeaseKind>();
  let kind: ScrollLeaseKind | null = null;
  let phase: "armed" | "moving" | null = null;
  let direction: ScrollDirection | null = null;
  let limit = 0;
  let reach = 0;
  const boundary = (top: number, dir: ScrollDirection, distance: number) => top + dir * distance;
  const extend = (top: number, dir: ScrollDirection, distance: number) => {
    const next = boundary(top, dir, distance);
    limit = dir > 0 ? Math.max(limit, next) : Math.min(limit, next);
  };
  const accumulate = (top: number, dir: ScrollDirection, distance: number) => {
    limit = dir > 0 ? Math.max(limit, top) + distance : Math.min(limit, top) - distance;
  };
  const clear = (settled: boolean) => {
    const wasMoving = phase === "moving";
    kind = null;
    phase = null;
    direction = null;
    limit = 0;
    reach = 0;
    if (settled && wasMoving) onSettled();
  };
  return {
    /** Input that will scroll this host. Same-direction repeats extend the current target in every phase. */
    start(nextKind: ScrollLeaseKind, top: number, nextDirection: ScrollDirection | null, nextReach: number) {
      if (nextDirection !== null && kind === nextKind && direction === nextDirection && phase !== null) {
        accumulate(top, nextDirection, nextReach);
        reach = nextReach;
      } else {
        clear(true);
        kind = nextKind;
        phase = "armed";
        direction = nextDirection;
        reach = nextReach;
        if (nextDirection !== null) limit = boundary(top, nextDirection, nextReach);
      }
      if (nextKind === "keyboard" || nextKind === "scrollbar" || nextKind === "touch") held.add(nextKind);
    },
    /** Input that will not scroll this host. A pointer press also stops a running animation lease. */
    input(nextKind: ScrollLeaseKind | "pointer") {
      if (phase === "moving" && nextKind === "pointer") clear(true);
      else if (phase === "armed" && kind !== nextKind) clear(false);
    },
    /** Touch movement supplies the content-scroll direction before momentum starts. */
    swipe(nextDirection: ScrollDirection, top: number) {
      if (kind !== "touch" || phase === null) return;
      if (direction === null) {
        direction = nextDirection;
        limit = boundary(top, nextDirection, Number.POSITIVE_INFINITY);
      }
    },
    /** Ends a held lease. Releasing preserves accumulated reach; an unmoved scrollbar press or tap arms nothing. */
    end(endedKind: HeldLeaseKind, top: number, releaseReach: number) {
      if (!held.delete(endedKind) || kind !== endedKind || phase === null) return;
      if (direction === null) {
        clear(false);
        return;
      }
      extend(top, direction, releaseReach);
    },
    /** Called once per scroll callback: whether the callback continues reader motion. */
    consume(facts: { ours: boolean; top: number; lastTop: number; atEnd: boolean; resized: boolean }) {
      const delta = facts.top - facts.lastTop;
      if (facts.ours) {
        if (direction !== null && Number.isFinite(limit)) limit += delta;
        return false;
      }
      if (held.size > 0 && phase !== null) {
        if (Math.abs(delta) > 0.5 && direction === null) {
          direction = delta > 0 ? 1 : -1;
          limit = boundary(facts.top, direction, reach);
        }
        if (Math.abs(delta) > 0.5) phase = "moving";
        return true;
      }
      if (phase === null || direction === null) return false;
      if (facts.resized) {
        clear(true);
        return false;
      }
      if (Math.abs(delta) <= 0.5) return phase === "moving";
      const inDirection = direction * delta > 0.5;
      const inReach = direction > 0 ? facts.top <= limit + 1.5 : facts.top >= limit - 1.5;
      if (!inDirection) {
        if (phase === "moving") clear(true);
        return false;
      }
      if (!inReach || (direction < 0 && facts.atEnd)) {
        if (phase === "moving") clear(true);
        return false;
      }
      phase = "moving";
      const oneMove = kind === "focus";
      const atBoundary = (direction > 0 && facts.atEnd) || (direction < 0 && facts.top <= 0.5);
      if (oneMove || atBoundary) clear(true);
      return true;
    },
    held: () => held.size > 0,
    /** Corrections yield only while a directional reader motion is active. */
    active: () => held.size > 0 || (phase !== null && direction !== null),
    touching: () => held.has("touch"),
    /** Window blur, a hidden document, or host detach: no release event will come. */
    release() {
      held.clear();
      clear(true);
    },
  };
}

// The target of the last pointer press in this document: a key with focus on the page body scrolls that target's
// scroller (the browser rows check this per engine). One record shared by every host.
let lastPointerTarget: Element | null = null;

// Editable and list widgets handle their own arrow keys; a scroll key typed there never scrolls the timeline.
const keyOwners = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="listbox"]';
const downKeys = new Set(["ArrowDown", "PageDown", "End"]);
const upKeys = new Set(["ArrowUp", "PageUp", "Home"]);

/**
 * Whether a vertical scroll that starts at `from` moves `container`: the browser scrolls the nearest ancestor that can
 * still move that way, so a code block or a nested list that can scroll takes the input, and one at its edge passes it on.
 */
function willScroll(container: HTMLElement, from: Element | null, down: boolean) {
  for (let element = from; element; element = element.parentElement) {
    const room = down ? element.scrollHeight - element.clientHeight - element.scrollTop : element.scrollTop;
    if (element === container) return room > 0.5;
    if (room > 0.5 && element.scrollHeight > element.clientHeight + 0.5) {
      const { overflowY } = getComputedStyle(element);
      if (overflowY === "auto" || overflowY === "scroll") return false;
    }
  }
  return false;
}

export type VirtualListOptions<Id extends string> = VirtualOptions<Id> & {
  scrollRef?: RefObject<HTMLElement | null>;
  enabled?: boolean;
  /** How `outline` came from the prior one; the engine edits in place when it holds that prior outline. */
  outlineUpdate?: OutlineUpdate<Id> | null;
  /** Resets the virtual engine when the outline owner changes. */
  resetKey?: unknown;
  /** Rows whose content changed while their stable ids survived an outline replacement. */
  invalidateMeasurements?: readonly Id[];
};

export type VirtualListState<Id extends string> = {
  snapshot: VirtualSnapshot<Id>;
  debug: string | false;
  unseenCount: number;
  timelineRef: RefCallback<HTMLElement>;
  observeRow(id: Id): RefCallback<HTMLElement>;
  scrollToId(id: Id, viewportOffset?: number): void;
  scrollToEnd(): void;
  /** Re-pins after a host-confirmed local action, unless the user is touching the viewport. */
  requestFollow(): void;
  /** Measured row sizes, to seed a later list over the same outline through `cache`. */
  snapshotCache(): VirtualCache<Id>;
};

/** React DOM adapter for the framework-neutral virtual engine. Options are fixed for the hook lifetime. */
export function useVirtualList<Id extends string>(
  outline: readonly OutlineItem<Id>[],
  options: VirtualListOptions<Id>,
): VirtualListState<Id> {
  const engineRef = useRef<ReturnType<typeof createVirtualizer<Id>>>(undefined);
  if (!engineRef.current) engineRef.current = createVirtualizer(options);
  const engine = engineRef.current;
  const appliedResetKey = useRef(options.resetKey);
  const resetPending = appliedResetKey.current !== options.resetKey;
  const debug = typeof window !== "undefined" && location.search.includes("virtualDebug=1");
  if (debug) (window as typeof window & { __fulcrumVirtual?: typeof engine }).__fulcrumVirtual = engine;
  const containerRef = useRef<HTMLElement | null>(null);
  const timelineElement = useRef<HTMLElement | null>(null);
  const rows = useRef(new Map<Id, HTMLElement>());
  const rowCallbacks = useRef(new Map<Id, RefCallback<HTMLElement>>());
  const rowIds = useRef(new WeakMap<Element, Id>());
  const observerRef = useRef<ResizeObserver | null>(null);
  const resizeFrame = useRef<number | null>(null);
  const pendingEntries = useRef(new Map<Id, number>());
  const leases = useRef<ScrollLeases | null>(null);
  const lastScrollTop = useRef(0);
  const lastDomEnd = useRef(0);
  const lastScrollHeight = useRef(0);
  const pendingScroll = useRef<{ target: "end" | number; value: number; previousEnd: number } | null>(null);
  const initial = useRef(true);
  const wasEnabled = useRef(options.enabled !== false);
  const appliedOutline = useRef<readonly OutlineItem<Id>[] | null>(null);
  const attachment = useRef<{ host: HTMLElement | null; settled: boolean }>({ host: null, settled: false });
  const releaseCurrent = useRef<(() => void) | null>(null);
  const transferCurrent = useRef<((next: HTMLElement | null) => void) | null>(null);

  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);

  const writeScroll = useCallback((target: "end" | number) => {
    const container = containerRef.current;
    if (!container) return;
    const domEnd = Math.max(0, container.scrollHeight - container.clientHeight);
    const value = target === "end" || engine.getSnapshot().pinned ? domEnd : target;
    container.scrollTop = value;
    // The pending value is what the browser stored: WebKit keeps whole pixels (a 4442.625 write reads 4442).
    lastScrollTop.current = container.scrollTop;
    pendingScroll.current = { target, value: lastScrollTop.current, previousEnd: lastDomEnd.current };
    lastDomEnd.current = domEnd;
    lastScrollHeight.current = container.scrollHeight;
  }, [engine]);

  const touching = () => leases.current?.touching() ?? false;

  const resetHostState = () => {
    if (resizeFrame.current != null) cancelAnimationFrame(resizeFrame.current);
    resizeFrame.current = null;
    leases.current?.release();
    leases.current = null;
    pendingScroll.current = null;
    pendingEntries.current.clear();
    lastScrollTop.current = 0;
    lastDomEnd.current = 0;
    lastScrollHeight.current = 0;
    engine.flushPendingCorrection(false, true);
  };

  useLayoutEffect(() => {
    if (resetPending) {
      appliedResetKey.current = options.resetKey;
      appliedOutline.current = null;
      initial.current = true;
      wasEnabled.current = options.enabled !== false;
      engine.reset();
    }
    if (appliedOutline.current !== outline) {
      appliedOutline.current = outline;
      const token = engine.beforeMutation();
      if (options.invalidateMeasurements) engine.invalidateMeasurements(options.invalidateMeasurements);
      engine.setOutline(outline, options.outlineUpdate);
      engine.setLoaded("all");
      if (initial.current) initial.current = false;
      else if (options.enabled !== false && wasEnabled.current) engine.afterMutation(token, { deferCorrection: touching() && isIOSWebKit() });
    }
    wasEnabled.current = options.enabled !== false;
  }, [engine, outline, options.enabled, options.invalidateMeasurements, options.outlineUpdate, options.resetKey, resetPending]);

  useLayoutEffect(() => {
    const transfer = (next: HTMLElement | null) => {
      if (attachment.current.host === next) return;
      // the engine owns the reader's position intent (follow-bottom or anchor) until a measured layout on the current host confirms it.
      if (attachment.current.host) {
        releaseCurrent.current?.();
        attachment.current.settled = true;
        attachment.current.host = null;
        releaseCurrent.current = null;
        containerRef.current = null;
      }
      if (!next) return;
      const container = next;
      const prior = attachment.current.settled;
      attachment.current.settled = false;
      containerRef.current = container;
      const priorOverflowAnchor = container.style.overflowAnchor;
      container.style.overflowAnchor = "none";
      const updateViewport = (source: ScrollSource) =>
        engine.setViewport({ scrollTop: container.scrollTop, size: container.clientHeight, source });
      if (prior) {
        const intent = engine.beforeMutation();
        updateViewport("programmatic");
        engine.afterMutation(intent);
      } else updateViewport("user");
      lastScrollTop.current = container.scrollTop;
      lastDomEnd.current = Math.max(0, container.scrollHeight - container.clientHeight);
      lastScrollHeight.current = container.scrollHeight;

      const flushMeasurements = () => {
        resizeFrame.current = null;
        if (pendingEntries.current.size === 0) return;
        const token = engine.beforeMutation();
        for (const [id, size] of pendingEntries.current) engine.measure(id, size);
        pendingEntries.current.clear();
        engine.afterMutation(token, { deferCorrection: touching() && isIOSWebKit() });
      };
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const id = rowIds.current.get(entry.target);
          if (id !== undefined) pendingEntries.current.set(id, entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height);
        }
        if (resizeFrame.current === null) resizeFrame.current = requestAnimationFrame(flushMeasurements);
        // Rows are in flow, so the DOM already has the new end: a pinned reader sticks to it before this frame paints,
        // not a frame later when the engine measures (and then agrees). Moving scroll resizes nothing: no observer loop.
        // The user beats the engine: a scroll the engine has not seen yet (a scrollbar drag sends no input event first)
        // is the reader's move, so the follow waits for its scroll event, which unpins; wheel, keys, and touch unpin earlier.
        const { pinned, scrollTop } = engine.getSnapshot();
        if (pinned && Math.abs(container.scrollTop - scrollTop) < 1) writeScroll("end");
      });
      observerRef.current = observer;
      for (const row of rows.current.values()) observer.observe(row);

      const finishScroll = () => {
        const result = engine.flushPendingCorrection();
        if (Math.abs(result.jump) >= 0.5) writeScroll(result.scrollTop);
      };
      const hostLeases = createScrollLeases(finishScroll);
      leases.current = hostLeases;
      const onScroll = () => {
        const before = engine.getSnapshot();
        const domEnd = Math.max(0, container.scrollHeight - container.clientHeight);
        const pending = pendingScroll.current;
        pendingScroll.current = null; // the first callback consumes our write, whether the browser matched it or not
        const top = container.scrollTop;
        const pendingMatch = pending !== null && (Math.abs(top - pending.value) < 0.5
          || (typeof pending.target === "number" && Math.abs(top - pending.target) < 0.5));
        const priorDomEnd = pending?.previousEnd ?? lastDomEnd.current;
        const slack = Math.min(1, Math.abs(domEnd - priorDomEnd));
        const atEnd = Math.abs(top - priorDomEnd) <= slack + 0.5 || Math.abs(top - domEnd) <= slack + 0.5;
        const kind = classifyScroll({
          lease: hostLeases.consume({
            ours: pendingMatch,
            top,
            lastTop: lastScrollTop.current,
            atEnd,
            resized: Math.abs(container.clientHeight - before.viewportSize) >= 0.5,
          }),
          pendingMatch,
          top,
          lastTop: lastScrollTop.current,
          domEnd,
          lastDomEnd: lastDomEnd.current,
          priorDomEnd,
          scrollHeight: container.scrollHeight,
          lastScrollHeight: lastScrollHeight.current,
          clientHeight: container.clientHeight,
          viewportSize: before.viewportSize,
          bottomThreshold: engine.bottomThreshold,
        });
        lastScrollTop.current = top;
        lastDomEnd.current = domEnd;
        lastScrollHeight.current = container.scrollHeight;
        const layout = kind === "own" || kind === "layout";
        if (layout && before.pinned && Math.abs(top - domEnd) >= 0.5) writeScroll("end");
        if (kind === "intent" && before.pinned) engine.setFollow(false);
        // Every callback reports the real viewport, so the mounted rows always follow the DOM; classification decides only intent.
        engine.setViewport({ scrollTop: container.scrollTop, size: container.clientHeight, source: layout ? "observe" : "user" });
      };
      const onWheel = (event: WheelEvent) => {
        const vertical = Math.abs(event.deltaY) > Math.abs(event.deltaX);
        if (event.defaultPrevented || !vertical || !willScroll(container, event.target as Element | null, event.deltaY > 0)) return hostLeases.input("wheel");
        const direction = event.deltaY > 0 ? 1 : -1;
        const pixels = event.deltaMode === 2 ? Math.abs(event.deltaY) * container.clientHeight
          : event.deltaMode === 1 ? Math.abs(event.deltaY) * 40 : Math.abs(event.deltaY);
        hostLeases.start("wheel", container.scrollTop, direction, Math.max(container.clientHeight, pixels));
        if (event.deltaY < 0 && engine.getSnapshot().pinned) engine.setFollow(false);
      };
      // A scroll key arms only when the browser will scroll this host with it: this host is the nearest scroller that can
      // move that way from the focused element (the key event's target), outside an editable or list widget. With focus
      // on the page body, the browser scrolls the scroller of the last pointer press, so the key starts there.
      const onKeyDown = (event: KeyboardEvent) => {
        const down = downKeys.has(event.key) || (event.key === " " && !event.shiftKey);
        const up = upKeys.has(event.key) || (event.key === " " && event.shiftKey);
        const target = event.target instanceof Element ? event.target : null;
        const pageLevel = target === null || target === document.body || target === document.documentElement;
        const from = pageLevel ? lastPointerTarget : target;
        if (event.defaultPrevented || (!down && !up) || target?.closest(keyOwners) || !willScroll(container, from, down)) return hostLeases.input("keyboard");
        const direction = down ? 1 : -1;
        const reach = event.key === "End" || event.key === "Home" ? Number.POSITIVE_INFINITY : container.clientHeight;
        hostLeases.start("keyboard", container.scrollTop, direction, reach);
        if (up && engine.getSnapshot().pinned) engine.setFollow(false);
      };
      // Any key release ends the held key: a still-held key repeats its keydown, and a lost arrow keyup under Cmd still releases.
      const onKeyUp = () => hostLeases.end("keyboard", container.scrollTop, container.clientHeight);
      const onPointerDown = (event: PointerEvent) => {
        lastPointerTarget = event.target instanceof Element ? event.target : null;
        const bounds = container.getBoundingClientRect();
        const vertical = event.clientX >= bounds.left + container.clientWidth && event.clientX <= bounds.right
          && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
        const horizontal = event.clientY >= bounds.top + container.clientHeight && event.clientY <= bounds.bottom
          && event.clientX >= bounds.left && event.clientX <= bounds.right;
        // Overlay scrollbars take no gutter, so a press on the host itself (not a row) is a scrollbar press too.
        if (event.target === container || vertical || horizontal) hostLeases.start("scrollbar", container.scrollTop, null, container.clientHeight);
        else hostLeases.input("pointer");
      };
      const onPointerEnd = () => hostLeases.end("scrollbar", container.scrollTop, container.clientHeight);
      let touchY: number | null = null;
      const onTouchStart = (event: TouchEvent) => {
        hostLeases.start("touch", container.scrollTop, null, Number.POSITIVE_INFINITY);
        touchY = event.touches[0]?.clientY ?? null;
      };
      const onTouchMove = (event: TouchEvent) => {
        const next = event.touches[0]?.clientY;
        if (next !== undefined && touchY != null && Math.abs(next - touchY) > 0.5) {
          hostLeases.swipe(next < touchY ? 1 : -1, container.scrollTop);
          if (next > touchY && engine.getSnapshot().pinned) engine.setFollow(false);
        }
        touchY = next ?? null;
      };
      const onTouchEnd = () => {
        touchY = null;
        hostLeases.end("touch", container.scrollTop, Number.POSITIVE_INFINITY);
      };
      const onScrollEnd = () => finishScroll(); // never ends a lease: Chromium sends scrollend in the middle of a key animation
      // A focus scrolls this host only when its target is not fully visible inside it; a focus that needs no scroll arms nothing.
      const onFocusIn = (event: FocusEvent) => {
        if (!(event.target instanceof Element) || !container.contains(event.target)) return;
        const bounds = container.getBoundingClientRect();
        const box = event.target.getBoundingClientRect();
        if (box.top < bounds.top) hostLeases.start("focus", container.scrollTop, -1, bounds.top - box.top);
        else if (box.bottom > bounds.bottom) hostLeases.start("focus", container.scrollTop, 1, box.bottom - bounds.bottom);
      };
      const onBlur = () => hostLeases.release();
      const onVisibilityChange = () => {
        if (document.visibilityState === "hidden") hostLeases.release();
      };
      container.addEventListener("scroll", onScroll, { passive: true });
      container.addEventListener("scrollend", onScrollEnd, { passive: true });
      container.addEventListener("wheel", onWheel, { passive: true });
      container.addEventListener("touchstart", onTouchStart, { passive: true });
      container.addEventListener("touchmove", onTouchMove, { passive: true });
      container.addEventListener("touchend", onTouchEnd, { passive: true });
      container.addEventListener("touchcancel", onTouchEnd, { passive: true });
      document.addEventListener("keydown", onKeyDown);
      document.addEventListener("keyup", onKeyUp);
      document.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true }); // capture: a row that stops the press still counts
      document.addEventListener("pointerup", onPointerEnd, { passive: true });
      document.addEventListener("pointercancel", onPointerEnd, { passive: true });
      document.addEventListener("focusin", onFocusIn);
      document.addEventListener("visibilitychange", onVisibilityChange);
      window.addEventListener("blur", onBlur);
      // A scroll box that changes size (a banner above it, a composer below it) keeps a pinned reader at the bottom.
      const viewportObserver = new ResizeObserver(() => {
        const pinned = engine.getSnapshot().pinned;
        updateViewport("observe");
        lastScrollHeight.current = container.scrollHeight; // the engine has this resize now: it is not a content change
        if (!pinned) return;
        writeScroll("end");
        updateViewport("programmatic");
      });
      viewportObserver.observe(container);
      const release = () => {
        observer.disconnect();
        viewportObserver.disconnect();
        observerRef.current = null;
        container.removeEventListener("scroll", onScroll);
        container.removeEventListener("scrollend", onScrollEnd);
        container.removeEventListener("wheel", onWheel);
        container.removeEventListener("touchstart", onTouchStart);
        container.removeEventListener("touchmove", onTouchMove);
        container.removeEventListener("touchend", onTouchEnd);
        container.removeEventListener("touchcancel", onTouchEnd);
        document.removeEventListener("keydown", onKeyDown);
        document.removeEventListener("keyup", onKeyUp);
        document.removeEventListener("pointerdown", onPointerDown, { capture: true });
        document.removeEventListener("pointerup", onPointerEnd);
        document.removeEventListener("pointercancel", onPointerEnd);
        document.removeEventListener("focusin", onFocusIn);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        window.removeEventListener("blur", onBlur);
        resetHostState();
        container.style.overflowAnchor = priorOverflowAnchor;
      };
      attachment.current.host = container;
      releaseCurrent.current = release;
    };
    transferCurrent.current = transfer;
    transfer(options.enabled === false || typeof ResizeObserver === "undefined"
      ? null
      : options.scrollRef?.current ?? timelineElement.current?.parentElement ?? null);
  });

  useLayoutEffect(() => () => {
    transferCurrent.current?.(null);
    attachment.current.settled = false;
    transferCurrent.current = null;
    containerRef.current = null;
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const top = container.scrollTop;
    // The reader's scroll in flight (input armed, a position we have not seen yet) wins over a correction.
    if (leases.current?.active() && Math.abs(top - lastScrollTop.current) >= 0.5) return;
    if (Math.abs(snapshot.jump) >= 0.5 && Math.abs(top - snapshot.scrollTop) >= 0.5) writeScroll(snapshot.scrollTop);
    // Our commit shrank the DOM under a pinned reader and the browser clamped it to the new end before any callback:
    // record that end as our write, or content that grows before the callback reads as the reader moving up.
    else if (snapshot.pinned && Math.abs(top - lastScrollTop.current) >= 0.5
      && Math.abs(top - Math.max(0, container.scrollHeight - container.clientHeight)) < 0.5) writeScroll("end");
  }, [snapshot, writeScroll]);

  useLayoutEffect(() => () => engine.destroy(), [engine]);

  const timelineRef = useCallback((element: HTMLElement | null) => { timelineElement.current = element; }, []);

  const observeRow = useCallback((id: Id): RefCallback<HTMLElement> => {
    const cached = rowCallbacks.current.get(id);
    if (cached) return cached;
    const callback: RefCallback<HTMLElement> = (element) => {
      const prior = rows.current.get(id);
      if (prior) observerRef.current?.unobserve(prior);
      if (element) {
        rows.current.set(id, element);
        rowIds.current.set(element, id);
        observerRef.current?.observe(element);
      } else {
        rows.current.delete(id);
        // A resize reported before an unmount must not reach the engine: the id may have left the outline.
        pendingEntries.current.delete(id);
      }
    };
    rowCallbacks.current.set(id, callback);
    return callback;
  }, []);

  const scrollToId = useCallback((id: Id, viewportOffset = 0) => {
    const container = containerRef.current;
    if (!container) return;
    writeScroll(engine.scrollToId(id, viewportOffset));
  }, [engine, writeScroll]);

  const scrollToEnd = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    writeScroll(engine.scrollToEnd());
  }, [engine, writeScroll]);
  const requestFollow = useCallback(() => {
    if (leases.current?.held()) return;
    const container = containerRef.current;
    if (!container) return;
    const next = engine.requestFollow();
    if (next !== null) writeScroll(next);
  }, [engine, writeScroll]);

  const visibleSnapshot = resetPending
    ? { ...snapshot, totalSize: 0, topSpacer: 0, bottomSpacer: 0, rows: [] }
    : snapshot;
  return {
    snapshot: visibleSnapshot,
    debug: debug && formatVirtualDebug(visibleSnapshot, engine.getActions()),
    unseenCount: visibleSnapshot.unseenCount,
    timelineRef,
    observeRow,
    scrollToId,
    scrollToEnd,
    requestFollow,
    snapshotCache: engine.snapshotCache,
  };
}
