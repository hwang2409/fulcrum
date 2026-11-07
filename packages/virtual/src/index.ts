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
  unseenCount: number;
};

/** One positional outline edit, as `Array.prototype.splice` takes it. */
export type OutlineSplice<Id extends string = string> = {
  readonly index: number;
  readonly deleteCount: number;
  readonly items: readonly OutlineItem<Id>[];
};
/**
 * How the new outline came from `from`: apply `splices` to it in order. The engine edits its layout in place when
 * `from` is the outline it last received, and rebuilds from the full outline otherwise (a caller that missed an update).
 */
export type OutlineUpdate<Id extends string = string> = {
  readonly from: readonly OutlineItem<Id>[];
  readonly splices: readonly OutlineSplice<Id>[];
};

export const formatVirtualDebug = (snapshot: VirtualSnapshot, actions: readonly VirtualAction[]) =>
  JSON.stringify({ range: snapshot.range, visible: snapshot.visible, totalSize: snapshot.totalSize, scrollTop: snapshot.scrollTop, pinned: snapshot.pinned, actions: actions.slice(-8) }, null, 2);

export type Virtualizer<Id extends string = string> = {
  reset(): void;
  setOutline(items: readonly OutlineItem<Id>[], update?: OutlineUpdate<Id> | null): void;
  setViewport(viewport: Viewport): void;
  measure(id: Id, size: number): void;
  setLoaded(ids: Iterable<Id> | "all"): void;
  setFollow(follow: boolean): void;
  beforeMutation(options?: { mode?: "anchor" | "shift" }): MutationToken<Id>;
  afterMutation(token: MutationToken<Id>, options?: { deferCorrection?: boolean }): MutationResult;
  flushPendingCorrection(notify?: boolean, releaseOwnership?: boolean): MutationResult;
  scrollToId(id: Id, viewportOffset?: number): number;
  scrollToEnd(): number;
  /** Requests bottom follow for a host action such as its own newly submitted message. */
  requestFollow(): number | null;
  snapshotCache(): VirtualCache<Id>;
  subscribe(listener: () => void): () => void;
  getSnapshot(): VirtualSnapshot<Id>;
  getActions(): readonly VirtualAction[];
  destroy(): void;
};

type SequenceNode<Id extends string> = {
  item: OutlineItem<Id>;
  value: number;
  sum: number;
  count: number;
  priority: number;
  left: SequenceNode<Id> | null;
  right: SequenceNode<Id> | null;
  parent: SequenceNode<Id> | null;
};

class Sequence<Id extends string> {
  private root: SequenceNode<Id> | null = null;
  readonly nodes = new Map<Id, SequenceNode<Id>>();
  private seed = 0x9e3779b9;

  constructor(entries: readonly { item: OutlineItem<Id>; value: number }[] = []) {
    this.append(entries);
  }

  get length(): number { return this.root?.count ?? 0; }
  get total(): number { return this.root?.sum ?? 0; }

  at(index: number): OutlineItem<Id> | undefined { return this.nodeAt(index)?.item; }
  valueAt(index: number): number { return this.nodeAt(index)?.value ?? 0; }

  indexOf(id: Id): number | undefined {
    let node = this.nodes.get(id);
    if (!node) return undefined;
    let index = node.left?.count ?? 0;
    while (node.parent) {
      if (node === node.parent.right) index += 1 + (node.parent.left?.count ?? 0);
      node = node.parent;
    }
    return index;
  }

  prefix(end: number): number {
    let node = this.root;
    let remaining = Math.min(Math.max(0, end), this.length);
    let sum = 0;
    while (node && remaining > 0) {
      const leftCount = node.left?.count ?? 0;
      if (remaining <= leftCount) node = node.left;
      else {
        sum += (node.left?.sum ?? 0) + node.value;
        remaining -= leftCount + 1;
        node = node.right;
      }
    }
    return sum;
  }

  update(index: number, value: number): void {
    let node = this.nodeAt(index);
    if (!node) throw new RangeError("row index is outside the outline");
    node.value = value;
    while (node) { this.recalculate(node); node = node.parent; }
  }

  lowerBound(offset: number): number {
    if (offset < 0) return 0;
    let node = this.root;
    let index = 0;
    let remaining = offset;
    while (node) {
      const leftSum = node.left?.sum ?? 0;
      const leftCount = node.left?.count ?? 0;
      if (remaining < leftSum) node = node.left;
      else if (remaining < leftSum + node.value) return index + leftCount;
      else {
        remaining -= leftSum + node.value;
        index += leftCount + 1;
        node = node.right;
      }
    }
    return index;
  }

  append(entries: readonly { item: OutlineItem<Id>; value: number }[]): void {
    this.root = this.merge(this.root, this.build(entries));
    if (this.root) this.root.parent = null;
  }

  /** Removes `deleteCount` rows at `index` (calling `rows.remove` for each), then inserts `items` there: O((d + k) log n). */
  splice(index: number, deleteCount: number, items: readonly OutlineItem<Id>[], rows: {
    add(item: OutlineItem<Id>): { item: OutlineItem<Id>; value: number };
    remove(item: OutlineItem<Id>): void;
  }): void {
    if (!Number.isInteger(index) || !Number.isInteger(deleteCount) || index < 0 || deleteCount < 0 || index + deleteCount > this.length) throw new RangeError("outline splice is outside the outline");
    // Checked before any change, so a bad edit leaves the layout whole: an inserted id may only reuse a removed row's id.
    const ids = new Set<Id>();
    for (const item of items) {
      const at = this.indexOf(item.id);
      if (ids.has(item.id) || (at !== undefined && (at < index || at >= index + deleteCount))) throw new Error("outline ids must be unique");
      ids.add(item.id);
    }
    const [left, rest] = this.split(this.root, index);
    const [cut, right] = this.split(rest, deleteCount);
    const remove = (node: SequenceNode<Id> | null): void => {
      if (!node) return;
      remove(node.left);
      this.nodes.delete(node.item.id);
      rows.remove(node.item);
      remove(node.right);
    };
    remove(cut);
    this.root = this.merge(this.merge(left, this.build(items.map(rows.add))), right);
  }

  private nodeAt(index: number): SequenceNode<Id> | null {
    if (index < 0 || index >= this.length) return null;
    let node = this.root;
    while (node) {
      const leftCount = node.left?.count ?? 0;
      if (index < leftCount) node = node.left;
      else if (index === leftCount) return node;
      else { index -= leftCount + 1; node = node.right; }
    }
    return null;
  }

  // Splits by position: the first `count` rows, then the rest. Both roots come back with no parent.
  private split(node: SequenceNode<Id> | null, count: number): [SequenceNode<Id> | null, SequenceNode<Id> | null] {
    if (!node) return [null, null];
    node.parent = null;
    const leftCount = node.left?.count ?? 0;
    if (count <= leftCount) {
      const [first, rest] = this.split(node.left, count);
      node.left = rest;
      if (rest) rest.parent = node;
      this.recalculate(node);
      return [first, node];
    }
    const [first, rest] = this.split(node.right, count - leftCount - 1);
    node.right = first;
    if (first) first.parent = node;
    this.recalculate(node);
    return [node, rest];
  }

  private build(entries: readonly { item: OutlineItem<Id>; value: number }[]): SequenceNode<Id> | null {
    let root: SequenceNode<Id> | null = null;
    for (const { item, value } of entries) {
      if (this.nodes.has(item.id)) throw new Error("outline ids must be unique");
      this.seed ^= this.seed << 13; this.seed ^= this.seed >>> 17; this.seed ^= this.seed << 5;
      const node: SequenceNode<Id> = { item, value, sum: value, count: 1, priority: this.seed >>> 0, left: null, right: null, parent: null };
      this.nodes.set(item.id, node);
      root = this.merge(root, node);
    }
    return root;
  }

  private merge(left: SequenceNode<Id> | null, right: SequenceNode<Id> | null): SequenceNode<Id> | null {
    if (!left) { if (right) right.parent = null; return right; }
    if (!right) { left.parent = null; return left; }
    if (left.priority < right.priority) {
      left.right = this.merge(left.right, right);
      if (left.right) left.right.parent = left;
      this.recalculate(left);
      left.parent = null;
      return left;
    }
    right.left = this.merge(left, right.left);
    if (right.left) right.left.parent = right;
    this.recalculate(right);
    right.parent = null;
    return right;
  }

  private recalculate(node: SequenceNode<Id>): void {
    node.count = 1 + (node.left?.count ?? 0) + (node.right?.count ?? 0);
    node.sum = node.value + (node.left?.sum ?? 0) + (node.right?.sum ?? 0);
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

  let layout = new Sequence<Id>();
  let appliedOutline: readonly OutlineItem<Id>[] | null = null;
  const measured = new Map<Id, number>(options.cache?.sizes);
  const kindMedians = new Map<string, number>(options.cache?.kindMedians);
  const measuredByKind = new Map<string, Map<Id, number>>();
  let idsByKind = new Map<string, Set<Id>>();
  let totalMeasuredSize = 0;
  let loaded: Set<Id> | "all" = new Set<Id>();
  let scrollTop = 0;
  let viewportSize = 0;
  let pinned = true;
  const unseenIds = new Set<Id>();
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

  const maxScroll = (): number => Math.max(0, layout.total - viewportSize);
  const clampScroll = (value: number): number => Math.min(maxScroll(), Math.max(0, value));
  const effectiveScrollTop = (): number => scrollTop + pendingJump;
  const captureExpectedAnchor = (): Anchor<Id> | null => {
    if (expectedCorrectionScroll === null || layout.length === 0) return null;
    const index = Math.min(layout.lowerBound(expectedCorrectionScroll), layout.length - 1);
    return { id: layout.at(index)!.id, index, offset: layout.prefix(index) - expectedCorrectionScroll };
  };
  const restoreExpectedAnchor = (anchor: Anchor<Id> | null): void => {
    if (expectedCorrectionScroll === null) return;
    if (anchor && layout.length > 0) {
      const index = layout.indexOf(anchor.id) ?? Math.min(anchor.index, layout.length - 1);
      expectedCorrectionScroll = layout.prefix(index) - anchor.offset;
    }
    expectedCorrectionScroll = clampScroll(expectedCorrectionScroll);
  };

  // Registers one row's kind and measured size, and returns its layout entry.
  const entry = ({ id, kind }: OutlineItem<Id>): { item: OutlineItem<Id>; value: number } => {
    const ids = idsByKind.get(kind) ?? new Set<Id>();
    ids.add(id);
    idsByKind.set(kind, ids);
    const measuredSize = measured.get(id);
    if (measuredSize !== undefined) {
      totalMeasuredSize += measuredSize;
      const samples = measuredByKind.get(kind) ?? new Map<Id, number>();
      samples.set(id, measuredSize);
      measuredByKind.set(kind, samples);
    }
    return { item: { id, kind }, value: checkSize(measuredSize ?? kindMedians.get(kind) ?? options.estimateSize(kind)) };
  };

  const applyKindEstimate = (kind: string, median: number): void => {
    kindMedians.set(kind, median);
    for (const id of idsByKind.get(kind) ?? []) {
      if (measured.has(id)) continue;
      const index = layout.indexOf(id);
      if (index === undefined) continue;
      const delta = median - layout.valueAt(index);
      layout.update(index, median);
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
    if (layout.length === 0) return 0;
    rangeCursorIndex = Math.min(rangeCursorIndex, layout.length - 1);
    let steps = 0;
    while (rangeCursorIndex > 0 && rangeCursorStart > offset && steps++ < 16) {
      rangeCursorIndex--;
      rangeCursorStart -= layout.valueAt(rangeCursorIndex);
    }
    while (rangeCursorIndex < layout.length - 1 && rangeCursorStart + layout.valueAt(rangeCursorIndex) <= offset && steps++ < 16) {
      rangeCursorStart += layout.valueAt(rangeCursorIndex);
      rangeCursorIndex++;
    }
    // Nearby scrolling walks from the prior range; large jumps fall back to logarithmic lookup.
    if (rangeCursorStart > offset || rangeCursorStart + layout.valueAt(rangeCursorIndex) <= offset) {
      rangeCursorIndex = Math.min(layout.lowerBound(offset), layout.length - 1);
      rangeCursorStart = layout.prefix(rangeCursorIndex);
    }
    return rangeCursorIndex;
  };

  const endAt = (offset: number): number => {
    let end = layout.lowerBound(offset);
    if (end < layout.length && layout.prefix(end) < offset) end++;
    return end;
  };

  const visibleRange = (): VirtualRange => {
    if (layout.length === 0 || viewportSize <= 0) return { start: 0, end: 0 };
    const top = effectiveScrollTop();
    const start = findStartFromCursor(top);
    const end = endAt(top + viewportSize);
    return { start: Math.min(start, layout.length), end: Math.max(Math.min(end, layout.length), Math.min(start + 1, layout.length)) };
  };

  const mountedRange = (visible: VirtualRange): VirtualRange => {
    if (visible.end === 0) return visible;
    const buffer = overscan ?? viewportSize;
    const top = effectiveScrollTop();
    let start = layout.lowerBound(Math.max(0, top - buffer));
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
      end = Math.min(layout.length, end + (limit - (end - start)));
    }
    return { start, end: Math.min(end, layout.length) };
  };

  const captureAnchor = (): Anchor<Id> | null => {
    const visible = visibleRange();
    if (visible.start === visible.end) return null;
    let index = visible.start;
    for (let cursor = visible.start; cursor < visible.end; cursor++) {
      if (loaded === "all" || loaded.has(layout.at(cursor)!.id)) {
        index = cursor;
        break;
      }
    }
    const item = layout.at(index)!;
    return { id: item.id, index, offset: layout.prefix(index) - effectiveScrollTop() };
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
    if (viewport.source === "user" && !isCorrection) {
      const distance = layout.total - scrollTop - viewportSize;
      pinned = pinned ? distance <= bottomThreshold : distance < 0.5;
      if (pinned) unseenIds.clear();
    }
    if (isCorrection) expectedCorrectionScroll = null;
    if (isCorrection) jump = 0;
    log("viewport", { scrollTop, size: viewportSize, programmatic, pinned });
    changed();
  };

  return {
    reset() {
      layout = new Sequence<Id>();
      appliedOutline = null;
      measured.clear();
      kindMedians.clear();
      measuredByKind.clear();
      idsByKind = new Map();
      totalMeasuredSize = 0;
      loaded = new Set<Id>();
      scrollTop = 0;
      pinned = true;
      unseenIds.clear();
      programmatic = false;
      correctionEvent = false;
      jump = 0;
      pendingJump = 0;
      expectedCorrectionScroll = null;
      rangeCursorIndex = 0;
      rangeCursorStart = 0;
      actions.length = 0;
      snapshot = null;
    },
    setOutline(items, update) {
      const expectedAnchor = captureExpectedAnchor();
      const cursorId = layout.at(rangeCursorIndex)?.id;
      if (update && update.from === appliedOutline) {
        let length = layout.length;
        for (const { index, deleteCount, items: inserted } of update.splices) {
          if (!Number.isInteger(index) || !Number.isInteger(deleteCount) || index < 0 || deleteCount < 0 || index + deleteCount > length)
            throw new RangeError("outline splice is outside the outline");
          length += inserted.length - deleteCount;
        }
        if (length !== items.length) throw new Error("outline update does not match the outline");
        // A later splice can still throw (a duplicate id) after earlier ones applied: then forget the outline, so the
        // next update rebuilds instead of editing a half-edited layout. A first splice that throws changed nothing.
        let applied = 0;
        try {
          for (const { index, deleteCount, items: inserted } of update.splices) {
            const atEnd = index === layout.length && deleteCount === 0;
            let replacedUnseen = false;
            layout.splice(index, deleteCount, inserted, {
              add: entry,
              remove: ({ id, kind }) => {
                idsByKind.get(kind)?.delete(id);
                if (measuredByKind.get(kind)?.delete(id)) totalMeasuredSize -= measured.get(id)!;
                if (unseenIds.delete(id)) replacedUnseen = true;
              },
            });
            // New rows at the end are unseen; a row that replaces an unseen row stays unseen; history and folds are not new.
            if (!pinned && (atEnd || replacedUnseen)) for (const { id } of inserted) unseenIds.add(id);
            applied++;
          }
        } catch (error) {
          if (applied > 0) appliedOutline = null;
          throw error;
        }
      } else {
        const ids = new Set<Id>();
        for (const { id } of items) {
          if (ids.has(id)) throw new Error("outline ids must be unique");
          ids.add(id);
        }
        measuredByKind.clear();
        idsByKind = new Map();
        totalMeasuredSize = 0;
        layout = new Sequence(items.map(entry));
        for (const id of unseenIds) if (!ids.has(id)) unseenIds.delete(id);
      }
      appliedOutline = items;
      rangeCursorIndex = cursorId === undefined ? 0 : (layout.indexOf(cursorId) ?? Math.min(rangeCursorIndex, Math.max(0, layout.length - 1)));
      rangeCursorStart = layout.prefix(rangeCursorIndex);
      calibrateKindEstimates();
      restoreExpectedAnchor(expectedAnchor);
      log("outline", { count: layout.length, totalSize: layout.total });
      changed();
    },
    setViewport,
    measure(id, size) {
      const expectedAnchor = captureExpectedAnchor();
      const wasPinned = pinned;
      checkSize(size);
      const index = layout.indexOf(id);
      if (index === undefined) throw new Error("cannot measure an id outside the outline");
      const item = layout.at(index)!;
      const previousMeasurement = measured.get(id);
      const previousSize = layout.valueAt(index);
      measured.set(id, size);
      totalMeasuredSize += size - (previousMeasurement ?? 0);
      const samples = measuredByKind.get(item.kind) ?? new Map<Id, number>();
      samples.set(id, size);
      measuredByKind.set(item.kind, samples);
      layout.update(index, size);
      if (index < rangeCursorIndex) rangeCursorStart += size - previousSize;
      calibrateKindEstimates();
      restoreExpectedAnchor(expectedAnchor);
      // A size change is not user input. Keep an already-following viewport following the new bottom.
      if (wasPinned) pinned = true;
      log("measure", { index, size, totalSize: layout.total });
      changed();
    },
    setLoaded(ids) {
      loaded = ids === "all" ? "all" : new Set(ids);
      log("loaded", { count: loaded === "all" ? layout.length : loaded.size });
      changed();
    },
    setFollow(follow) {
      pinned = follow;
      jump = 0; // a follow change moves nothing: a stale jump would make the adapter undo the user's scroll
      if (follow) unseenIds.clear();
      log("viewport", { scrollTop, size: viewportSize, programmatic: false, pinned });
      changed();
    },
    beforeMutation(mutationOptions) {
      const anchor = captureAnchor();
      const mode = mutationOptions?.mode ?? "anchor";
      log("anchor", { index: anchor?.index ?? null, offset: anchor?.offset ?? null, pinned });
      return { anchor, pinned, mode, distanceFromEnd: layout.total - effectiveScrollTop() };
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
        requested = layout.total - token.distanceFromEnd;
      } else if (token.anchor && layout.length > 0) {
        const index = layout.indexOf(token.anchor.id) ?? Math.min(token.anchor.index, layout.length - 1);
        requested = layout.prefix(index) - token.anchor.offset;
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
    flushPendingCorrection(notify = true, releaseOwnership = false) {
      const before = scrollTop;
      const correction = pendingJump;
      scrollTop = clampScroll(scrollTop + pendingJump);
      pendingJump = 0;
      jump = scrollTop - before;
      expectedCorrectionScroll = !releaseOwnership && Math.abs(jump) >= 0.5 ? scrollTop : null;
      correctionEvent = false;
      programmatic = !releaseOwnership;
      log("correction", { correction, appliedCorrection: jump, pendingJump, followedBottom: false, scrollTop });
      if (notify) changed();
      return { scrollTop, correction, appliedCorrection: jump, jump, pendingJump, followedBottom: false };
    },
    scrollToId(id, viewportOffset = 0) {
      const index = layout.indexOf(id);
      if (index === undefined) throw new Error("cannot scroll to an id outside the outline");
      // Follow mode is set before the viewport notifies, so subscribers never read a stale `pinned`.
      const next = clampScroll(layout.prefix(index) - viewportOffset);
      pinned = maxScroll() - next < 0.5;
      if (pinned) unseenIds.clear();
      setViewport({ scrollTop: next, size: viewportSize, source: "programmatic" });
      log("scroll-to-id", { index, scrollTop });
      return scrollTop;
    },
    scrollToEnd() {
      pinned = true;
      unseenIds.clear();
      setViewport({ scrollTop: maxScroll(), size: viewportSize, source: "programmatic" });
      return scrollTop;
    },
    requestFollow() {
      if (pinned) return null;
      pinned = true;
      unseenIds.clear();
      setViewport({ scrollTop: maxScroll(), size: viewportSize, source: "programmatic" });
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
      const rows: VirtualRow<Id>[] = [];
      for (let index = range.start; index < range.end; index++) {
        const item = layout.at(index)!;
        rows.push({ ...item, index, start: layout.prefix(index), size: layout.valueAt(index), loaded: loaded === "all" || loaded.has(item.id) });
      }
      const topSpacer = layout.prefix(range.start);
      const bottomSpacer = layout.total - layout.prefix(range.end);
      snapshot = {
        totalSize: layout.total,
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
        unseenCount: unseenIds.size,
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
