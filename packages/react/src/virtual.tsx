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
  userScrollUntil: RefObject<number>,
  ignoreScrollUntil: RefObject<number>,
): void => {
  touching.current = false;
  touchY.current = null;
  userScrollUntil.current = 0;
  ignoreScrollUntil.current = 0;
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
  const userScrollUntil = useRef(0);
  const touchY = useRef<number | null>(null);
  const lastScrollTop = useRef(0);
  const scrollEndTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ignoreScrollUntil = useRef(0);
  const initial = useRef(true);
  const wasEnabled = useRef(options.enabled !== false);
  const appliedOutline = useRef<readonly OutlineItem<Id>[] | null>(null);
  const attachment = useRef<{ host: HTMLElement | null; settled: boolean }>({ host: null, settled: false });
  const releaseCurrent = useRef<(() => void) | null>(null);
  const transferCurrent = useRef<((next: HTMLElement | null) => void) | null>(null);
  const scrollToBottomRef = useRef<((syncViewport?: boolean) => void) | null>(null);

  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);

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
      const scrollToBottom = (syncViewport = true) => {
        if (scrollEndTimer.current != null) clearTimeout(scrollEndTimer.current);
        scrollEndTimer.current = null;
        container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        lastScrollTop.current = container.scrollTop;
        if (syncViewport) updateViewport("programmatic");
      };
      scrollToBottomRef.current = scrollToBottom;
      if (prior) {
        const intent = engine.beforeMutation();
        updateViewport("programmatic");
        engine.afterMutation(intent);
      } else updateViewport("user");
      lastScrollTop.current = container.scrollTop;

      const flushMeasurements = () => {
        resizeFrame.current = null;
        if (pendingEntries.current.size === 0) return;
        // Capture ownership before the engine notifies React: its correction can commit synchronously and move the DOM.
        // Re-apply the bottom only while the DOM still has the adapter's last position; real input moves it first.
        const ownsBottom = engine.getSnapshot().pinned && Math.abs(container.scrollTop - lastScrollTop.current) < 0.5;
        const token = engine.beforeMutation();
        for (const [id, size] of pendingEntries.current) engine.measure(id, size);
        pendingEntries.current.clear();
        engine.afterMutation(token, { deferCorrection: touching.current && isIOSWebKit() });
        // A late layout pass can leave WebKit a few pixels behind the new end after the measurement correction.
        // Re-apply the existing follow intent only when the DOM had not moved independently before that correction.
        if (ownsBottom && engine.getSnapshot().pinned) scrollToBottom();
      };
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const id = rowIds.current.get(entry.target);
          if (id !== undefined) pendingEntries.current.set(id, entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height);
        }
        if (resizeFrame.current === null) resizeFrame.current = requestAnimationFrame(flushMeasurements);
        // Rows are in flow, so the DOM already has the new end: a pinned reader sticks to it before this frame paints,
        // not a frame later when the engine measures (and then agrees). Moving scroll resizes nothing: no observer loop.
        // The user beats the engine: pointer, wheel, key, and touch input own their scroll frame, while a delayed
        // browser event from content growth does not change follow intent.
        const { pinned, scrollTop } = engine.getSnapshot();
        if (pinned && Math.abs(container.scrollTop - scrollTop) < 1) scrollToBottom(false);
      });
      observerRef.current = observer;
      for (const row of rows.current.values()) observer.observe(row);

      const finishScroll = () => {
        touching.current = false;
        const result = engine.flushPendingCorrection();
        if (Math.abs(result.jump) >= 0.5) {
          if (engine.getSnapshot().pinned) scrollToBottom(false);
          else container.scrollTop = result.scrollTop;
        }
      };
      const onScroll = () => {
        const before = engine.getSnapshot();
        if (performance.now() < ignoreScrollUntil.current) {
          if (before.pinned) scrollToBottom(false);
          else container.scrollTop = before.scrollTop;
          return;
        }
        const correction = before.programmatic && Math.abs(container.scrollTop - before.scrollTop) < 0.5;
        // A shorter outline or a taller box (a reconnect banner leaving) makes the browser clamp a pinned reader's scroll
        // to the new end, often before the box's ResizeObserver runs. Landing on the end is following, not the reader's
        // move up, so the engine keeps its follow intent.
        const clampedToEnd = before.pinned && container.scrollTop >= container.scrollHeight - container.clientHeight - 0.5;
        const userDriven = touching.current || performance.now() < userScrollUntil.current;
        if (!correction && !clampedToEnd && userDriven && container.scrollTop < lastScrollTop.current) engine.setFollow(false);
        lastScrollTop.current = container.scrollTop;
        const source = clampedToEnd || (before.pinned && !userDriven) ? "programmatic" : "user";
        engine.setViewport({ scrollTop: container.scrollTop, size: container.clientHeight, source });
        if (correction || clampedToEnd) return;
        if (scrollEndTimer.current != null) clearTimeout(scrollEndTimer.current);
        scrollEndTimer.current = setTimeout(finishScroll, 150);
      };
      // The stale-scroll guard after a programmatic bottom write only covers scroll events
      // nobody asked for; any real input means the next scroll is the user's and must win.
      const userIntent = () => { ignoreScrollUntil.current = 0; };
      const onWheel = (event: WheelEvent) => {
        userIntent();
        userScrollUntil.current = performance.now() + 200;
        if (event.deltaY < 0) engine.setFollow(false);
      };
      const onKeyDown = (event: KeyboardEvent) => {
        userIntent();
        if (["ArrowUp", "PageUp", "Home", "ArrowDown", "PageDown", "End", " "].includes(event.key))
          userScrollUntil.current = performance.now() + 200;
        if (event.key.endsWith("Up") || event.key === "Home") engine.setFollow(false);
      };
      const onPointerDown = (event: PointerEvent) => {
        userIntent();
        if (event.target === container) touching.current = true;
      };
      const onPointerEnd = () => finishScroll();
      const onTouchStart = (event: TouchEvent) => {
        userIntent();
        touching.current = true;
        touchY.current = event.touches[0]?.clientY ?? null;
      };
      const onTouchMove = (event: TouchEvent) => {
        const next = event.touches[0]?.clientY;
        if (next !== undefined && touchY.current != null && next > touchY.current) engine.setFollow(false);
        touchY.current = next ?? null;
      };
      const onTouchEnd = () => {
        touchY.current = null;
        if (scrollEndTimer.current != null) clearTimeout(scrollEndTimer.current);
        scrollEndTimer.current = setTimeout(finishScroll, 150);
      };
      container.addEventListener("scroll", onScroll, { passive: true });
      container.addEventListener("wheel", onWheel, { passive: true });
      container.addEventListener("keydown", onKeyDown);
      container.addEventListener("pointerdown", onPointerDown, { passive: true });
      container.addEventListener("pointerup", onPointerEnd, { passive: true });
      container.addEventListener("pointercancel", onPointerEnd, { passive: true });
      container.addEventListener("touchstart", onTouchStart, { passive: true });
      container.addEventListener("touchmove", onTouchMove, { passive: true });
      container.addEventListener("touchend", onTouchEnd, { passive: true });
      container.addEventListener("touchcancel", onTouchEnd, { passive: true });
      // A scroll box that changes size (a banner above it, a composer below it) keeps a pinned reader at the bottom.
      const viewportObserver = new ResizeObserver(() => {
        const pinned = engine.getSnapshot().pinned;
        updateViewport("programmatic");
        if (!pinned) return;
        scrollToBottom();
        ignoreScrollUntil.current = performance.now() + 50;
      });
      viewportObserver.observe(container);
      const release = () => {
        observer.disconnect();
        viewportObserver.disconnect();
        observerRef.current = null;
        container.removeEventListener("scroll", onScroll);
        container.removeEventListener("wheel", onWheel);
        container.removeEventListener("keydown", onKeyDown);
        container.removeEventListener("pointerdown", onPointerDown);
        container.removeEventListener("pointerup", onPointerEnd);
        container.removeEventListener("pointercancel", onPointerEnd);
        container.removeEventListener("touchstart", onTouchStart);
        container.removeEventListener("touchmove", onTouchMove);
        container.removeEventListener("touchend", onTouchEnd);
        container.removeEventListener("touchcancel", onTouchEnd);
        if (resizeFrame.current != null) cancelAnimationFrame(resizeFrame.current);
        if (scrollEndTimer.current != null) clearTimeout(scrollEndTimer.current);
        resizeFrame.current = null;
        scrollEndTimer.current = null;
        settleDetachedViewport(engine, touching, touchY, userScrollUntil, ignoreScrollUntil);
        pendingEntries.current.clear();
        if (scrollToBottomRef.current === scrollToBottom) scrollToBottomRef.current = null;
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
    const domEnd = Math.max(0, container.scrollHeight - container.clientHeight);
    if (snapshot.pinned && snapshot.programmatic && Math.abs(container.scrollTop - domEnd) >= 0.5) {
      scrollToBottomRef.current?.(false);
      return;
    }
    if (Math.abs(snapshot.jump) >= 0.5 && Math.abs(container.scrollTop - snapshot.scrollTop) >= 0.5)
      container.scrollTop = snapshot.scrollTop;
  }, [snapshot]);

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
    container.scrollTop = engine.scrollToId(id, viewportOffset);
  }, [engine]);

  const scrollToEnd = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    touching.current = false;
    userScrollUntil.current = 0;
    const next = engine.scrollToEnd();
    const applyBottom = scrollToBottomRef.current;
    if (applyBottom && container.scrollHeight > container.clientHeight) applyBottom();
    else container.scrollTop = next;
    ignoreScrollUntil.current = performance.now() + 50;
  }, [engine]);
  const requestFollow = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    touching.current = false;
    userScrollUntil.current = 0;
    const next = engine.requestFollow();
    if (next === null) return;
    const applyBottom = scrollToBottomRef.current;
    if (applyBottom && container.scrollHeight > container.clientHeight) applyBottom();
    else container.scrollTop = next;
    ignoreScrollUntil.current = performance.now() + 50;
  }, [engine]);

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
