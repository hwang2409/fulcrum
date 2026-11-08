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

const settleDetachedViewport = <Id extends string>(
  engine: Virtualizer<Id>,
  touching: RefObject<boolean>,
  touchY: RefObject<number | null>,
  readerInput: RefObject<boolean>,
  gestureActive: RefObject<boolean>,
  scrollbarDragging: RefObject<boolean>,
): void => {
  touching.current = false;
  touchY.current = null;
  readerInput.current = false;
  gestureActive.current = false;
  scrollbarDragging.current = false;
  engine.flushPendingCorrection(false, true);
};

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
  const gestureActive = useRef(false);
  const scrollbarDragging = useRef(false);
  const touchY = useRef<number | null>(null);
  const lastScrollTop = useRef(0);
  const lastDomEnd = useRef(0);
  const pendingScroll = useRef<{ target: "end" | number; value: number } | null>(null);
  const scrollEndTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    pendingScroll.current = { target, value };
    container.scrollTop = value;
    lastScrollTop.current = container.scrollTop;
    lastDomEnd.current = domEnd;
  }, [engine]);

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
        touching.current = false;
        const result = engine.flushPendingCorrection();
        if (Math.abs(result.jump) >= 0.5) writeScroll(result.scrollTop);
      };
      const onScroll = () => {
        const before = engine.getSnapshot();
        const domEnd = Math.max(0, container.scrollHeight - container.clientHeight);
        const fromReader = readerInput.current || gestureActive.current || touching.current || scrollbarDragging.current;
        const pending = pendingScroll.current;
        // The writer owns its pending target. Without one, only a browser move that remains at the old or new DOM end
        // is layout work; focus, find, host scrollIntoView, and document-level input move into content and are reader intent.
        const layoutSlack = Math.min(1, Math.abs(domEnd - lastDomEnd.current));
        const atLayoutEnd = container.scrollTop >= Math.min(lastDomEnd.current, domEnd) - layoutSlack - 0.5;
        if (!fromReader && (pending !== null || atLayoutEnd)) {
          lastScrollTop.current = container.scrollTop;
          lastDomEnd.current = domEnd;
          if (pending) {
            const target = pending.target === "end" ? domEnd : pending.value;
            if (Math.abs(container.scrollTop - target) < 0.5) pendingScroll.current = null;
            else writeScroll(pending.target);
          } else if (before.pinned && Math.abs(container.scrollTop - domEnd) >= 0.5) writeScroll("end");
          return;
        }
        readerInput.current = false;
        pendingScroll.current = null;
        lastScrollTop.current = container.scrollTop;
        lastDomEnd.current = domEnd;
        engine.setViewport({ scrollTop: container.scrollTop, size: container.clientHeight, source: "user" });
        if (scrollEndTimer.current != null) clearTimeout(scrollEndTimer.current);
        scrollEndTimer.current = setTimeout(finishScroll, 150);
      };
      const scrollKeys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
      const onWheel = (event: WheelEvent) => {
        readerInput.current = true;
        gestureActive.current = true;
        if (event.deltaY < 0 && engine.getSnapshot().pinned) engine.setFollow(false);
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (!scrollKeys.has(event.key)) return;
        readerInput.current = true;
        gestureActive.current = true;
        if ((event.key.endsWith("Up") || event.key === "Home") && engine.getSnapshot().pinned) engine.setFollow(false);
      };
      const onPointerDown = (event: PointerEvent) => {
        const bounds = container.getBoundingClientRect();
        const vertical = event.clientX >= bounds.left + container.clientWidth && event.clientX <= bounds.right
          && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
        const horizontal = event.clientY >= bounds.top + container.clientHeight && event.clientY <= bounds.bottom
          && event.clientX >= bounds.left && event.clientX <= bounds.right;
        if (vertical || horizontal) {
          readerInput.current = true;
          scrollbarDragging.current = true;
        }
      };
      const onTouchStart = (event: TouchEvent) => {
        readerInput.current = true;
        gestureActive.current = true;
        touching.current = true;
        touchY.current = event.touches[0]?.clientY ?? null;
      };
      const onTouchMove = (event: TouchEvent) => {
        const next = event.touches[0]?.clientY;
        if (next !== undefined && touchY.current != null && next > touchY.current && engine.getSnapshot().pinned) engine.setFollow(false);
        touchY.current = next ?? null;
      };
      const onTouchEnd = () => {
        touchY.current = null;
        if (scrollEndTimer.current != null) clearTimeout(scrollEndTimer.current);
        scrollEndTimer.current = setTimeout(finishScroll, 150);
      };
      const onScrollEnd = () => {
        readerInput.current = false;
        gestureActive.current = false;
        scrollbarDragging.current = false;
        finishScroll();
      };
      const onDocumentKeyDown = (event: KeyboardEvent) => {
        if (!scrollKeys.has(event.key)) return;
        readerInput.current = true;
        gestureActive.current = true;
      };
      const onDocumentKeyUp = (event: KeyboardEvent) => {
        if (scrollKeys.has(event.key)) gestureActive.current = false;
      };
      const onDocumentPointerEnd = () => { scrollbarDragging.current = false; };
      const onFocusIn = (event: FocusEvent) => {
        if (event.target instanceof Node && container.contains(event.target)) readerInput.current = true;
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
        if (resizeFrame.current != null) cancelAnimationFrame(resizeFrame.current);
        if (scrollEndTimer.current != null) clearTimeout(scrollEndTimer.current);
        resizeFrame.current = null;
        scrollEndTimer.current = null;
        settleDetachedViewport(engine, touching, touchY, readerInput, gestureActive, scrollbarDragging);
        pendingEntries.current.clear();
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
    if (touching.current || readerInput.current || gestureActive.current || scrollbarDragging.current) return;
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
