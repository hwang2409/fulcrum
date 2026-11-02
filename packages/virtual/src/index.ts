export type OutlineItem<Id extends string = string> = { id: Id; kind: string };
export type ScrollSource = "user" | "programmatic";

export type VirtualOptions = {
  estimateSize(kind: string): number;
  overscan?: number;
  maxMounted?: number;
  bottomThreshold?: number;
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
export type MutationToken<Id extends string = string> = { anchor: Anchor<Id> | null; pinned: boolean };
export type MutationResult = {
  scrollTop: number;
  correction: number;
  appliedCorrection: number;
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
};

export type Virtualizer<Id extends string = string> = {
  setOutline(items: readonly OutlineItem<Id>[]): void;
  setViewport(viewport: Viewport): void;
  measure(id: Id, size: number): void;
  setLoaded(ids: Iterable<Id>): void;
  beforeMutation(): MutationToken<Id>;
  afterMutation(token: MutationToken<Id>): MutationResult;
  scrollToId(id: Id): number;
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

export function createVirtualizer<Id extends string = string>(options: VirtualOptions): Virtualizer<Id> {
  const overscan = options.overscan;
  const maxMounted = options.maxMounted ?? 200;
  const bottomThreshold = options.bottomThreshold ?? 48;
  if (overscan !== undefined) checkSize(overscan);
  if (!Number.isInteger(maxMounted) || maxMounted < 1) throw new RangeError("maxMounted must be a positive integer");
  checkSize(bottomThreshold);

  let outline: readonly OutlineItem<Id>[] = [];
  let indexes = new Map<Id, number>();
  const measured = new Map<Id, number>();
  let loaded = new Set<Id>();
  let sizes = new Fenwick([]);
  let scrollTop = 0;
  let viewportSize = 0;
  let pinned = true;
  let programmatic = false;
  let sequence = 0;
  const actions: VirtualAction[] = [];
  const listeners = new Set<() => void>();

  const log = (type: VirtualAction["type"], detail: VirtualAction["detail"]): void => {
    sequence++;
    const action = { sequence, time: sequence, type, detail };
    actions.push(action);
    if (actions.length > 2_000) actions.splice(0, actions.length - 2_000);
    options.onAction?.(action);
  };
  const changed = (): void => listeners.forEach((listener) => listener());

  const maxScroll = (): number => Math.max(0, sizes.total - viewportSize);
  const clampScroll = (value: number): number => Math.min(maxScroll(), Math.max(0, value));

  const visibleRange = (): VirtualRange => {
    if (outline.length === 0 || viewportSize <= 0) return { start: 0, end: 0 };
    const start = sizes.lowerBound(scrollTop);
    const bottom = scrollTop + viewportSize;
    let end = sizes.lowerBound(bottom);
    if (end < outline.length && sizes.prefix(end) < bottom) end++;
    return { start: Math.min(start, outline.length), end: Math.max(Math.min(end, outline.length), Math.min(start + 1, outline.length)) };
  };

  const mountedRange = (visible: VirtualRange): VirtualRange => {
    if (visible.end === 0) return visible;
    const buffer = overscan ?? viewportSize;
    let start = sizes.lowerBound(Math.max(0, scrollTop - buffer));
    let end = sizes.lowerBound(scrollTop + viewportSize + buffer);
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
    return { id: item.id, index, offset: sizes.prefix(index) - scrollTop };
  };

  const setViewport = (viewport: Viewport): void => {
    checkSize(viewport.scrollTop);
    checkSize(viewport.size);
    viewportSize = viewport.size;
    scrollTop = clampScroll(viewport.scrollTop);
    programmatic = viewport.source === "programmatic";
    if (viewport.source === "user") pinned = sizes.total - scrollTop - viewportSize <= bottomThreshold;
    log("viewport", { scrollTop, size: viewportSize, programmatic, pinned });
    changed();
  };

  return {
    setOutline(items) {
      const nextIndexes = new Map<Id, number>();
      const values = items.map((item, index) => {
        if (nextIndexes.has(item.id)) throw new Error("outline ids must be unique");
        nextIndexes.set(item.id, index);
        return checkSize(measured.get(item.id) ?? options.estimateSize(item.kind));
      });
      outline = [...items];
      indexes = nextIndexes;
      sizes = new Fenwick(values);
      scrollTop = clampScroll(scrollTop);
      log("outline", { count: outline.length, totalSize: sizes.total });
      changed();
    },
    setViewport,
    measure(id, size) {
      checkSize(size);
      const index = indexes.get(id);
      if (index === undefined) throw new Error("cannot measure an id outside the outline");
      measured.set(id, size);
      sizes.update(index, size);
      log("measure", { index, size, totalSize: sizes.total });
      changed();
    },
    setLoaded(ids) {
      loaded = new Set(ids);
      log("loaded", { count: loaded.size });
      changed();
    },
    beforeMutation() {
      const anchor = captureAnchor();
      log("anchor", { index: anchor?.index ?? null, offset: anchor?.offset ?? null, pinned });
      return { anchor, pinned };
    },
    afterMutation(token) {
      const before = scrollTop;
      let requested = before;
      let followedBottom = false;
      if (token.pinned) {
        requested = maxScroll();
        followedBottom = true;
      } else if (token.anchor && outline.length > 0) {
        const index = indexes.get(token.anchor.id) ?? Math.min(token.anchor.index, outline.length - 1);
        requested = sizes.prefix(index) - token.anchor.offset;
      }
      scrollTop = clampScroll(requested);
      programmatic = true;
      const correction = requested - before;
      const appliedCorrection = scrollTop - before;
      log("correction", { correction, appliedCorrection, followedBottom, scrollTop });
      changed();
      return { scrollTop, correction, appliedCorrection, followedBottom };
    },
    scrollToId(id) {
      const index = indexes.get(id);
      if (index === undefined) throw new Error("cannot scroll to an id outside the outline");
      setViewport({ scrollTop: sizes.prefix(index), size: viewportSize, source: "programmatic" });
      log("scroll-to-id", { index, scrollTop });
      return scrollTop;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      const visible = visibleRange();
      const range = mountedRange(visible);
      const rows = outline.slice(range.start, range.end).map((item, offset): VirtualRow<Id> => {
        const index = range.start + offset;
        return { ...item, index, start: sizes.prefix(index), size: sizes.values[index]!, loaded: loaded.has(item.id) };
      });
      const topSpacer = sizes.prefix(range.start);
      const bottomSpacer = sizes.total - sizes.prefix(range.end);
      return {
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
      };
    },
    getActions() {
      return [...actions];
    },
    destroy() {
      listeners.clear();
    },
  };
}
