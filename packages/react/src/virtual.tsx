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

const isIOSWebKit = () => navigator.userAgent.includes("iP");

type ScrollLeaseKind = "wheel" | "focus" | "keyboard" | "scrollbar" | "touch";
type HeldLeaseKind = "keyboard" | "scrollbar" | "touch";
type ScrollLeases = ReturnType<typeof createScrollLeases>;

/**
 * The one owner of reader-input leases for one scroll host: which scroll callbacks the reader caused.
 * Wheel and focus arm a one-shot lease that the next scroll callback consumes (or the next frame expires).
 * Keyboard and scrollbar are held from press to release; touch is held until native scrollend or two quiet frames.
 * Every held lease ends on its release, on window blur, when the document is hidden, and on host detach. Plain state only.
 */
function createScrollLeases(onTouchSettled: () => void) {
  const held = new Set<HeldLeaseKind>();
  let armed = false;
  let armedFrame: number | null = null;
  let touching = false;
  let touchGeneration = 0;
  let settleFrame: number | null = null;
  const disarm = () => {
    armed = false;
    if (armedFrame != null) cancelAnimationFrame(armedFrame);
    armedFrame = null;
  };
  const arm = () => {
    disarm();
    armed = true;
    armedFrame = requestAnimationFrame(() => {
      armedFrame = null;
      armed = false;
    });
  };
  const stopSettling = () => {
    if (settleFrame != null) cancelAnimationFrame(settleFrame);
    settleFrame = null;
  };
  const settleTouch = () => {
    let observedGeneration = touchGeneration;
    let quietFrames = 0;
    const observe = () => {
      settleFrame = null;
      if (touchGeneration === observedGeneration) quietFrames++;
      else {
        observedGeneration = touchGeneration;
        quietFrames = 0;
      }
      if (quietFrames < 2) {
        settleFrame = requestAnimationFrame(observe);
        return;
      }
      held.delete("touch");
      onTouchSettled();
    };
    settleFrame = requestAnimationFrame(observe);
  };
  return {
    start(kind: ScrollLeaseKind) {
      if (kind === "touch") {
        stopSettling();
        touching = true;
      }
      if (kind === "keyboard" || kind === "scrollbar" || kind === "touch") held.add(kind);
      arm();
    },
    /** Ends a held lease; an end without its start changes nothing. */
    end(kind: HeldLeaseKind) {
      if (!held.has(kind)) return;
      if (kind === "touch") {
        touching = false;
        settleTouch();
        return;
      }
      held.delete(kind);
      arm(); // the release can still move the host once (key repeat, the last drag frame)
    },
    /** Called once per scroll callback: whether the reader caused it. */
    consume() {
      const fromReader = armed || held.size > 0;
      disarm();
      if (held.has("touch")) touchGeneration++;
      return fromReader;
    },
    held: () => held.size > 0,
    touching: () => touching,
    /** The browser reports the scroll gesture finished. */
    scrollEnd() {
      disarm();
      stopSettling();
      touching = false;
      held.delete("touch");
    },
    /** Window blur, a hidden document, or host detach: no release event will come. */
    release() {
      disarm();
      stopSettling();
      touching = false;
      held.clear();
    },
  };
}

// Editable and list widgets handle their own arrow keys; a scroll key typed there never scrolls the timeline.
const keyOwners = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="listbox"]';
const scrollKeys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

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
    pendingScroll.current = { target, value, previousEnd: lastDomEnd.current };
    container.scrollTop = value;
    lastScrollTop.current = container.scrollTop;
    lastDomEnd.current = domEnd;
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

      const flushMeasurements = () => {
        resizeFrame.current = null;
        if (pendingEntries.current.size === 0) return;
        const token = engine.beforeMutation();
        for (const [id, size] of pendingEntries.current) engine.measure(id, size);
        pendingEntries.current.clear();
        engine.afterMutation(token, { deferCorrection: touching() && isIOSWebKit() });
        // A late layout pass can leave WebKit a few pixels behind the new end after the measurement correction.
        // Re-apply the existing follow intent only when the DOM has not moved independently since the last scroll.
        const { pinned } = engine.getSnapshot();
        if (pinned && Math.abs(container.scrollTop - lastScrollTop.current) < 0.5) {
          writeScroll("end");
          updateViewport("programmatic");
        }
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
        const fromReader = hostLeases.consume();
        const pending = pendingScroll.current;
        pendingScroll.current = null; // the first callback consumes our write, whether the browser matched it or not
        const matchesPending = pending !== null && (Math.abs(container.scrollTop - pending.value) < 0.5
          || (typeof pending.target === "number" && Math.abs(container.scrollTop - pending.target) < 0.5));
        // Without reader input, a scroll is layout work when it is our exact write, stays at the old or new DOM end, or comes
        // with a size change since the last write or scroll we saw (content or viewport, e.g. a banner shrinking the box).
        // Focus, find, host scrollIntoView, and host scroll writes anywhere else, with no size change, are reader intent.
        // A stale old end can at worst misread intent for an unpinned reader (observe never re-pins); a pinned reader's end
        // is refreshed by every end write. Nothing else refreshes it: a scrollHeight read per commit would force a sync layout.
        const priorDomEnd = pending?.previousEnd ?? lastDomEnd.current;
        const layoutSlack = Math.min(1, Math.abs(domEnd - priorDomEnd));
        const nearEnd = (end: number) => Math.abs(container.scrollTop - end) <= layoutSlack + 0.5;
        const sizeChanged = Math.abs(domEnd - lastDomEnd.current) >= 0.5 || Math.abs(container.clientHeight - before.viewportSize) >= 0.5;
        const layout = !fromReader && (matchesPending || sizeChanged || nearEnd(priorDomEnd) || nearEnd(domEnd));
        lastScrollTop.current = container.scrollTop;
        lastDomEnd.current = domEnd;
        if (layout && before.pinned && Math.abs(container.scrollTop - domEnd) >= 0.5) writeScroll("end");
        // A scroll without input and without a size change, away from both ends, is host intent, even inside the engine's bottom threshold.
        if (!layout && !fromReader && before.pinned) engine.setFollow(false);
        // Every callback reports the real viewport, so the mounted rows always follow the DOM; classification decides only intent.
        engine.setViewport({ scrollTop: container.scrollTop, size: container.clientHeight, source: layout ? "observe" : "user" });
      };
      const onWheel = (event: WheelEvent) => {
        hostLeases.start("wheel");
        if (event.deltaY < 0 && engine.getSnapshot().pinned) engine.setFollow(false);
      };
      // A scroll key counts only when the browser would scroll this host with it: focus in this host outside an
      // editable or list widget, or no focus at all (the page body). Keys in a composer or another timeline do not.
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.defaultPrevented || !scrollKeys.has(event.key)) return;
        const target = event.target;
        const pageLevel = target === document || target === document.body || target === document.documentElement;
        if (!pageLevel && (!(target instanceof Element) || !container.contains(target) || target.closest(keyOwners))) return;
        hostLeases.start("keyboard");
        if ((event.key.endsWith("Up") || event.key === "Home") && engine.getSnapshot().pinned) engine.setFollow(false);
      };
      // Any key release ends the held key: a still-held key repeats its keydown, and a lost arrow keyup under Cmd still releases.
      const onKeyUp = () => hostLeases.end("keyboard");
      const onPointerDown = (event: PointerEvent) => {
        const bounds = container.getBoundingClientRect();
        const vertical = event.clientX >= bounds.left + container.clientWidth && event.clientX <= bounds.right
          && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
        const horizontal = event.clientY >= bounds.top + container.clientHeight && event.clientY <= bounds.bottom
          && event.clientX >= bounds.left && event.clientX <= bounds.right;
        // Overlay scrollbars take no gutter, so a press on the host itself (not a row) is a scrollbar press too.
        if (event.target === container || vertical || horizontal) hostLeases.start("scrollbar");
      };
      const onPointerEnd = () => hostLeases.end("scrollbar");
      let touchY: number | null = null;
      const onTouchStart = (event: TouchEvent) => {
        hostLeases.start("touch");
        touchY = event.touches[0]?.clientY ?? null;
      };
      const onTouchMove = (event: TouchEvent) => {
        const next = event.touches[0]?.clientY;
        if (next !== undefined && touchY != null && next > touchY && engine.getSnapshot().pinned) engine.setFollow(false);
        touchY = next ?? null;
      };
      const onTouchEnd = () => {
        touchY = null;
        hostLeases.end("touch");
      };
      const onScrollEnd = () => {
        hostLeases.scrollEnd();
        finishScroll();
      };
      const onFocusIn = (event: FocusEvent) => {
        if (event.target instanceof Node && container.contains(event.target)) hostLeases.start("focus");
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
      document.addEventListener("pointerdown", onPointerDown, { passive: true });
      document.addEventListener("pointerup", onPointerEnd, { passive: true });
      document.addEventListener("pointercancel", onPointerEnd, { passive: true });
      document.addEventListener("focusin", onFocusIn);
      document.addEventListener("visibilitychange", onVisibilityChange);
      window.addEventListener("blur", onBlur);
      // A scroll box that changes size (a banner above it, a composer below it) keeps a pinned reader at the bottom.
      const viewportObserver = new ResizeObserver(() => {
        const pinned = engine.getSnapshot().pinned;
        updateViewport("observe");
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
        document.removeEventListener("pointerdown", onPointerDown);
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
    if (container && Math.abs(snapshot.jump) >= 0.5 && Math.abs(container.scrollTop - snapshot.scrollTop) >= 0.5)
      writeScroll(snapshot.scrollTop);
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
