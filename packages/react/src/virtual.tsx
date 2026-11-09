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
  type MutationResult,
  type MutationToken,
  type OutlineItem,
  type OutlineUpdate,
  type ScrollSource,
  type VirtualOptions,
  type VirtualCache,
  type VirtualSnapshot,
} from "@fulcrum/virtual";

const isIOSWebKit = () => navigator.userAgent.includes("iP");
const defaultVirtualGutter = 8;
type ScrollTarget = "end" | number;
type OwnedScroll = { requested: ScrollTarget; hostReadBack: number; engineReadBack: number; hostEnd: number };
type ScrollCoordinator = {
  settledHostTop: number;
  settledHostEnd: number;
  owned: OwnedScroll | null;
  target: ScrollTarget | null;
  touching: boolean;
  generation: number;
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
  /** True while a progressive history replacement can still restore a missing anchor. */
  historyPending?: boolean;
};

export type VirtualListState<Id extends string> = {
  snapshot: VirtualSnapshot<Id>;
  debug: string | false;
  unseenCount: number;
  timelineRef: RefCallback<HTMLElement>;
  observeRow(id: Id): RefCallback<HTMLElement>;
  scrollToId(id: Id, viewportOffset?: number): void;
  scrollToEnd(): void;
  /** Re-pins after a host-confirmed local action. */
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
  const initial = useRef(true);
  const wasEnabled = useRef(options.enabled !== false);
  const appliedOutline = useRef<readonly OutlineItem<Id>[] | null>(null);
  const attachment = useRef<HTMLElement | null>(null);
  const releaseCurrent = useRef<(() => void) | null>(null);
  const transferCurrent = useRef<((next: HTMLElement | null) => void) | null>(null);
  const recoveryToken = useRef<MutationToken<Id> | null>(null);
  const coordinator = useRef<ScrollCoordinator>({
    settledHostTop: 0,
    settledHostEnd: 0,
    owned: null,
    target: null,
    touching: false,
    generation: 0,
  });

  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);

  const geometry = useCallback((host: HTMLElement) => {
    const timeline = timelineElement.current;
    const timelineTop = timeline?.getBoundingClientRect().top ?? 0;
    const hostTopInViewport = host.getBoundingClientRect().top;
    const measuredPrefix = timelineTop - hostTopInViewport - host.clientTop + host.scrollTop;
    // happy-dom has no layout and returns zero for both rects; a direct child then has no host prefix.
    const prefix = timeline && timelineTop === 0 && hostTopInViewport === 0 ? 0 : measuredPrefix;
    const cssGutter = timeline ? Number.parseFloat(getComputedStyle(timeline).getPropertyValue("--fulcrum-virtual-gutter")) : NaN;
    const gutter = Number.isFinite(cssGutter) ? cssGutter : defaultVirtualGutter;
    const hostTop = host.scrollTop;
    const hostEnd = Math.max(0, host.scrollHeight - host.clientHeight);
    return { prefix, gutter, hostTop, hostEnd, engineTop: Math.max(0, hostTop - prefix - gutter) };
  }, []);

  const writeScroll = useCallback((target: ScrollTarget) => {
    const host = containerRef.current;
    if (!host) return;
    const before = geometry(host);
    host.scrollTop = target === "end" ? before.hostEnd : before.prefix + before.gutter + target;
    const after = geometry(host);
    coordinator.current.owned = {
      requested: target,
      hostReadBack: after.hostTop,
      engineReadBack: after.engineTop,
      hostEnd: after.hostEnd,
    };
    coordinator.current.settledHostTop = after.hostTop;
    coordinator.current.settledHostEnd = after.hostEnd;
    engine.setViewport({ scrollTop: after.engineTop, size: Math.max(0, host.clientHeight - after.gutter), source: "programmatic" });
  }, [engine, geometry]);

  const retainTarget = useCallback((result: MutationResult, token?: MutationToken<Id>) => {
    if (result.recoveryPending) {
      recoveryToken.current = token ?? recoveryToken.current;
      return;
    }
    recoveryToken.current = null;
    if (result.followedBottom) coordinator.current.target = "end";
    else if (Math.abs(result.jump) >= 0.5) coordinator.current.target = result.scrollTop;
  }, []);

  const applyTarget = useCallback(() => {
    const target = coordinator.current.target;
    if (target === null) return;
    if (coordinator.current.touching && isIOSWebKit() && typeof target === "number") return;
    coordinator.current.target = null;
    writeScroll(target);
  }, [writeScroll]);

  useLayoutEffect(() => {
    if (resetPending) {
      appliedResetKey.current = options.resetKey;
      appliedOutline.current = null;
      initial.current = true;
      wasEnabled.current = options.enabled !== false;
      coordinator.current.generation++;
      coordinator.current.owned = null;
      coordinator.current.target = null;
      recoveryToken.current = null;
      engine.reset();
    }
    if (appliedOutline.current !== outline) {
      appliedOutline.current = outline;
      const token = engine.beforeMutation();
      if (options.invalidateMeasurements) engine.invalidateMeasurements(options.invalidateMeasurements);
      engine.setOutline(outline, options.outlineUpdate);
      engine.setLoaded("all");
      if (initial.current) initial.current = false;
      else if (options.enabled !== false && wasEnabled.current) {
        retainTarget(engine.afterMutation(token, { recoveryComplete: options.historyPending !== true }), token);
      }
    } else if (recoveryToken.current && options.historyPending !== true) {
      retainTarget(engine.afterMutation(recoveryToken.current, { recoveryComplete: true }));
    }
    wasEnabled.current = options.enabled !== false;
  }, [engine, outline, options.enabled, options.historyPending, options.invalidateMeasurements, options.outlineUpdate, options.resetKey, resetPending, retainTarget]);

  useLayoutEffect(() => {
    const transfer = (next: HTMLElement | null) => {
      if (attachment.current === next) return;
      if (attachment.current) {
        releaseCurrent.current?.();
        attachment.current = null;
        releaseCurrent.current = null;
        containerRef.current = null;
      }
      if (!next) return;
      const host = next;
      containerRef.current = host;
      const generation = ++coordinator.current.generation;
      coordinator.current.owned = null;
      coordinator.current.target = null;
      const priorOverflowAnchor = host.style.overflowAnchor;
      host.style.overflowAnchor = "none";

      const report = (source: ScrollSource) => {
        if (generation !== coordinator.current.generation) return;
        const current = geometry(host);
        engine.setViewport({ scrollTop: current.engineTop, size: Math.max(0, host.clientHeight - current.gutter), source });
        coordinator.current.settledHostTop = current.hostTop;
        coordinator.current.settledHostEnd = current.hostEnd;
      };
      const settle = () => {
        const current = geometry(host);
        const owned = coordinator.current.owned;
        if (owned && Math.abs(current.hostTop - owned.hostReadBack) <= 1) {
          coordinator.current.owned = null;
          report("observe");
          return;
        }
        coordinator.current.owned = null;
        coordinator.current.target = null;
        report("user");
      };

      if (engine.getSnapshot().pinned) writeScroll("end");
      else report("user");

      const rowObserver = new ResizeObserver((entries) => {
        if (generation !== coordinator.current.generation || entries.length === 0) return;
        const token = engine.beforeMutation();
        for (const entry of entries) {
          const id = rowIds.current.get(entry.target);
          if (id !== undefined) engine.measure(id, entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height);
        }
        retainTarget(engine.afterMutation(token));
      });
      observerRef.current = rowObserver;
      for (const row of rows.current.values()) rowObserver.observe(row);

      const viewportObserver = new ResizeObserver(() => {
        if (generation !== coordinator.current.generation) return;
        const token = engine.beforeMutation();
        report("observe");
        retainTarget(engine.afterMutation(token));
        applyTarget();
      });
      viewportObserver.observe(host);

      const siblingObserver = new ResizeObserver(() => {
        if (generation !== coordinator.current.generation) return;
        const beforePinned = engine.getSnapshot().pinned;
        const current = geometry(host);
        if (beforePinned && current.hostEnd > coordinator.current.settledHostEnd + 0.5) writeScroll("end");
        else settle();
      });
      const observeSiblings = () => {
        siblingObserver.disconnect();
        for (const child of host.children) if (child !== timelineElement.current) siblingObserver.observe(child);
      };
      observeSiblings();
      const siblingMutations = new MutationObserver(observeSiblings);
      siblingMutations.observe(host, { childList: true });

      const onScroll = () => settle();
      const onTouchStart = () => { coordinator.current.touching = true; };
      const onTouchEnd = () => {
        coordinator.current.touching = false;
        applyTarget();
      };
      host.addEventListener("scroll", onScroll, { passive: true });
      host.addEventListener("touchstart", onTouchStart, { passive: true });
      host.addEventListener("touchend", onTouchEnd, { passive: true });
      host.addEventListener("touchcancel", onTouchEnd, { passive: true });

      const release = () => {
        coordinator.current.generation++;
        coordinator.current.owned = null;
        coordinator.current.target = null;
        coordinator.current.touching = false;
        rowObserver.disconnect();
        viewportObserver.disconnect();
        siblingObserver.disconnect();
        siblingMutations.disconnect();
        observerRef.current = null;
        host.removeEventListener("scroll", onScroll);
        host.removeEventListener("touchstart", onTouchStart);
        host.removeEventListener("touchend", onTouchEnd);
        host.removeEventListener("touchcancel", onTouchEnd);
        host.style.overflowAnchor = priorOverflowAnchor;
        engine.flushPendingCorrection(false, true);
      };
      attachment.current = host;
      releaseCurrent.current = release;
    };
    transferCurrent.current = transfer;
    transfer(options.enabled === false || typeof ResizeObserver === "undefined"
      ? null
      : options.scrollRef?.current ?? timelineElement.current?.parentElement ?? null);
  });

  useLayoutEffect(() => () => {
    transferCurrent.current?.(null);
    transferCurrent.current = null;
    containerRef.current = null;
  }, []);

  useLayoutEffect(() => applyTarget(), [applyTarget, snapshot]);
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
    if (!containerRef.current) return;
    writeScroll(engine.scrollToId(id, viewportOffset));
  }, [engine, writeScroll]);

  const scrollToEnd = useCallback(() => {
    if (!containerRef.current) return;
    engine.scrollToEnd();
    writeScroll("end");
  }, [engine, writeScroll]);

  const requestFollow = useCallback(() => {
    if (!containerRef.current) return;
    const next = engine.requestFollow();
    if (next !== null) writeScroll("end");
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
