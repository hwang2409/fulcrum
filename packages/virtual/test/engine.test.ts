import { describe, expect, test } from "bun:test";
import { createVirtualizer, type OutlineItem, type MutationToken } from "../src/index.js";

const items = (sizes: readonly number[], loaded = true): { outline: OutlineItem[]; estimate: (kind: string) => number; loaded: string[] } => ({
  outline: sizes.map((size, index) => ({ id: `row-${index}`, kind: `${size}:${index}` })),
  estimate: (kind) => Number.parseFloat(kind),
  loaded: loaded ? sizes.map((_, index) => `row-${index}`) : [],
});

function engine(sizes: readonly number[], viewport = 100, scrollTop = 0, loaded = true) {
  const data = items(sizes, loaded);
  const virtual = createVirtualizer({ estimateSize: data.estimate, bottomThreshold: 0 });
  virtual.setOutline(data.outline);
  virtual.setLoaded(data.loaded);
  virtual.setViewport({ scrollTop, size: viewport, source: "user" });
  return virtual;
}

function mutate(virtual: ReturnType<typeof engine>, change: (token: MutationToken) => void) {
  const token = virtual.beforeMutation();
  change(token);
  return virtual.afterMutation(token);
}

describe("prefix and range math", () => {
  test("empty outline", () => {
    const snapshot = engine([]).getSnapshot();
    expect(snapshot.totalSize).toBe(0);
    expect(snapshot.rows).toEqual([]);
  });
  test("one row", () => {
    const snapshot = engine([12]).getSnapshot();
    expect(snapshot.rows[0]).toMatchObject({ id: "row-0", index: 0, start: 0, size: 12 });
    expect(snapshot.totalSize).toBe(12);
  });
  test("includes the first intersecting row", () => expect(engine([10, 10], 5, 0).getSnapshot().visible).toEqual({ start: 0, end: 1 }));
  test("includes the last intersecting row", () => expect(engine([10, 10], 5, 15).getSnapshot().visible).toEqual({ start: 1, end: 2 }));
  test("an exact row boundary starts the next row", () => expect(engine([10, 10], 5, 10).getSnapshot().visible).toEqual({ start: 1, end: 2 }));
  test("subpixel sizes retain exact totals", () => expect(engine([0.25, 0.5, 0.75]).getSnapshot().totalSize).toBe(1.5));
  test("rejects negative estimates", () => expect(() => engine([-1])).toThrow("nonnegative"));
  test("rejects duplicate ids", () => {
    const virtual = createVirtualizer({ estimateSize: () => 10 });
    expect(() => virtual.setOutline([{ id: "a", kind: "x" }, { id: "a", kind: "x" }])).toThrow("unique");
  });
  test("owns outline item ids and kinds", () => {
    const item = { id: "a", kind: "10" };
    const virtual = createVirtualizer({ estimateSize: Number });
    virtual.setOutline([item]);
    virtual.setViewport({ scrollTop: 0, size: 10, source: "user" });
    item.id = "b";
    item.kind = "20";
    expect(virtual.getSnapshot().rows[0]).toMatchObject({ id: "a", kind: "10" });
    expect(() => virtual.measure("b", 5)).toThrow("outside the outline");
    expect(() => virtual.measure("a", 5)).not.toThrow();
  });
  test("updates a measured point and total", () => {
    const virtual = engine([10, 10, 10]);
    virtual.measure("row-1", 25);
    expect(virtual.getSnapshot().rows.map((row) => row.start)).toEqual([0, 10, 35]);
    expect(virtual.getSnapshot().totalSize).toBe(45);
  });
  test("replaces each kind estimate with its measured median", () => {
    const virtual = createVirtualizer({ estimateSize: () => 100, bottomThreshold: 0 });
    virtual.setOutline([
      { id: "a-0", kind: "a" }, { id: "a-1", kind: "a" }, { id: "a-2", kind: "a" }, { id: "a-3", kind: "a" },
      { id: "b-0", kind: "b" }, { id: "b-1", kind: "b" },
    ]);
    virtual.setViewport({ scrollTop: 0, size: 50, source: "user" });
    virtual.measure("a-0", 10);
    virtual.measure("a-1", 30);
    virtual.measure("a-2", 20);
    virtual.measure("b-0", 80);
    expect(virtual.getSnapshot().totalSize).toBe(240);
  });
  test("restores measured sizes and kind medians by stable id", () => {
    const first = createVirtualizer({ estimateSize: () => 100 });
    first.setOutline([{ id: "a", kind: "x" }, { id: "b", kind: "x" }]);
    first.setViewport({ scrollTop: 0, size: 5, source: "user" });
    first.measure("a", 12);
    const cache = first.snapshotCache();
    const restored = createVirtualizer({ estimateSize: () => 100, cache });
    restored.setOutline([{ id: "a", kind: "x" }, { id: "b", kind: "x" }]);
    restored.setViewport({ scrollTop: 0, size: 100, source: "programmatic" });
    expect(restored.getSnapshot().rows.map(({ size }) => size)).toEqual([12, 12]);
  });
  test("handles 100,000 rows and 10,000 seeded updates", () => {
    const count = 100_000;
    let seed = 0x12345678;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const sizes = new Array(count).fill(10);
    const virtual = engine(sizes, 500);
    let total = count * 10;
    for (let step = 0; step < 10_000; step++) {
      const index = Math.floor(random() * count);
      const size = random() * 40;
      total += size - sizes[index]!;
      sizes[index] = size;
      virtual.measure(`row-${index}`, size);
      expect(virtual.getSnapshot().totalSize).toBeCloseTo(total, 6);
      const probe = Math.floor(random() * count);
      let naivePrefix = 0;
      for (let cursor = 0; cursor < probe; cursor++) naivePrefix += sizes[cursor]!;
      virtual.setViewport({ scrollTop: 0, size: 0, source: "programmatic" });
      expect(virtual.scrollToId(`row-${probe}`)).toBeCloseTo(naivePrefix, 6);
    }
    for (let index = 0, prefix = 0; index < count; index++) {
      if (index % 997 === 0) virtual.setViewport({ scrollTop: prefix, size: 0.01, source: "user" });
      prefix += sizes[index]!;
    }
    expect(virtual.getSnapshot().totalSize).toBeCloseTo(sizes.reduce((sum, size) => sum + size, 0), 6);
  });
});

describe("window calculation", () => {
  test("uses pixel overscan", () => {
    const virtual = createVirtualizer({ estimateSize: () => 10, overscan: 10 });
    virtual.setOutline(items([10, 10, 10, 10]).outline);
    virtual.setViewport({ scrollTop: 10, size: 10, source: "user" });
    expect(virtual.getSnapshot().range).toEqual({ start: 0, end: 3 });
  });
  test("defaults overscan to one viewport", () => expect(engine([10, 10, 10, 10], 10, 10).getSnapshot().range).toEqual({ start: 0, end: 3 }));
  test("caps buffered tiny rows at 200", () => {
    const virtual = createVirtualizer({ estimateSize: () => 1, overscan: 10_000 });
    virtual.setOutline(items(new Array(1_000).fill(1)).outline);
    virtual.setViewport({ scrollTop: 400, size: 10, source: "user" });
    expect(virtual.getSnapshot().rows).toHaveLength(200);
  });
  test("keeps every visible row above the cap", () => {
    const virtual = createVirtualizer({ estimateSize: () => 1, maxMounted: 20 });
    virtual.setOutline(items(new Array(100).fill(1)).outline);
    virtual.setViewport({ scrollTop: 0, size: 30, source: "user" });
    expect(virtual.getSnapshot().rows).toHaveLength(30);
  });
  test("spacers add up with mounted rows", () => {
    const snapshot = engine(new Array(100).fill(5), 10, 250).getSnapshot();
    expect(snapshot.topSpacer + snapshot.rows.reduce((sum, row) => sum + row.size, 0) + snapshot.bottomSpacer).toBe(snapshot.totalSize);
  });
});

describe("anchoring", () => {
  test("chooses the topmost visible loaded row", () => {
    const virtual = engine([10, 10, 10], 10, 5, false);
    virtual.setLoaded(["row-1"]);
    expect(virtual.beforeMutation().anchor?.id).toBe("row-1");
  });
  test("falls back to the topmost visible skeleton", () => expect(engine([10, 10], 10, 5, false).beforeMutation().anchor?.id).toBe("row-0"));
  test("a height change above the anchor corrects scroll", () => {
    const virtual = engine([10, 10, 10], 10, 12);
    const result = mutate(virtual, () => virtual.measure("row-0", 20));
    expect(result.correction).toBeCloseTo(10, 8);
    expect(virtual.beforeMutation().anchor!.offset).toBeCloseTo(-2, 8);
  });
  test("a height change at the anchor does not move its top", () => {
    const virtual = engine([10, 10, 10], 10, 12);
    expect(mutate(virtual, () => virtual.measure("row-1", 20)).correction).toBe(0);
  });
  test("a height change below the anchor does not scroll", () => {
    const virtual = engine([10, 10, 10], 10, 2);
    expect(mutate(virtual, () => virtual.measure("row-2", 20)).correction).toBe(0);
  });
  test("prepend keeps the stable anchor", () => {
    const virtual = engine([10, 10, 10], 10, 12);
    const token = virtual.beforeMutation();
    virtual.setOutline([{ id: "new", kind: "7" }, ...items([10, 10, 10]).outline]);
    const result = virtual.afterMutation(token);
    expect(result.correction).toBeCloseTo(7, 8);
    expect(virtual.beforeMutation().anchor?.id).toBe("row-1");
  });
  test("deletion uses the nearest successor", () => {
    const virtual = engine([10, 10, 10], 10, 12);
    const token = virtual.beforeMutation();
    virtual.setOutline([items([10, 10, 10]).outline[0]!, items([10, 10, 10]).outline[2]!]);
    const result = virtual.afterMutation(token);
    expect(result.appliedCorrection).toBe(-2);
    expect(virtual.beforeMutation().anchor?.id).toBe("row-2");
  });
  test("correction clamps at the scroll bounds", () => {
    const virtual = engine([10, 10], 10, 5);
    const result = mutate(virtual, () => virtual.measure("row-0", 0));
    expect(result.scrollTop).toBe(0);
    expect(result.appliedCorrection).toBe(-5);
  });
});

describe("bottom and scroll semantics", () => {
  test("pinned append follows the new bottom", () => {
    const virtual = engine([10, 10], 10, 10);
    const token = virtual.beforeMutation();
    virtual.setOutline(items([10, 10, 10]).outline);
    expect(virtual.afterMutation(token)).toMatchObject({ followedBottom: true, scrollTop: 20 });
  });
  test("pinned resize follows the new bottom", () => {
    const virtual = engine([10, 10], 10, 10);
    expect(mutate(virtual, () => virtual.measure("row-1", 20))).toMatchObject({ followedBottom: true, scrollTop: 20 });
  });
  test("unpinned append never follows", () => {
    const virtual = engine([100, 100], 10, 0);
    const token = virtual.beforeMutation();
    virtual.setOutline(items([100, 100, 100]).outline);
    expect(virtual.afterMutation(token)).toMatchObject({ followedBottom: false, scrollTop: 0 });
  });
  test("programmatic scroll does not change pinned state", () => {
    const virtual = engine([100, 100], 10, 0);
    virtual.setViewport({ scrollTop: 190, size: 10, source: "programmatic" });
    expect(virtual.getSnapshot().pinned).toBe(false);
    expect(virtual.getSnapshot().programmatic).toBe(true);
  });
  test("user scroll changes pinned state", () => {
    const virtual = engine([100, 100], 10, 0);
    virtual.setViewport({ scrollTop: 190, size: 10, source: "user" });
    expect(virtual.getSnapshot().pinned).toBe(true);
  });
  test("container resize preserves an unpinned anchor", () => {
    const virtual = engine([100, 100], 10, 20);
    const token = virtual.beforeMutation();
    virtual.setViewport({ scrollTop: 20, size: 20, source: "programmatic" });
    expect(virtual.afterMutation(token).scrollTop).toBe(20);
  });
  test("scrollToId is tagged programmatic", () => {
    const virtual = engine([10, 10, 10], 5, 0);
    expect(virtual.scrollToId("row-2")).toBe(20);
    expect(virtual.getSnapshot().programmatic).toBe(true);
  });
  test("deferred corrections accumulate until scroll end", () => {
    const virtual = engine([10, 10, 10], 10, 12);
    const first = virtual.beforeMutation();
    virtual.measure("row-0", 15);
    expect(virtual.afterMutation(first, { deferCorrection: true })).toMatchObject({ jump: 0, pendingJump: 5, scrollTop: 12 });
    const second = virtual.beforeMutation();
    virtual.measure("row-0", 20);
    expect(virtual.afterMutation(second, { deferCorrection: true }).pendingJump).toBe(10);
    expect(virtual.flushPendingCorrection()).toMatchObject({ jump: 10, pendingJump: 0, scrollTop: 22 });
  });
  test("the correction scroll event is not user intent", () => {
    const virtual = engine([10, 10, 10], 10, 12);
    const result = mutate(virtual, () => virtual.measure("row-0", 20));
    virtual.setViewport({ scrollTop: result.scrollTop, size: 10, source: "user" });
    expect(virtual.getSnapshot()).toMatchObject({ programmatic: true, correctionEvent: true, pinned: false });
  });
  test("a later user scroll changes state normally", () => {
    const virtual = engine([10, 10, 10], 10, 12);
    const result = mutate(virtual, () => virtual.measure("row-0", 20));
    virtual.setViewport({ scrollTop: result.scrollTop, size: 10, source: "user" });
    virtual.setViewport({ scrollTop: 30, size: 10, source: "user" });
    expect(virtual.getSnapshot()).toMatchObject({ programmatic: false, correctionEvent: false, pinned: true });
  });
  test("a newer programmatic scroll supersedes an expected correction", () => {
    const virtual = engine([30, 30], 10, 0);
    virtual.setViewport({ scrollTop: 50, size: 10, source: "programmatic" });
    const token = virtual.beforeMutation();
    virtual.measure("row-0", 10);
    expect(virtual.afterMutation(token)).toMatchObject({ scrollTop: 30, jump: -20 });
    virtual.scrollToId("row-0");
    virtual.setViewport({ scrollTop: 30, size: 10, source: "user" });
    expect(virtual.getSnapshot()).toMatchObject({ pinned: true, programmatic: false, correctionEvent: false });
    const append = virtual.beforeMutation();
    virtual.setOutline([...items([10, 30]).outline, { id: "row-2", kind: "10:2" }]);
    expect(virtual.afterMutation(append)).toMatchObject({ followedBottom: true, scrollTop: 40 });
  });
  test("seeded scroll ownership always follows a user-pinned bottom", () => {
    let seed = 0x51a1e;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const virtual = engine([20, 20], 10, 30);
    let count = 2;
    for (let step = 0; step < 200; step++) {
      const before = virtual.beforeMutation();
      virtual.measure("row-0", 10 + Math.floor(random() * 20));
      virtual.afterMutation(before);
      virtual.scrollToId(random() < 0.5 ? "row-0" : `row-${count - 1}`);
      if (random() < 0.5) virtual.flushPendingCorrection();
      const bottom = virtual.getSnapshot().totalSize - 10;
      virtual.setViewport({ scrollTop: bottom, size: 10, source: "user" });
      expect(virtual.getSnapshot().pinned).toBe(true);
      const append = virtual.beforeMutation();
      const outline = Array.from({ length: ++count }, (_, index) => ({ id: `row-${index}`, kind: index === 0 ? "20:0" : `10:${index}` }));
      virtual.setOutline(outline);
      expect(virtual.afterMutation(append).followedBottom).toBe(true);
    }
  });
  test("shift mode keeps distance from the end on prepend", () => {
    const virtual = engine([10, 10, 10], 10, 5);
    const token = virtual.beforeMutation({ mode: "shift" });
    virtual.setOutline([{ id: "older", kind: "7" }, ...items([10, 10, 10]).outline]);
    expect(virtual.afterMutation(token)).toMatchObject({ scrollTop: 12, jump: 7 });
  });
});

describe("observable snapshots", () => {
  test("keeps the same snapshot reference until a mutation", () => {
    const virtual = engine([10]);
    const snapshot = virtual.getSnapshot();
    expect(virtual.getSnapshot()).toBe(snapshot);
    virtual.measure("row-0", 11);
    expect(virtual.getSnapshot()).not.toBe(snapshot);
    expect(virtual.getSnapshot()).toBe(virtual.getSnapshot());
  });
  test("replaces the snapshot for a notified mutation even when values match", () => {
    const virtual = engine([10]);
    const snapshot = virtual.getSnapshot();
    virtual.setViewport({ scrollTop: 0, size: 100, source: "user" });
    expect(virtual.getSnapshot()).not.toBe(snapshot);
  });
});

describe("structured action log and traces", () => {
  test("actions have monotonic sequence and time", () => {
    const actions = engine([10]).getActions();
    expect(actions.every((action, index) => action.sequence === index + 1 && action.time === action.sequence)).toBe(true);
  });
  test("the action log keeps only 2,000 records", () => {
    const virtual = engine([10]);
    for (let index = 0; index < 2_100; index++) virtual.setViewport({ scrollTop: 0, size: 10, source: "programmatic" });
    const actions = virtual.getActions();
    expect(actions).toHaveLength(2_000);
    expect(actions[0]!.sequence).toBeGreaterThan(1);
  });
  test("subscriptions stop after unsubscribe or destroy", () => {
    const virtual = engine([10]);
    let calls = 0;
    const unsubscribe = virtual.subscribe(() => calls++);
    virtual.measure("row-0", 11);
    unsubscribe();
    virtual.measure("row-0", 12);
    virtual.subscribe(() => calls++);
    virtual.destroy();
    virtual.measure("row-0", 13);
    expect(calls).toBe(1);
  });
  test("seeded random trace preserves every invariant", () => {
    let seed = 42;
    const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
    const outline = items(new Array(400).fill(10)).outline;
    const virtual = createVirtualizer({ estimateSize: () => 10, overscan: 200 });
    virtual.setOutline(outline);
    virtual.setLoaded(outline.filter((_, index) => index % 3 === 0).map(({ id }) => id));
    virtual.setViewport({ scrollTop: 0, size: 100, source: "user" });
    for (let step = 0; step < 2_000; step++) {
      const token = virtual.beforeMutation();
      const index = Math.floor(random() * outline.length);
      virtual.measure(outline[index]!.id, random() * 40);
      virtual.setViewport({ scrollTop: random() * virtual.getSnapshot().totalSize, size: 100 + random() * 400, source: step % 7 ? "programmatic" : "user" });
      virtual.afterMutation(token);
      const snapshot = virtual.getSnapshot();
      expect(snapshot.totalSize).toBeGreaterThanOrEqual(0);
      expect(new Set(snapshot.rows.map(({ id }) => id)).size).toBe(snapshot.rows.length);
      for (let row = 1; row < snapshot.rows.length; row++) expect(snapshot.rows[row]!.start).toBeGreaterThanOrEqual(snapshot.rows[row - 1]!.start);
      expect(snapshot.topSpacer + snapshot.rows.reduce((sum, item) => sum + item.size, 0) + snapshot.bottomSpacer).toBeCloseTo(snapshot.totalSize, 6);
      expect(Math.abs(virtual.beforeMutation().anchor?.offset ?? 0)).toBeLessThan(snapshot.viewportSize + 40);
    }
  });
});
