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
import {
  decideSettle,
  type HostSample,
  type ScrollTarget,
  type SettleDecision,
  type SettleState,
} from "./settle.js";

const defaultVirtualGutter = 8;
const emptySample: HostSample = { top: 0, end: 0, clientHeight: 0, rectTop: 0, rectBottom: 0, engineTop: 0 };
const isPureAppend = <Id extends string>(update: OutlineUpdate<Id> | null | undefined) => {
  if (!update || update.splices.length === 0) return false;
  let length = update.from.length;
  for (const splice of update.splices) {
    if (splice.index !== length || splice.deleteCount !== 0) return false;
    length += splice.items.length;
  }
  return true;
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
  /** Whether a newly created list starts by following its end. Defaults to true. */
  initialFollow?: boolean;
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
  if (!engineRef.current) {
    engineRef.current = createVirtualizer(options);
    if (options.initialFollow === false) engineRef.current.setFollow(false);
  }
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
  const pendingScrollEcho = useRef<number | null>(null);
  const rowIds = useRef(new WeakMap<Element, Id>());
  const observerRef = useRef<ResizeObserver | null>(null);
  const historyPending = useRef(options.historyPending === true);
  historyPending.current = options.historyPending === true;
  const appliedOutline = useRef<readonly OutlineItem<Id>[] | null>(null);
  const releaseCurrent = useRef<(() => void) | null>(null);
  const transferCurrent = useRef<((next: HTMLElement | null) => void) | null>(null);
  const settleLayoutCurrent = useRef<(() => void) | null>(null);
  const coordinator = useRef<SettleState>({
    owner: null,
    recovery: null,
    pinned: options.initialFollow !== false,
    lastObserved: emptySample,
    historyPending: options.historyPending === true,
    writeBlockedByTouch: false,
    deferred: null,
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

  const sampleOf = useCallback((current: ReturnType<typeof geometry>): HostSample => ({
    top: current.hostTop,
    end: current.hostEnd,
    clientHeight: current.hostGeometry.clientHeight,
    rectTop: current.hostGeometry.rectTop,
    rectBottom: current.hostGeometry.rectBottom,
    engineTop: current.engineTop,
  }), []);

  const writeScroll = useCallback((target: ScrollTarget, syncEngine = true) => {
    const host = containerRef.current;
    if (!host) return;
    const before = geometry(host);
    const snapshot = engine.getSnapshot();
    const logicalEnd = before.prefix + snapshot.totalSize + 2 * defaultVirtualGutter - host.clientHeight;
    const desiredHostTop = target === "end"
      ? snapshot.totalSize === 0
        ? 0
        : Math.max(before.hostEnd, logicalEnd)
      : before.prefix + before.gutter + target;
    host.scrollTop = desiredHostTop;
    const after = geometry(host);
    pendingScrollEcho.current = after.hostTop;
    const decision = decideSettle(coordinator.current, {
      kind: "owner-write",
      target,
      before: sampleOf(before),
      sample: sampleOf(after),
    });
    coordinator.current = decision.next;
    const size = Math.max(0, host.clientHeight - after.gutter);
    if (syncEngine && (Math.abs(snapshot.scrollTop - after.engineTop) >= 0.5 || snapshot.viewportSize !== size)) {
      engine.setViewport({ scrollTop: after.engineTop, size, source: "programmatic" });
    }
  }, [engine, geometry, sampleOf]);

  const finishMutation = useCallback((result: MutationResult) => {
    const host = containerRef.current;
    if (!host) return;
    const current = sampleOf(geometry(host));
    let decision: SettleDecision;
    const recoveryWasOpen = coordinator.current.recovery !== null;
    if (result.recoveryPending) {
      if (coordinator.current.recovery !== null) return;
      decision = decideSettle(coordinator.current, { kind: "recovery-open", sample: current, target: null });
    } else {
      const target: ScrollTarget = coordinator.current.pinned || result.followedBottom ? "end" : result.scrollTop;
      decision = decideSettle(coordinator.current, { kind: "recovery-complete", sample: current, target });
    }
    coordinator.current = decision.next;
    if (decision.write !== null && (recoveryWasOpen || Math.abs(result.jump) >= 0.5)) {
      writeScroll(decision.write);
    }
  }, [geometry, sampleOf, writeScroll]);

  useLayoutEffect(() => {
    if (resetPending) {
      appliedResetKey.current = options.resetKey;
      appliedOutline.current = null;
      releaseCurrent.current?.();
      releaseCurrent.current = null;
      containerRef.current = null;
      coordinator.current = decideSettle(coordinator.current, { kind: "reset" }).next;
      engine.reset();
    }
    if (appliedOutline.current !== outline) {
      const first = appliedOutline.current === null;
      appliedOutline.current = outline;
      const token = engine.beforeMutation();
      if (options.invalidateMeasurements) engine.invalidateMeasurements(options.invalidateMeasurements);
      engine.setOutline(outline, options.outlineUpdate);
      engine.setLoaded("all");
      if (first) {
        coordinator.current = { ...coordinator.current, pinned: engine.getSnapshot().pinned };
      } else {
        const result = engine.afterMutation(token, { recoveryComplete: options.historyPending !== true });
        if (options.enabled !== false) {
          const detachedAppend = isPureAppend(options.outlineUpdate)
            && !coordinator.current.pinned
            && coordinator.current.recovery === null
            && coordinator.current.deferred === null;
          if (detachedAppend) coordinator.current = decideSettle(coordinator.current, { kind: "commit-append", sample: null }).next;
          else finishMutation(result);
        }
      }
    } else if (options.historyPending !== true) {
      const result = engine.completeRecovery();
      if (result && options.enabled !== false) finishMutation(result);
    }
  }, [engine, finishMutation, outline, options.enabled, options.historyPending, options.invalidateMeasurements, options.outlineUpdate, options.resetKey, resetPending]);

  useLayoutEffect(() => {
    const transfer = (next: HTMLElement | null) => {
      if (containerRef.current === next) return;
      if (containerRef.current) {
        releaseCurrent.current?.();
        releaseCurrent.current = null;
        containerRef.current = null;
      }
      if (!next) return;
      const host = next;
      containerRef.current = host;
      coordinator.current = decideSettle(coordinator.current, { kind: "reset" }).next;
      const priorOverflowAnchor = host.style.overflowAnchor;
      host.style.overflowAnchor = "none";

      type Geometry = ReturnType<typeof geometry>;
      let lastLayoutSample = sampleOf(geometry(host));
      const applyDecision = (decision: SettleDecision, current: Geometry, write = true) => {
        coordinator.current = decision.next;
        if (decision.report !== null) {
          engine.setViewport({
            scrollTop: current.engineTop,
            size: Math.max(0, current.hostGeometry.clientHeight - current.gutter),
            source: decision.report,
          });
          if (decision.next.pinned && !engine.getSnapshot().pinned) engine.requestFollow();
        }
        if (write && decision.write !== null) writeScroll(decision.write);
      };
      const settle = (kind: "scroll" | "viewport" | "rows" | "siblings" | "commit-layout", current = geometry(host), write = true) => {
        lastLayoutSample = sampleOf(current);
        applyDecision(decideSettle(coordinator.current, { kind, sample: lastLayoutSample }), current, write);
      };

      const rowObserver = new ResizeObserver((entries) => {
        if (entries.length === 0) return;
        const current = geometry(host);
        settle("rows", current, false);
        const measurements = entries.flatMap((entry) => {
          const id = rowIds.current.get(entry.target);
          return id !== undefined && rows.current.get(id) === entry.target
            ? [[id, entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height] as const]
            : [];
        });
        if (measurements.length === 0) return;
        const token = engine.beforeMutation();
        for (const [id, size] of measurements) engine.measure(id, size);
        finishMutation(engine.afterMutation(token, { recoveryComplete: !historyPending.current }));
      });
      observerRef.current = rowObserver;
      for (const row of rows.current.values()) rowObserver.observe(row);

      const viewportTransaction = (current = geometry(host)) => {
        const token = engine.beforeMutation();
        settle("viewport", current);
        finishMutation(engine.afterMutation(token, { recoveryComplete: !historyPending.current }));
      };
      const viewportObserver = new ResizeObserver(() => viewportTransaction());
      viewportObserver.observe(host);

      const siblingObserver = new ResizeObserver(() => {
        settle("siblings");
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

      const onScroll = () => {
        const pending = pendingScrollEcho.current;
        pendingScrollEcho.current = null;
        if (pending !== null && Math.abs(host.scrollTop - pending) < 0.5) return;
        settle("scroll");
      };
      const onTouchStart = () => {
        coordinator.current = decideSettle(coordinator.current, { kind: "touch-start" }).next;
      };
      const onTouchEnd = () => {
        const current = geometry(host);
        applyDecision(decideSettle(coordinator.current, { kind: "touch-end", sample: sampleOf(current) }), current);
      };
      host.addEventListener("scroll", onScroll, { passive: true });
      host.addEventListener("touchstart", onTouchStart, { passive: true });
      host.addEventListener("touchend", onTouchEnd, { passive: true });
      host.addEventListener("touchcancel", onTouchEnd, { passive: true });

      const attachedSnapshot = engine.getSnapshot();
      if (attachedSnapshot.pinned) writeScroll("end");
      else if (attachedSnapshot.scrollTop !== host.scrollTop) writeScroll(attachedSnapshot.scrollTop);
      else {
        const current = geometry(host);
        engine.setViewport({ scrollTop: current.engineTop, size: Math.max(0, host.clientHeight - current.gutter), source: "programmatic" });
      }

      const release = () => {
        coordinator.current = decideSettle(coordinator.current, { kind: "reset" }).next;
        rowObserver.disconnect();
        viewportObserver.disconnect();
        siblingObserver.disconnect();
        siblingMutations.disconnect();
        observerRef.current = null;
        settleLayoutCurrent.current = null;
        host.removeEventListener("scroll", onScroll);
        host.removeEventListener("touchstart", onTouchStart);
        host.removeEventListener("touchend", onTouchEnd);
        host.removeEventListener("touchcancel", onTouchEnd);
        host.style.overflowAnchor = priorOverflowAnchor;
        engine.flushPendingCorrection(false, true);
      };
      releaseCurrent.current = release;
      settleLayoutCurrent.current = () => {
        const current = geometry(host);
        const sample = sampleOf(current);
        if (
          Math.abs(sample.end - lastLayoutSample.end) < 0.5
          && Math.abs(sample.clientHeight - lastLayoutSample.clientHeight) < 0.5
          && Math.abs(sample.rectTop - lastLayoutSample.rectTop) < 0.5
          && Math.abs(sample.rectBottom - lastLayoutSample.rectBottom) < 0.5
        ) return;
        settle("commit-layout", current);
      };
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

  useLayoutEffect(() => {
    const state = coordinator.current;
    if (state.pinned || state.owner !== null) settleLayoutCurrent.current?.();
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
    if (!containerRef.current) return;
    coordinator.current = decideSettle(coordinator.current, { kind: "detach" }).next;
    writeScroll(engine.scrollToId(id, viewportOffset));
  }, [engine, writeScroll]);

  const scrollToEnd = useCallback(() => {
    if (!containerRef.current) return;
    coordinator.current = decideSettle(coordinator.current, { kind: "follow" }).next;
    engine.scrollToEnd();
    writeScroll("end");
  }, [engine, writeScroll]);

  const requestFollow = useCallback(() => {
    if (!containerRef.current) return;
    coordinator.current = decideSettle(coordinator.current, { kind: "follow" }).next;
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
