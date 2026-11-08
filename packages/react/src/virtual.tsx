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
  type VirtualOptions,
  type VirtualCache,
  type VirtualSnapshot,
  type Virtualizer,
} from "@fulcrum/virtual";

const isIOSWebKit = () => navigator.userAgent.includes("iP");

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
  const touching = useRef(false);
  const readerInput = useRef(false);
  const readerInputFrame = useRef<number | null>(null);
  const keyboardHeld = useRef(false);
  const scrollbarDragging = useRef(false);
  const touchMomentum = useRef(false);
  const touchY = useRef<number | null>(null);
  const touchGeneration = useRef(0);
  const touchSettleFrame = useRef<number | null>(null);
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

  const armReaderInput = () => {
    readerInput.current = true;
    if (readerInputFrame.current != null) cancelAnimationFrame(readerInputFrame.current);
    readerInputFrame.current = requestAnimationFrame(() => {
      readerInputFrame.current = null;
      readerInput.current = false;
    });
  };

  const resetHostState = () => {
    if (readerInputFrame.current != null) cancelAnimationFrame(readerInputFrame.current);
    if (touchSettleFrame.current != null) cancelAnimationFrame(touchSettleFrame.current);
    if (resizeFrame.current != null) cancelAnimationFrame(resizeFrame.current);
    readerInputFrame.current = null;
    touchSettleFrame.current = null;
    resizeFrame.current = null;
    readerInput.current = false;
    keyboardHeld.current = false;
    scrollbarDragging.current = false;
    touching.current = false;
    touchMomentum.current = false;
    touchY.current = null;
    touchGeneration.current = 0;
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
      else if (options.enabled !== false && wasEnabled.current) engine.afterMutation(token, { deferCorrection: touching.current && isIOSWebKit() });
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
      const updateViewport = (source: "user" | "programmatic") =>
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
        engine.afterMutation(token, { deferCorrection: touching.current && isIOSWebKit() });
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
      const startTouchSettlement = () => {
        if (touchSettleFrame.current != null) cancelAnimationFrame(touchSettleFrame.current);
        let observedGeneration = touchGeneration.current;
        let quietFrames = 0;
        const observe = () => {
          touchSettleFrame.current = null;
          if (touching.current) return;
          if (touchGeneration.current === observedGeneration) quietFrames++;
          else {
            observedGeneration = touchGeneration.current;
            quietFrames = 0;
          }
          if (quietFrames >= 2) {
            touchMomentum.current = false;
            finishScroll();
            return;
          }
          touchSettleFrame.current = requestAnimationFrame(observe);
        };
        touchSettleFrame.current = requestAnimationFrame(observe);
      };
      const onScroll = () => {
        const before = engine.getSnapshot();
        const domEnd = Math.max(0, container.scrollHeight - container.clientHeight);
        const fromReader = readerInput.current || keyboardHeld.current || touchMomentum.current || scrollbarDragging.current;
        if (readerInput.current) {
          readerInput.current = false;
          if (readerInputFrame.current != null) cancelAnimationFrame(readerInputFrame.current);
          readerInputFrame.current = null;
        }
        if (touchMomentum.current) touchGeneration.current++;
        const pending = pendingScroll.current;
        pendingScroll.current = null; // the first callback consumes our write, whether the browser matched it or not
        const matchesPending = pending !== null && (Math.abs(container.scrollTop - pending.value) < 0.5
          || (typeof pending.target === "number" && Math.abs(container.scrollTop - pending.target) < 0.5));
        // Without reader input, only our exact write or a browser move that remains at the old/new DOM end is layout work.
        // Focus, find, host scrollIntoView, and host scroll writes into content are reader intent.
        const priorDomEnd = pending?.previousEnd ?? lastDomEnd.current;
        const layoutSlack = Math.min(1, Math.abs(domEnd - priorDomEnd));
        const atLayoutEnd = container.scrollTop >= Math.min(priorDomEnd, domEnd) - layoutSlack - 0.5;
        if (!fromReader && (matchesPending || atLayoutEnd)) {
          lastScrollTop.current = container.scrollTop;
          lastDomEnd.current = domEnd;
          if (before.pinned && Math.abs(container.scrollTop - domEnd) >= 0.5) writeScroll("end");
          return;
        }
        lastScrollTop.current = container.scrollTop;
        lastDomEnd.current = domEnd;
        engine.setViewport({ scrollTop: container.scrollTop, size: container.clientHeight, source: "user" });
      };
      const scrollKeys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
      const onWheel = (event: WheelEvent) => {
        armReaderInput();
        if (event.deltaY < 0 && engine.getSnapshot().pinned) engine.setFollow(false);
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (!scrollKeys.has(event.key)) return;
        keyboardHeld.current = true;
        armReaderInput();
        if ((event.key.endsWith("Up") || event.key === "Home") && engine.getSnapshot().pinned) engine.setFollow(false);
      };
      const onPointerDown = (event: PointerEvent) => {
        const bounds = container.getBoundingClientRect();
        const vertical = event.clientX >= bounds.left + container.clientWidth && event.clientX <= bounds.right
          && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
        const horizontal = event.clientY >= bounds.top + container.clientHeight && event.clientY <= bounds.bottom
          && event.clientX >= bounds.left && event.clientX <= bounds.right;
        if (vertical || horizontal) {
          scrollbarDragging.current = true;
          armReaderInput();
        }
      };
      const onTouchStart = (event: TouchEvent) => {
        if (touchSettleFrame.current != null) cancelAnimationFrame(touchSettleFrame.current);
        touchSettleFrame.current = null;
        touching.current = true;
        touchMomentum.current = true;
        armReaderInput();
        touchY.current = event.touches[0]?.clientY ?? null;
      };
      const onTouchMove = (event: TouchEvent) => {
        const next = event.touches[0]?.clientY;
        if (next !== undefined && touchY.current != null && next > touchY.current && engine.getSnapshot().pinned) engine.setFollow(false);
        touchY.current = next ?? null;
      };
      const onTouchEnd = () => {
        touching.current = false;
        touchY.current = null;
        startTouchSettlement();
      };
      const onScrollEnd = () => {
        if (readerInputFrame.current != null) cancelAnimationFrame(readerInputFrame.current);
        if (touchSettleFrame.current != null) cancelAnimationFrame(touchSettleFrame.current);
        readerInputFrame.current = null;
        touchSettleFrame.current = null;
        readerInput.current = false;
        touching.current = false;
        touchMomentum.current = false;
        finishScroll();
      };
      const onDocumentKeyDown = onKeyDown;
      const onDocumentKeyUp = (event: KeyboardEvent) => {
        if (!scrollKeys.has(event.key)) return;
        keyboardHeld.current = false;
        armReaderInput();
      };
      const onDocumentPointerEnd = () => {
        if (!scrollbarDragging.current) return;
        scrollbarDragging.current = false;
        armReaderInput();
      };
      const onFocusIn = (event: FocusEvent) => {
        if (event.target instanceof Node && container.contains(event.target)) armReaderInput();
      };
      container.addEventListener("scroll", onScroll, { passive: true });
      container.addEventListener("scrollend", onScrollEnd, { passive: true });
      container.addEventListener("wheel", onWheel, { passive: true });
      container.addEventListener("keydown", onKeyDown);
      container.addEventListener("pointerdown", onPointerDown, { passive: true });
      container.addEventListener("touchstart", onTouchStart, { passive: true });
      container.addEventListener("touchmove", onTouchMove, { passive: true });
      container.addEventListener("touchend", onTouchEnd, { passive: true });
      container.addEventListener("touchcancel", onTouchEnd, { passive: true });
      document.addEventListener("keydown", onDocumentKeyDown);
      document.addEventListener("keyup", onDocumentKeyUp);
      document.addEventListener("pointerdown", onPointerDown, { passive: true });
      document.addEventListener("pointerup", onDocumentPointerEnd, { passive: true });
      document.addEventListener("pointercancel", onDocumentPointerEnd, { passive: true });
      document.addEventListener("focusin", onFocusIn);
      // A scroll box that changes size (a banner above it, a composer below it) keeps a pinned reader at the bottom.
      const viewportObserver = new ResizeObserver(() => {
        const pinned = engine.getSnapshot().pinned;
        updateViewport("programmatic");
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
        container.removeEventListener("keydown", onKeyDown);
        container.removeEventListener("pointerdown", onPointerDown);
        container.removeEventListener("touchstart", onTouchStart);
        container.removeEventListener("touchmove", onTouchMove);
        container.removeEventListener("touchend", onTouchEnd);
        container.removeEventListener("touchcancel", onTouchEnd);
        document.removeEventListener("keydown", onDocumentKeyDown);
        document.removeEventListener("keyup", onDocumentKeyUp);
        document.removeEventListener("pointerdown", onPointerDown);
        document.removeEventListener("pointerup", onDocumentPointerEnd);
        document.removeEventListener("pointercancel", onDocumentPointerEnd);
        document.removeEventListener("focusin", onFocusIn);
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
    if (keyboardHeld.current || touchMomentum.current || scrollbarDragging.current) return;
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
