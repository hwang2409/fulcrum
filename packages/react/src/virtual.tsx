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
type HostGeometry = { clientHeight: number; rectTop: number; rectBottom: number };
type OwnedScroll = { requested: ScrollTarget; hostReadBack: number; engineReadBack: number; hostEnd: number; geometry: HostGeometry };
type ScrollCoordinator = {
  settledHostTop: number;
  settledHostEnd: number;
  geometry: HostGeometry | null;
  owned: OwnedScroll | null;
  target: ScrollTarget | null;
  recoveryPending: boolean;
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
  if (debug) (window as typeof window & { __fulcrumVirtual?: unknown }).__fulcrumVirtual = {
    getSnapshot: engine.getSnapshot,
    getActions: engine.getActions,
    scrollToEngineEnd: engine.scrollToEnd,
  };
  const containerRef = useRef<HTMLElement | null>(null);
  const timelineElement = useRef<HTMLElement | null>(null);
  const rows = useRef(new Map<Id, HTMLElement>());
  const rowCallbacks = useRef(new Map<Id, RefCallback<HTMLElement>>());
  const rowIds = useRef(new WeakMap<Element, Id>());
  const observerRef = useRef<ResizeObserver | null>(null);
  const historyPending = useRef(options.historyPending === true);
  historyPending.current = options.historyPending === true;
  const initial = useRef(true);
  const appliedOutline = useRef<readonly OutlineItem<Id>[] | null>(null);
  const attachment = useRef<HTMLElement | null>(null);
  const releaseCurrent = useRef<(() => void) | null>(null);
  const transferCurrent = useRef<((next: HTMLElement | null) => void) | null>(null);
  const coordinator = useRef<ScrollCoordinator>({
    settledHostTop: 0,
    settledHostEnd: 0,
    geometry: null,
    owned: null,
    target: null,
    recoveryPending: false,
    touching: false,
    generation: 0,
  });

  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);

  const geometry = useCallback((host: HTMLElement) => {
    const timeline = timelineElement.current;
    const timelineTop = timeline?.getBoundingClientRect().top ?? 0;
    const hostRect = host.getBoundingClientRect();
    const hostTopInViewport = hostRect.top;
    const measuredPrefix = timelineTop - hostTopInViewport - host.clientTop + host.scrollTop;
    // happy-dom has no layout and returns zero for both rects; a direct child then has no host prefix.
    const prefix = timeline && timelineTop === 0 && hostTopInViewport === 0 ? 0 : measuredPrefix;
    const gutter = defaultVirtualGutter;
    const hostTop = host.scrollTop;
    const measuredEnd = Math.max(0, host.scrollHeight - host.clientHeight);
    const noLayoutEnd = timeline ? prefix + engine.getSnapshot().totalSize + 2 * defaultVirtualGutter - host.clientHeight : 0;
    const hostEnd = measuredEnd === 0 && noLayoutEnd > 0 ? noLayoutEnd : measuredEnd;
    return {
      prefix,
      gutter,
      hostTop,
      hostEnd,
      engineTop: Math.max(0, hostTop - prefix - gutter),
      hostGeometry: { clientHeight: host.clientHeight, rectTop: hostRect.top, rectBottom: hostRect.bottom },
    };
  }, []);

  const writeScroll = useCallback((target: ScrollTarget, syncEngine = true) => {
    const host = containerRef.current;
    if (!host) return;
    const before = geometry(host);
    const logicalEnd = before.prefix + engine.getSnapshot().totalSize + 2 * defaultVirtualGutter - host.clientHeight;
    const desiredHostTop = target === "end"
      ? Math.max(before.hostEnd, logicalEnd)
      : before.prefix + before.gutter + target;
    host.scrollTop = desiredHostTop;
    const after = geometry(host);
    if (Math.abs(after.hostTop - desiredHostTop) > 1) coordinator.current.target = target;
    coordinator.current.owned = {
      requested: target,
      hostReadBack: after.hostTop,
      engineReadBack: after.engineTop,
      hostEnd: after.hostEnd,
      geometry: after.hostGeometry,
    };
    coordinator.current.settledHostTop = after.hostTop;
    coordinator.current.settledHostEnd = after.hostEnd;
    coordinator.current.geometry = after.hostGeometry;
    const size = Math.max(0, host.clientHeight - after.gutter);
    const snapshot = engine.getSnapshot();
    if (syncEngine && (Math.abs(snapshot.scrollTop - after.engineTop) >= 0.5 || snapshot.viewportSize !== size)) {
      engine.setViewport({ scrollTop: after.engineTop, size, source: "programmatic" });
    }
  }, [engine, geometry]);

  const retainTarget = useCallback((result: MutationResult) => {
    coordinator.current.recoveryPending = result.recoveryPending === true;
    if (result.recoveryPending) return;
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
      releaseCurrent.current?.();
      attachment.current = null;
      releaseCurrent.current = null;
      containerRef.current = null;
      coordinator.current.owned = null;
      coordinator.current.target = null;
      coordinator.current.recoveryPending = false;
      engine.reset();
    }
    if (appliedOutline.current !== outline) {
      appliedOutline.current = outline;
      const token = engine.beforeMutation();
      if (options.invalidateMeasurements) engine.invalidateMeasurements(options.invalidateMeasurements);
      engine.setOutline(outline, options.outlineUpdate);
      engine.setLoaded("all");
      if (initial.current) {
        initial.current = false;
        if (options.enabled !== false && engine.getSnapshot().pinned) coordinator.current.target = "end";
      } else {
        const result = engine.afterMutation(token, { recoveryComplete: options.historyPending !== true });
        if (options.enabled !== false) retainTarget(result);
      }
    } else if (options.historyPending !== true) {
      const result = engine.completeRecovery();
      if (result && options.enabled !== false) retainTarget(result);
    }
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
      coordinator.current.recoveryPending = false;
      const priorOverflowAnchor = host.style.overflowAnchor;
      host.style.overflowAnchor = "none";

      type Geometry = ReturnType<typeof geometry>;
      const report = (source: ScrollSource, current = geometry(host)) => {
        if (generation !== coordinator.current.generation) return;
        engine.setViewport({ scrollTop: current.engineTop, size: Math.max(0, current.hostGeometry.clientHeight - current.gutter), source });
        if (source === "user" && Math.abs(current.hostTop - current.hostEnd) <= engine.bottomThreshold && !engine.getSnapshot().pinned) {
          engine.requestFollow();
        }
        coordinator.current.geometry = current.hostGeometry;
        if (source !== "observe") {
          coordinator.current.settledHostTop = current.hostTop;
          coordinator.current.settledHostEnd = current.hostEnd;
        }
      };
      const settle = () => {
        const current = geometry(host);
        const owned = coordinator.current.owned;
        const priorGeometry = owned?.geometry ?? coordinator.current.geometry;
        const geometryChanged = priorGeometry !== null && (
          Math.abs(current.hostGeometry.clientHeight - priorGeometry.clientHeight) >= 0.5
          || Math.abs(current.hostGeometry.rectTop - priorGeometry.rectTop) >= 0.5
          || Math.abs(current.hostGeometry.rectBottom - priorGeometry.rectBottom) >= 0.5
        );
        coordinator.current.geometry = current.hostGeometry;
        if (geometryChanged) {
          const wasPinned = engine.getSnapshot().pinned;
          const recoveryTarget = Math.max(0, Math.min(coordinator.current.settledHostTop, current.hostEnd));
          const bottomShift = current.hostGeometry.rectBottom - priorGeometry.rectBottom;
          const expectedHostTop = coordinator.current.recoveryPending
            ? Math.max(0, Math.min(recoveryTarget - bottomShift, current.hostEnd))
            : owned
              ? Math.max(0, Math.min(owned.hostReadBack - bottomShift, current.hostEnd))
              : current.hostTop;
          const layout: Geometry = {
            ...current,
            hostTop: expectedHostTop,
            engineTop: Math.max(0, expectedHostTop - current.prefix - current.gutter),
          };
          const readerMoved = (!coordinator.current.recoveryPending && owned === null)
            || Math.abs(current.hostTop - expectedHostTop) > engine.bottomThreshold;
          viewportTransaction(false, layout);
          if (readerMoved) {
            coordinator.current.target = null;
            report("user", current);
          } else if (coordinator.current.recoveryPending) {
            writeScroll(recoveryTarget);
          } else if (wasPinned) {
            writeScroll("end");
          }
          return;
        }
        const ownedEnd = owned?.requested === "end"
          ? Math.abs(current.hostTop - owned.hostReadBack) <= 1 && Math.abs(current.hostEnd - owned.hostEnd) <= 1
          : owned !== null && Math.abs(current.engineTop - owned.engineReadBack) <= 1;
        if (ownedEnd) {
          report("observe", current);
          return;
        }
        if (coordinator.current.recoveryPending) {
          const transientClamp = Math.max(0, Math.min(coordinator.current.settledHostTop, current.hostEnd));
          if (Math.abs(current.hostTop - transientClamp) <= 1) {
            report("observe", current);
            return;
          }
          coordinator.current.recoveryPending = false;
        }
        coordinator.current.owned = null;
        coordinator.current.target = null;
        report("user", current);
      };

      const attachedSnapshot = engine.getSnapshot();
      writeScroll(attachedSnapshot.pinned ? "end" : attachedSnapshot.scrollTop);

      const rowObserver = new ResizeObserver((entries) => {
        if (generation !== coordinator.current.generation || entries.length === 0) return;
        const current = geometry(host);
        const owned = coordinator.current.owned;
        if (owned && Math.abs(current.hostTop - owned.hostReadBack) > engine.bottomThreshold) {
          coordinator.current.owned = null;
          coordinator.current.target = null;
          report("user");
        }
        const measurements = entries.flatMap((entry) => {
          const id = rowIds.current.get(entry.target);
          return id !== undefined && rows.current.get(id) === entry.target
            ? [[id, entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height] as const]
            : [];
        });
        if (measurements.length === 0) return;
        const token = engine.beforeMutation();
        for (const [id, size] of measurements) engine.measure(id, size);
        retainTarget(engine.afterMutation(token, { recoveryComplete: !historyPending.current }));
        applyTarget();
      });
      observerRef.current = rowObserver;
      for (const row of rows.current.values()) rowObserver.observe(row);

      const viewportTransaction = (apply = true, current?: Geometry) => {
        if (generation !== coordinator.current.generation) return;
        const token = engine.beforeMutation();
        report("observe", current);
        retainTarget(engine.afterMutation(token, { recoveryComplete: !historyPending.current }));
        if (apply) applyTarget();
      };
      const viewportObserver = new ResizeObserver(() => viewportTransaction());
      viewportObserver.observe(host);

      const siblingObserver = new ResizeObserver(() => {
        if (generation !== coordinator.current.generation) return;
        const beforePinned = engine.getSnapshot().pinned;
        const current = geometry(host);
        if (beforePinned && current.hostEnd > coordinator.current.settledHostEnd + 0.5) writeScroll("end");
        else settle();
      });
      const observedSiblings = new Set<Element>();
      const observeSiblings = () => {
        const nextSiblings = new Set([...host.children].filter((child) => child !== timelineElement.current));
        for (const child of observedSiblings) if (!nextSiblings.has(child)) siblingObserver.unobserve(child);
        for (const child of nextSiblings) if (!observedSiblings.has(child)) siblingObserver.observe(child);
        observedSiblings.clear();
        for (const child of nextSiblings) observedSiblings.add(child);
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
        coordinator.current.geometry = null;
        coordinator.current.owned = null;
        coordinator.current.target = null;
        coordinator.current.recoveryPending = false;
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
