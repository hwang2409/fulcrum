export type OutlineItem<Id extends string = string> = { readonly id: Id; readonly kind: string };
export type ScrollSource = "user" | "programmatic";

export type VirtualCache<Id extends string = string> = {
  sizes: readonly (readonly [Id, number])[];
  kindMedians: readonly (readonly [string, number])[];
};

export type VirtualOptions<Id extends string = string> = {
  estimateSize(kind: string): number;
  overscan?: number;
  maxMounted?: number;
  bottomThreshold?: number;
  cache?: VirtualCache<Id>;
  onAction?: (action: VirtualAction) => void;
};

export type Viewport = { scrollTop: number; size: number; source: ScrollSource };
export type VirtualRange = { start: number; end: number };
export type VirtualRow<Id extends string = string> = OutlineItem<Id> & {
  index: number;
  start: number;
  size: number;
  loaded: boolean;
};
export type Anchor<Id extends string = string> = { id: Id; index: number; offset: number };
export type MutationToken<Id extends string = string> = {
  anchor: Anchor<Id> | null;
  pinned: boolean;
  mode: "anchor" | "shift";
  distanceFromEnd: number;
};
export type MutationResult = {
  scrollTop: number;
  correction: number;
  appliedCorrection: number;
  jump: number;
  pendingJump: number;
  followedBottom: boolean;
};
export type VirtualAction = {
  sequence: number;
  time: number;
  type: "outline" | "viewport" | "measure" | "loaded" | "anchor" | "correction" | "scroll-to-id";
  detail: Readonly<Record<string, number | boolean | null>>;
};
export type VirtualSnapshot<Id extends string = string> = {
  totalSize: number;
  topSpacer: number;
  bottomSpacer: number;
  rows: readonly VirtualRow<Id>[];
  range: VirtualRange;
  visible: VirtualRange;
  anchor: Anchor<Id> | null;
  scrollTop: number;
  viewportSize: number;
  pinned: boolean;
  programmatic: boolean;
  correctionEvent: boolean;
  jump: number;
  pendingJump: number;
};

export type Virtualizer<Id extends string = string> = {
  setOutline(items: readonly OutlineItem<Id>[]): void;
  setViewport(viewport: Viewport): void;
  measure(id: Id, size: number): void;
  setLoaded(ids: Iterable<Id>): void;
  beforeMutation(options?: { mode?: "anchor" | "shift" }): MutationToken<Id>;
  afterMutation(token: MutationToken<Id>, options?: { deferCorrection?: boolean }): MutationResult;
  flushPendingCorrection(): MutationResult;
  scrollToId(id: Id): number;
  snapshotCache(): VirtualCache<Id>;
  subscribe(listener: () => void): () => void;
  getSnapshot(): VirtualSnapshot<Id>;
  getActions(): readonly VirtualAction[];
  destroy(): void;
};

class Fenwick {
  readonly values: number[];
  private readonly tree: Float64Array;

  constructor(values: readonly number[]) {
    this.values = [...values];
    this.tree = new Float64Array(values.length + 1);
    for (let index = 0; index < values.length; index++) this.add(index, values[index]!);
  }

  get total(): number {
    return this.prefix(this.values.length);
  }

  prefix(end: number): number {
    let sum = 0;
    for (let index = end; index > 0; index -= index & -index) sum += this.tree[index]!;
    return sum;
  }

  update(index: number, value: number): void {
    const delta = value - this.values[index]!;
    this.values[index] = value;
    this.add(index, delta);
  }

  // Fenwick keeps both point updates and prefix lookup logarithmic at 100,000 rows.
  lowerBound(offset: number): number {
    if (offset < 0) return 0;
    let index = 0;
    let sum = 0;
    let step = 1;
    while (step * 2 <= this.values.length) step *= 2;
    for (; step > 0; step >>= 1) {
      const next = index + step;
      if (next <= this.values.length && sum + this.tree[next]! <= offset) {
        index = next;
        sum += this.tree[next]!;
      }
    }
    return Math.min(index, this.values.length);
  }

  private add(index: number, delta: number): void {
    for (let cursor = index + 1; cursor < this.tree.length; cursor += cursor & -cursor) this.tree[cursor]! += delta;
  }
}

const checkSize = (size: number): number => {
  if (!Number.isFinite(size) || size < 0) throw new RangeError("row sizes must be finite and nonnegative");
  return size;
};

const medianPositive = (samples: ReadonlyMap<string, number>): number | null => {
  const values = [...samples.values()].filter((size) => size > 0).sort((a, b) => a - b);
  if (values.length === 0) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
};

export function createVirtualizer<Id extends string = string>(options: VirtualOptions<Id>): Virtualizer<Id> {
  const overscan = options.overscan;
  const maxMounted = options.maxMounted ?? 200;
  const bottomThreshold = options.bottomThreshold ?? 48;
  if (overscan !== undefined) checkSize(overscan);
  if (!Number.isInteger(maxMounted) || maxMounted < 1) throw new RangeError("maxMounted must be a positive integer");
  checkSize(bottomThreshold);

  let outline: readonly OutlineItem<Id>[] = [];
  let indexes = new Map<Id, number>();
  const measured = new Map<Id, number>(options.cache?.sizes);
  const kindMedians = new Map<string, number>(options.cache?.kindMedians);
  const measuredByKind = new Map<string, Map<Id, number>>();
  let indicesByKind = new Map<string, number[]>();
  let totalMeasuredSize = 0;
  let loaded = new Set<Id>();
  let sizes = new Fenwick([]);
  let scrollTop = 0;
  let viewportSize = 0;
  let pinned = true;
  let programmatic = false;
  let correctionEvent = false;
  let jump = 0;
  let pendingJump = 0;
  // Engine scroll writes alone create or replace this target; its first matching event consumes it at most once.
  // Scroll settlement clears it, while non-scroll mutations preserve it and adjust it when bounds move.
  let expectedCorrectionScroll: number | null = null;
  let rangeCursorIndex = 0;
  let rangeCursorStart = 0;
  let sequence = 0;
  const actions: VirtualAction[] = [];
  const listeners = new Set<() => void>();
  let snapshot: VirtualSnapshot<Id> | null = null;

  const log = (type: VirtualAction["type"], detail: VirtualAction["detail"]): void => {
    sequence++;
    const action = { sequence, time: sequence, type, detail };
    actions.push(action);
    if (actions.length > 2_000) actions.splice(0, actions.length - 2_000);
    options.onAction?.(action);
  };
  const changed = (): void => {
    snapshot = null;
    listeners.forEach((listener) => listener());
  };

  const maxScroll = (): number => Math.max(0, sizes.total - viewportSize);
  const clampScroll = (value: number): number => Math.min(maxScroll(), Math.max(0, value));
  const effectiveScrollTop = (): number => scrollTop + pendingJump;
  const captureExpectedAnchor = (): Anchor<Id> | null => {
    if (expectedCorrectionScroll === null || outline.length === 0) return null;
    const index = Math.min(sizes.lowerBound(expectedCorrectionScroll), outline.length - 1);
    return { id: outline[index]!.id, index, offset: sizes.prefix(index) - expectedCorrectionScroll };
  };
  const restoreExpectedAnchor = (anchor: Anchor<Id> | null): void => {
    if (expectedCorrectionScroll === null) return;
    if (anchor && outline.length > 0) {
      const index = indexes.get(anchor.id) ?? Math.min(anchor.index, outline.length - 1);
      expectedCorrectionScroll = sizes.prefix(index) - anchor.offset;
    }
    expectedCorrectionScroll = clampScroll(expectedCorrectionScroll);
  };

  const applyKindEstimate = (kind: string, median: number): void => {
    kindMedians.set(kind, median);
    for (const index of indicesByKind.get(kind) ?? []) {
      if (measured.has(outline[index]!.id)) continue;
      const delta = median - sizes.values[index]!;
      sizes.update(index, median);
      if (index < rangeCursorIndex) rangeCursorStart += delta;
    }
  };

  const calibrateKindEstimates = (): void => {
    if (viewportSize <= 0 || totalMeasuredSize <= viewportSize) return;
    for (const [kind, samples] of measuredByKind) {
      if (kindMedians.has(kind)) continue;
      const median = medianPositive(samples);
      if (median !== null) applyKindEstimate(kind, median);
    }
  };

  const findStartFromCursor = (offset: number): number => {
    if (outline.length === 0) return 0;
    rangeCursorIndex = Math.min(rangeCursorIndex, outline.length - 1);
    let steps = 0;
    while (rangeCursorIndex > 0 && rangeCursorStart > offset && steps++ < 16) {
      rangeCursorIndex--;
      rangeCursorStart -= sizes.values[rangeCursorIndex]!;
    }
    while (rangeCursorIndex < outline.length - 1 && rangeCursorStart + sizes.values[rangeCursorIndex]! <= offset && steps++ < 16) {
      rangeCursorStart += sizes.values[rangeCursorIndex]!;
      rangeCursorIndex++;
    }
    // Nearby scrolling walks from the prior range; large jumps fall back to logarithmic lookup.
    if (rangeCursorStart > offset || rangeCursorStart + sizes.values[rangeCursorIndex]! <= offset) {
      rangeCursorIndex = Math.min(sizes.lowerBound(offset), outline.length - 1);
      rangeCursorStart = sizes.prefix(rangeCursorIndex);
    }
    return rangeCursorIndex;
  };

  const endAt = (offset: number): number => {
    let end = sizes.lowerBound(offset);
    if (end < outline.length && sizes.prefix(end) < offset) end++;
    return end;
  };

  const visibleRange = (): VirtualRange => {
    if (outline.length === 0 || viewportSize <= 0) return { start: 0, end: 0 };
    const top = effectiveScrollTop();
    const start = findStartFromCursor(top);
    const end = endAt(top + viewportSize);
    return { start: Math.min(start, outline.length), end: Math.max(Math.min(end, outline.length), Math.min(start + 1, outline.length)) };
  };

  const mountedRange = (visible: VirtualRange): VirtualRange => {
    if (visible.end === 0) return visible;
    const buffer = overscan ?? viewportSize;
    const top = effectiveScrollTop();
    let start = sizes.lowerBound(Math.max(0, top - buffer));
    let end = endAt(top + viewportSize + buffer);
    end = Math.max(end, visible.end);
    const visibleCount = visible.end - visible.start;
    const limit = Math.max(maxMounted, visibleCount);
    if (end - start > limit) {
      const spare = limit - visibleCount;
      const before = Math.min(visible.start - start, Math.floor(spare / 2));
      const after = Math.min(end - visible.end, spare - before);
      start = visible.start - before;
      end = visible.end + after;
      const missing = limit - (end - start);
      start = Math.max(0, start - Math.min(missing, start));
      end = Math.min(outline.length, end + (limit - (end - start)));
    }
    return { start, end: Math.min(end, outline.length) };
  };

  const captureAnchor = (): Anchor<Id> | null => {
    const visible = visibleRange();
    if (visible.start === visible.end) return null;
    let index = visible.start;
    for (let cursor = visible.start; cursor < visible.end; cursor++) {
      if (loaded.has(outline[cursor]!.id)) {
        index = cursor;
        break;
      }
    }
    const item = outline[index]!;
    return { id: item.id, index, offset: sizes.prefix(index) - effectiveScrollTop() };
  };

  const setViewport = (viewport: Viewport): void => {
    checkSize(viewport.scrollTop);
    checkSize(viewport.size);
    const writesScroll = Math.abs(viewport.scrollTop - scrollTop) >= 0.5;
    const expectedAnchor = captureExpectedAnchor();
    viewportSize = viewport.size;
    calibrateKindEstimates();
    restoreExpectedAnchor(expectedAnchor);
    const nextScrollTop = clampScroll(viewport.scrollTop);
    const isCorrection = viewport.source === "user" && expectedCorrectionScroll !== null && Math.abs(nextScrollTop - expectedCorrectionScroll) < 0.5;
    if (viewport.source === "programmatic" && writesScroll) expectedCorrectionScroll = nextScrollTop;
    scrollTop = nextScrollTop;
    correctionEvent = isCorrection;
    programmatic = viewport.source === "programmatic" || isCorrection;
    if (viewport.source === "user" && !isCorrection) pinned = sizes.total - scrollTop - viewportSize <= bottomThreshold;
    if (isCorrection) expectedCorrectionScroll = null;
    if (isCorrection) jump = 0;
    log("viewport", { scrollTop, size: viewportSize, programmatic, pinned });
    changed();
  };

  return {
    setOutline(items) {
      const expectedAnchor = captureExpectedAnchor();
      const cursorId = outline[rangeCursorIndex]?.id;
      const ownedItems = items.map(({ id, kind }) => ({ id, kind }));
      const nextIndexes = new Map<Id, number>();
      const nextIndicesByKind = new Map<string, number[]>();
      measuredByKind.clear();
      totalMeasuredSize = 0;
      const values = ownedItems.map((item, index) => {
        if (nextIndexes.has(item.id)) throw new Error("outline ids must be unique");
        nextIndexes.set(item.id, index);
        const kindIndices = nextIndicesByKind.get(item.kind) ?? [];
        kindIndices.push(index);
        nextIndicesByKind.set(item.kind, kindIndices);
        const measuredSize = measured.get(item.id);
        if (measuredSize !== undefined) {
          totalMeasuredSize += measuredSize;
          const samples = measuredByKind.get(item.kind) ?? new Map<Id, number>();
          samples.set(item.id, measuredSize);
          measuredByKind.set(item.kind, samples);
        }
        return checkSize(measuredSize ?? kindMedians.get(item.kind) ?? options.estimateSize(item.kind));
      });
      outline = ownedItems;
      indexes = nextIndexes;
      indicesByKind = nextIndicesByKind;
      sizes = new Fenwick(values);
      rangeCursorIndex = cursorId === undefined ? 0 : (indexes.get(cursorId) ?? Math.min(rangeCursorIndex, Math.max(0, outline.length - 1)));
      rangeCursorStart = sizes.prefix(rangeCursorIndex);
      calibrateKindEstimates();
      restoreExpectedAnchor(expectedAnchor);
      log("outline", { count: outline.length, totalSize: sizes.total });
      changed();
    },
    setViewport,
    measure(id, size) {
      const expectedAnchor = captureExpectedAnchor();
      checkSize(size);
      const index = indexes.get(id);
      if (index === undefined) throw new Error("cannot measure an id outside the outline");
      const item = outline[index]!;
      const previousMeasurement = measured.get(id);
      const previousSize = sizes.values[index]!;
      measured.set(id, size);
      totalMeasuredSize += size - (previousMeasurement ?? 0);
      const samples = measuredByKind.get(item.kind) ?? new Map<Id, number>();
      samples.set(id, size);
      measuredByKind.set(item.kind, samples);
      sizes.update(index, size);
      if (index < rangeCursorIndex) rangeCursorStart += size - previousSize;
      calibrateKindEstimates();
      restoreExpectedAnchor(expectedAnchor);
      log("measure", { index, size, totalSize: sizes.total });
      changed();
    },
    setLoaded(ids) {
      loaded = new Set(ids);
      log("loaded", { count: loaded.size });
      changed();
    },
    beforeMutation(mutationOptions) {
      const anchor = captureAnchor();
      const mode = mutationOptions?.mode ?? "anchor";
      log("anchor", { index: anchor?.index ?? null, offset: anchor?.offset ?? null, pinned });
      return { anchor, pinned, mode, distanceFromEnd: sizes.total - effectiveScrollTop() };
    },
    afterMutation(token, mutationOptions) {
      const actualBefore = scrollTop;
      const logicalBefore = effectiveScrollTop();
      let requested = logicalBefore;
      let followedBottom = false;
      if (token.pinned) {
        requested = maxScroll();
        followedBottom = true;
      } else if (token.mode === "shift") {
        requested = sizes.total - token.distanceFromEnd;
      } else if (token.anchor && outline.length > 0) {
        const index = indexes.get(token.anchor.id) ?? Math.min(token.anchor.index, outline.length - 1);
        requested = sizes.prefix(index) - token.anchor.offset;
      }
      const correction = requested - logicalBefore;
      if (mutationOptions?.deferCorrection) {
        pendingJump += correction;
        jump = 0;
      } else {
        scrollTop = clampScroll(requested);
        pendingJump = 0;
        jump = scrollTop - actualBefore;
        if (Math.abs(jump) >= 0.5) expectedCorrectionScroll = scrollTop;
      }
      correctionEvent = false;
      programmatic = true;
      const appliedCorrection = jump;
      log("correction", { correction, appliedCorrection, pendingJump, followedBottom, scrollTop });
      changed();
      return { scrollTop, correction, appliedCorrection, jump, pendingJump, followedBottom };
    },
    flushPendingCorrection() {
      const before = scrollTop;
      const correction = pendingJump;
      scrollTop = clampScroll(scrollTop + pendingJump);
      pendingJump = 0;
      jump = scrollTop - before;
      expectedCorrectionScroll = Math.abs(jump) >= 0.5 ? scrollTop : null;
      correctionEvent = false;
      programmatic = true;
      log("correction", { correction, appliedCorrection: jump, pendingJump, followedBottom: false, scrollTop });
      changed();
      return { scrollTop, correction, appliedCorrection: jump, jump, pendingJump, followedBottom: false };
    },
    scrollToId(id) {
      const index = indexes.get(id);
      if (index === undefined) throw new Error("cannot scroll to an id outside the outline");
      setViewport({ scrollTop: sizes.prefix(index), size: viewportSize, source: "programmatic" });
      log("scroll-to-id", { index, scrollTop });
      return scrollTop;
    },
    snapshotCache() {
      return { sizes: [...measured], kindMedians: [...kindMedians] };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      if (snapshot) return snapshot;
      const visible = visibleRange();
      const range = mountedRange(visible);
      const rows = outline.slice(range.start, range.end).map((item, offset): VirtualRow<Id> => {
        const index = range.start + offset;
        return { ...item, index, start: sizes.prefix(index), size: sizes.values[index]!, loaded: loaded.has(item.id) };
      });
      const topSpacer = sizes.prefix(range.start);
      const bottomSpacer = sizes.total - sizes.prefix(range.end);
      snapshot = {
        totalSize: sizes.total,
        topSpacer,
        bottomSpacer,
        rows,
        range,
        visible,
        anchor: captureAnchor(),
        scrollTop,
        viewportSize,
        pinned,
        programmatic,
        correctionEvent,
        jump,
        pendingJump,
      };
      return snapshot;
    },
    getActions() {
      return [...actions];
    },
    destroy() {
      listeners.clear();
    },
  };
}
