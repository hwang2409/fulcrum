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
  type OutlineItem,
  type VirtualAction,
  type VirtualOptions,
  type VirtualSnapshot,
} from "@fulcrum/virtual";

export type VirtualListOptions<Id extends string> = VirtualOptions<Id> & {
  scrollRef?: RefObject<HTMLElement | null>;
  enabled?: boolean;
};

export type VirtualListState<Id extends string> = {
  snapshot: VirtualSnapshot<Id>;
  actions: readonly VirtualAction[];
  unseenCount: number;
  timelineRef: RefCallback<HTMLElement>;
  observeRow(id: Id): RefCallback<HTMLElement>;
  scrollToId(id: Id, viewportOffset?: number): void;
  scrollToEnd(): void;
};

/** React DOM adapter for the framework-neutral virtual engine. Options are fixed for the hook lifetime. */
export function useVirtualList<Id extends string>(
  outline: readonly OutlineItem<Id>[],
  options: VirtualListOptions<Id>,
): VirtualListState<Id> {
  const engineRef = useRef<ReturnType<typeof createVirtualizer<Id>>>(undefined);
  if (!engineRef.current) engineRef.current = createVirtualizer(options);
  const engine = engineRef.current;
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("virtualDebug") === "1")
    (window as typeof window & { __fulcrumVirtual?: typeof engine }).__fulcrumVirtual = engine;
  const containerRef = useRef<HTMLElement | null>(null);
  const timelineElement = useRef<HTMLElement | null>(null);
  const rows = useRef(new Map<Id, HTMLElement>());
  const rowCallbacks = useRef(new Map<Id, RefCallback<HTMLElement>>());
  const rowIds = useRef(new WeakMap<Element, Id>());
  const observerRef = useRef<ResizeObserver | null>(null);
  const resizeFrame = useRef<number | null>(null);
  const pendingEntries = useRef(new Map<Id, number>());
  const touching = useRef(false);
  const scrollEndTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initial = useRef(true);
  const wasEnabled = useRef(options.enabled !== false);
  const unseenBase = useRef(outline.length);
  const outlineLength = useRef(outline.length);
  outlineLength.current = outline.length;

  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);

  useLayoutEffect(() => {
    const token = engine.beforeMutation();
    engine.setOutline(outline);
    engine.setLoaded(outline.map(({ id }) => id));
    if (initial.current) initial.current = false;
    else if (options.enabled !== false && wasEnabled.current) engine.afterMutation(token, { deferCorrection: touching.current });
    if (snapshot.pinned) unseenBase.current = outline.length;
    wasEnabled.current = options.enabled !== false;
  }, [engine, outline, options.enabled]);

  useLayoutEffect(() => {
    if (options.enabled === false || typeof ResizeObserver === "undefined") return;
    const container = options.scrollRef?.current ?? timelineElement.current?.parentElement ?? null;
    if (!container) return;
    containerRef.current = container;
    const priorOverflowAnchor = container.style.overflowAnchor;
    container.style.overflowAnchor = "none";
    const updateViewport = (source: "user" | "programmatic") =>
      engine.setViewport({ scrollTop: container.scrollTop, size: container.clientHeight, source });
    updateViewport("user");

    const flushMeasurements = () => {
      resizeFrame.current = null;
      if (pendingEntries.current.size === 0) return;
      const token = engine.beforeMutation();
      for (const [id, size] of pendingEntries.current) engine.measure(id, size);
      pendingEntries.current.clear();
      engine.afterMutation(token, { deferCorrection: touching.current });
    };
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const id = rowIds.current.get(entry.target);
        if (id !== undefined) pendingEntries.current.set(id, entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height);
      }
      if (resizeFrame.current === null) resizeFrame.current = requestAnimationFrame(flushMeasurements);
    });
    observerRef.current = observer;
    for (const row of rows.current.values()) observer.observe(row);

    const finishScroll = () => {
      touching.current = false;
      const result = engine.flushPendingCorrection();
      if (Math.abs(result.jump) >= 0.5) container.scrollTop = result.scrollTop;
    };
    const onScroll = () => {
      const wasPinned = engine.getSnapshot().pinned;
      engine.setViewport({ scrollTop: container.scrollTop, size: container.clientHeight, source: "user" });
      const next = engine.getSnapshot();
      if (wasPinned && !next.pinned) unseenBase.current = outlineLength.current;
      if (next.pinned) unseenBase.current = outlineLength.current;
      if (next.programmatic) return;
      if (scrollEndTimer.current !== null) clearTimeout(scrollEndTimer.current);
      scrollEndTimer.current = setTimeout(finishScroll, 150);
    };
    const onTouchStart = () => { touching.current = true; };
    const onTouchEnd = () => {
      if (scrollEndTimer.current !== null) clearTimeout(scrollEndTimer.current);
      scrollEndTimer.current = setTimeout(finishScroll, 150);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchend", onTouchEnd, { passive: true });
    container.addEventListener("touchcancel", onTouchEnd, { passive: true });
    const viewportObserver = new ResizeObserver(() => updateViewport("programmatic"));
    viewportObserver.observe(container);
    return () => {
      observer.disconnect();
      viewportObserver.disconnect();
      observerRef.current = null;
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchEnd);
      if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current);
      if (scrollEndTimer.current !== null) clearTimeout(scrollEndTimer.current);
      container.style.overflowAnchor = priorOverflowAnchor;
    };
  }, [engine, options.scrollRef, options.enabled]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container && Math.abs(snapshot.jump) >= 0.5 && Math.abs(container.scrollTop - snapshot.scrollTop) >= 0.5)
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
      } else rows.current.delete(id);
    };
    rowCallbacks.current.set(id, callback);
    return callback;
  }, []);

  const scrollToId = useCallback((id: Id, viewportOffset = 0) => {
    const container = containerRef.current;
    if (!container) return;
    const top = Math.max(0, engine.scrollToId(id) - viewportOffset);
    engine.setViewport({ scrollTop: top, size: container.clientHeight, source: "programmatic" });
    // The first event consumes the engine target; the second records this explicit navigation intent.
    engine.setViewport({ scrollTop: top, size: container.clientHeight, source: "user" });
    engine.setViewport({ scrollTop: top, size: container.clientHeight, source: "user" });
    container.scrollTop = top;
  }, [engine]);

  const scrollToEnd = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const top = Math.max(0, engine.getSnapshot().totalSize - container.clientHeight);
    engine.setViewport({ scrollTop: top, size: container.clientHeight, source: "programmatic" });
    // Jumping to the end is user intent, so future appends must stay pinned.
    engine.setViewport({ scrollTop: top, size: container.clientHeight, source: "user" });
    engine.setViewport({ scrollTop: top, size: container.clientHeight, source: "user" });
    container.scrollTop = top;
    unseenBase.current = outline.length;
  }, [engine, outline.length]);

  return {
    snapshot,
    actions: engine.getActions(),
    unseenCount: snapshot.pinned ? 0 : Math.max(0, outline.length - unseenBase.current),
    timelineRef,
    observeRow,
    scrollToId,
    scrollToEnd,
  };
}
