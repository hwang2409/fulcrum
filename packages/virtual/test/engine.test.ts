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
  test("full same-run rebuild keeps surviving unseen rows and adds only an exact suffix", () => {
    const virtual = createVirtualizer({ estimateSize: () => 10, bottomThreshold: 0 });
    virtual.setOutline(Array.from({ length: 5 }, (_, index) => ({ id: `row-${index}`, kind: "row" })));
    virtual.setLoaded("all");
    virtual.setViewport({ scrollTop: 0, size: 20, source: "user" });
    virtual.setOutline([]);
    virtual.setViewport({ scrollTop: 0, size: 20, source: "user" });
    virtual.setOutline(Array.from({ length: 2 }, (_, index) => ({ id: `row-${index}`, kind: "row" })));
    virtual.setFollow(false);
    virtual.setOutline(Array.from({ length: 7 }, (_, index) => ({ id: `row-${index}`, kind: "row" })));
    expect(virtual.getSnapshot().unseenCount).toBe(2);
    virtual.setOutline([
      { id: "row-0", kind: "row" },
      { id: "replacement", kind: "row" },
      ...Array.from({ length: 5 }, (_, index) => ({ id: `row-${index + 2}`, kind: "row" })),
    ]);
    expect(virtual.getSnapshot().unseenCount).toBe(2);
    virtual.scrollToEnd();
    virtual.setOutline(Array.from({ length: 8 }, (_, index) => ({ id: `row-${index}`, kind: "row" })));
    expect(virtual.getSnapshot().unseenCount).toBe(0);
  });

  test("invalidating changed-row measurements removes their cached size", () => {
    const virtual = createVirtualizer({ estimateSize: () => 10 });
    virtual.setOutline([{ id: "changed", kind: "row" }, { id: "stable", kind: "row" }]);
    virtual.measure("changed", 30);
    virtual.measure("stable", 20);
    virtual.invalidateMeasurements(["changed"]);
    expect(virtual.snapshotCache().sizes).toEqual([["stable", 20]]);
    expect(virtual.getSnapshot().totalSize).toBe(30);
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
  test("a stable reader anchor stays owned after progressive replay returns it", () => {
    const virtual = engine([10, 10, 10, 10], 10, 12);
    let token = { ...virtual.beforeMutation(), anchor: { id: "row-2", index: 2, offset: 8 } };
    virtual.setOutline(items([10, 10, 10, 10]).outline.slice(3));
    virtual.afterMutation(token, { recoveryComplete: false });

    token = virtual.beforeMutation();
    virtual.setOutline(items([10, 10, 10, 10]).outline);
    virtual.afterMutation(token);
    token = virtual.beforeMutation();
    virtual.measure("row-1", 20);
    virtual.afterMutation(token);
    expect(virtual.getSnapshot().scrollTop).toBe(22);
  });
  test("a later progressive page cannot replace a held reader anchor", () => {
    const virtual = engine([10, 10, 10, 10, 10], 10, 12);
    const outline = items([10, 10, 10, 10, 10]).outline;
    const original = { ...virtual.beforeMutation(), anchor: { id: "row-2", index: 2, offset: 8 } };
    virtual.setOutline(outline.slice(3));
    expect(virtual.afterMutation(original, { recoveryComplete: false }).recoveryPending).toBe(true);

    virtual.setViewport({ scrollTop: 0, size: 10, source: "programmatic" });
    const laterPage = virtual.beforeMutation();
    virtual.setOutline([outline[1]!, outline[3]!, outline[4]!]);
    expect(virtual.afterMutation(laterPage, { recoveryComplete: false }).recoveryPending).toBe(true);

    const restored = virtual.beforeMutation();
    virtual.setOutline(outline);
    expect(virtual.afterMutation(restored, { recoveryComplete: true })).toMatchObject({ recoveryPending: false, scrollTop: 12 });
  });
  test("progressive recovery waits for completion before using the nearest surviving row", () => {
    const virtual = engine([10, 10, 10, 10], 10, 12);
    const token = { ...virtual.beforeMutation(), anchor: { id: "row-2", index: 2, offset: 8 } };
    virtual.setOutline(items([10, 10, 10, 10]).outline.slice(3));
    expect(virtual.afterMutation(token, { recoveryComplete: false })).toMatchObject({
      scrollTop: 12,
      jump: 0,
      recoveryPending: true,
    });
    expect(virtual.afterMutation(token, { recoveryComplete: true })).toMatchObject({
      recoveryPending: false,
      scrollTop: 0,
    });
  });
  test("correction clamps at the scroll bounds", () => {
    const virtual = engine([10, 10], 10, 5);
    const result = mutate(virtual, () => virtual.measure("row-0", 0));
    expect(result.scrollTop).toBe(0);
    expect(result.appliedCorrection).toBe(-5);
  });
});

describe("bottom and scroll semantics", () => {
  test("a scroll that changes the mounted range notifies", () => {
    const virtual = engine(new Array(100).fill(10), 10, 0);
    virtual.getSnapshot();
    let notifications = 0;
    virtual.subscribe(() => notifications++);
    virtual.setViewport({ scrollTop: 500, size: 10, source: "user" });
    expect(notifications).toBe(1);
    expect(virtual.getSnapshot().range.start).toBeGreaterThan(0);
  });
  test("a viewport change that pins and clears unseen rows notifies", () => {
    const virtual = engine([100, 100], 10, 0);
    virtual.setOutline(items([100, 100, 100]).outline);
    expect(virtual.getSnapshot()).toMatchObject({ pinned: false, unseenCount: 1 });
    let notifications = 0;
    virtual.subscribe(() => notifications++);
    virtual.setViewport({ scrollTop: 290, size: 10, source: "user" });
    expect(notifications).toBe(1);
    expect(virtual.getSnapshot()).toMatchObject({ pinned: true, unseenCount: 0 });
  });
  test("an observed scroll moves the range without changing follow, unseen rows, or a pending correction", () => {
    const unpinned = engine([100, 100], 10, 0);
    unpinned.setOutline(items([100, 100, 100]).outline);
    let notifications = 0;
    unpinned.subscribe(() => notifications++);
    unpinned.setViewport({ scrollTop: 290, size: 10, source: "observe" });
    expect(notifications).toBe(1);
    expect(unpinned.getSnapshot()).toMatchObject({ scrollTop: 290, visible: { start: 2, end: 3 }, pinned: false, unseenCount: 1 });

    const pinned = engine([10, 10, 10], 10, 20);
    pinned.setViewport({ scrollTop: 0, size: 10, source: "observe" });
    expect(pinned.getSnapshot()).toMatchObject({ scrollTop: 0, visible: { start: 0, end: 1 }, pinned: true });

    const corrected = engine([10, 10, 10], 10, 12);
    const result = mutate(corrected, () => corrected.measure("row-0", 20));
    corrected.setViewport({ scrollTop: 5, size: 10, source: "observe" });
    corrected.setViewport({ scrollTop: result.scrollTop, size: 10, source: "user" });
    expect(corrected.getSnapshot(), "an observation must not consume the expected correction").toMatchObject({ correctionEvent: true, pinned: false });
  });
  test("an observed scroll keeps a missing reader anchor owned", () => {
    const outline = Array.from({ length: 20 }, (_, index) => ({ id: `row-${index}`, kind: "10" }));
    const virtual = createVirtualizer({ estimateSize: Number, bottomThreshold: 0 });
    virtual.setOutline(outline);
    virtual.setLoaded("all");
    virtual.setViewport({ scrollTop: 112, size: 10, source: "user" });
    let token = { ...virtual.beforeMutation(), anchor: { id: "row-11", index: 11, offset: -2 } };
    virtual.setOutline(outline.slice(12));
    virtual.afterMutation(token, { recoveryComplete: false });
    virtual.setViewport({ scrollTop: 30, size: 10, source: "observe" });
    token = virtual.beforeMutation();
    virtual.setOutline(outline);
    virtual.afterMutation(token);
    expect(virtual.getSnapshot().scrollTop, "the replayed anchor row must restore the reader position").toBe(112);
  });
  test("an unchanged observation does not notify", () => {
    const virtual = engine(new Array(100).fill(10), 10, 500);
    const snapshot = virtual.getSnapshot();
    let notifications = 0;
    virtual.subscribe(() => notifications++);
    virtual.setViewport({ scrollTop: 500, size: 10, source: "observe" });
    expect(notifications, "an observation that changes no range input must not re-render").toBe(0);
    expect(virtual.getSnapshot()).toBe(snapshot);
  });
  test("an observation at the same position notifies when a range input changed, and content growth is current without it", () => {
    const resized = engine(new Array(100).fill(10), 10, 500);
    const before = resized.getSnapshot().range;
    let notifications = 0;
    resized.subscribe(() => notifications++);
    resized.setViewport({ scrollTop: 500, size: 30, source: "observe" });
    expect(notifications, "a viewport size change decides the range").toBe(1);
    expect(resized.getSnapshot().range).not.toEqual(before);

    // Content shrinks below the stored position; the same reported position clamps to the new end.
    const shrunk = engine(new Array(100).fill(10), 10, 990);
    shrunk.setOutline(items(new Array(50).fill(10)).outline);
    const stale = shrunk.getSnapshot();
    notifications = 0;
    shrunk.subscribe(() => notifications++);
    shrunk.setViewport({ scrollTop: 990, size: 10, source: "observe" });
    expect(notifications, "a content size change that moves the clamped position decides the range").toBe(1);
    expect(shrunk.getSnapshot()).toMatchObject({ scrollTop: 490, visible: { start: 49, end: 50 } });
    expect(shrunk.getSnapshot().range).not.toEqual(stale.range);

    // Content that grows at the same position notifies through measure(), so the snapshot is current before the
    // observation; the observation then adds no second notification.
    const grown = engine(new Array(100).fill(10), 10, 500);
    notifications = 0;
    grown.subscribe(() => notifications++);
    grown.measure("row-50", 40);
    expect(notifications, "the growth itself notifies").toBe(1);
    const sizes = new Array(100).fill(10);
    sizes[50] = 40;
    const fresh = engine(sizes, 10, 500).getSnapshot();
    expect(grown.getSnapshot()).toMatchObject({ totalSize: 1030, range: fresh.range, visible: fresh.visible, bottomSpacer: fresh.bottomSpacer });
    grown.setViewport({ scrollTop: 500, size: 10, source: "observe" });
    expect(notifications, "an observation after the growth adds no second notification").toBe(1);
    expect(grown.getSnapshot()).toMatchObject({ totalSize: 1030, range: fresh.range, visible: fresh.visible });
  });
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
  test.each([
    ["user", 1, true], ["user", 4, true], ["user", 4.01, false], ["user", 5, false],
    ["programmatic", 1, true], ["programmatic", 4, true], ["programmatic", 4.01, false], ["programmatic", 5, false],
  ] as const)("%s position %.2f px from the bottom sets follow to %s", (source, distance, following) => {
    const virtual = createVirtualizer({ estimateSize: () => 100 });
    virtual.setOutline(items([100, 100]).outline);
    virtual.setLoaded("all");
    virtual.setViewport({ scrollTop: 190 - distance, size: 10, source });
    expect(virtual.getSnapshot().pinned).toBe(following);
    expect(virtual.getSnapshot().unseenCount).toBe(0);
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
  test.each([[3, true], [5, false]] as const)("scrollToId %d px from the bottom sets follow to %s", (gap, following) => {
    const virtual = createVirtualizer({ estimateSize: () => 100 });
    virtual.setOutline(items([100, 100]).outline);
    virtual.setLoaded("all");
    virtual.setViewport({ scrollTop: 0, size: 10, source: "observe" });
    virtual.scrollToId("row-1", gap - 90);
    expect(virtual.getSnapshot().pinned).toBe(following);
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
  test("detaching settles a deferred correction without retaining scroll ownership", () => {
    const virtual = engine([10, 10, 10], 10, 12);
    const token = virtual.beforeMutation();
    virtual.measure("row-0", 20);
    virtual.afterMutation(token, { deferCorrection: true });
    let notifications = 0;
    virtual.subscribe(() => notifications++);
    const settled = virtual.flushPendingCorrection(false, true);
    expect(settled).toMatchObject({ scrollTop: 22, pendingJump: 0 });
    expect(notifications).toBe(0);
    virtual.setViewport({ scrollTop: settled.scrollTop, size: 10, source: "user" });
    expect(virtual.getSnapshot()).toMatchObject({ programmatic: false, correctionEvent: false });
  });
  test("the correction scroll event is not user intent", () => {
    const virtual = engine([10, 10, 10], 10, 12);
    const result = mutate(virtual, () => virtual.measure("row-0", 20));
    virtual.setViewport({ scrollTop: result.scrollTop, size: 10, source: "user" });
    expect(virtual.getSnapshot()).toMatchObject({ programmatic: true, correctionEvent: true, pinned: false });
  });
  test("a correction rounded to a device pixel is not user intent", () => {
    const virtual = engine([10, 10, 10], 10, 12);
    const result = mutate(virtual, () => virtual.measure("row-0", 20.5));
    virtual.setViewport({ scrollTop: Math.round(result.scrollTop), size: 10, source: "user" });
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
  for (const [name, overlap] of [
    ["setLoaded", (virtual: ReturnType<typeof engine>) => virtual.setLoaded(["row-0", "row-1"])],
    ["measure", (virtual: ReturnType<typeof engine>) => virtual.measure("row-1", 30)],
    ["setOutline", (virtual: ReturnType<typeof engine>) => virtual.setOutline(items([10, 30]).outline)],
  ] as const) {
    test(`${name} preserves an in-flight correction`, () => {
      const virtual = engine([30, 30], 10, 0);
      virtual.setViewport({ scrollTop: 50, size: 10, source: "programmatic" });
      const correction = virtual.beforeMutation();
      virtual.measure("row-0", 10);
      expect(virtual.afterMutation(correction)).toMatchObject({ scrollTop: 30, jump: -20 });
      overlap(virtual);
      virtual.setViewport({ scrollTop: 30, size: 10, source: "user" });
      expect(virtual.getSnapshot()).toMatchObject({ pinned: true, programmatic: true, correctionEvent: true });
      const append = virtual.beforeMutation();
      virtual.setOutline([...items([10, 30]).outline, { id: "row-2", kind: "10:2" }]);
      expect(virtual.afterMutation(append)).toMatchObject({ followedBottom: true, scrollTop: 40 });
    });
  }
  test("moves an expected correction with content and scroll-bound changes", () => {
    const virtual = engine([30, 30, 100], 10, 0);
    virtual.setViewport({ scrollTop: 50, size: 10, source: "programmatic" });
    virtual.measure("row-0", 40);
    virtual.setViewport({ scrollTop: 60, size: 10, source: "user" });
    expect(virtual.getSnapshot()).toMatchObject({ pinned: false, programmatic: true, correctionEvent: true });

    virtual.setViewport({ scrollTop: 150, size: 10, source: "programmatic" });
    virtual.setOutline([{ id: "next-0", kind: "20" }, { id: "next-1", kind: "20" }]);
    virtual.setViewport({ scrollTop: 30, size: 10, source: "user" });
    expect(virtual.getSnapshot()).toMatchObject({ pinned: false, programmatic: true, correctionEvent: true });
  });
  test("biased scroll ownership interleavings preserve user intent", () => {
    for (let seed = 1; seed <= 100; seed++) {
      let state = seed;
      const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
      for (let trace = 0; trace < 20; trace++) {
        const virtual = engine([30, 30], 10, 0);
        virtual.setViewport({ scrollTop: 50, size: 10, source: "programmatic" });
        const correction = virtual.beforeMutation();
        virtual.measure("row-0", 10);
        expect(virtual.afterMutation(correction)).toMatchObject({ scrollTop: 30, jump: -20 });

        const mutations = [
          () => virtual.setLoaded(random() < 0.5 ? ["row-0"] : ["row-0", "row-1"]),
          () => virtual.measure("row-1", 30),
          () => virtual.setOutline(items([10, 30]).outline),
          () => virtual.setViewport({ scrollTop: 30, size: 10 + Math.floor(random() * 3), source: "programmatic" }),
        ];
        for (let index = mutations.length - 1; index > 0; index--) {
          const swap = Math.floor(random() * (index + 1));
          [mutations[index], mutations[swap]] = [mutations[swap]!, mutations[index]!];
        }
        for (const mutation of mutations.slice(0, 1 + Math.floor(random() * mutations.length))) mutation!();

        const event = Math.floor(random() * 4);
        let lastUserPinned = false;
        if (event === 0) {
          virtual.setViewport({ scrollTop: 30, size: virtual.getSnapshot().viewportSize, source: "user" });
          expect(virtual.getSnapshot()).toMatchObject({ correctionEvent: true, programmatic: true, pinned: true });
          lastUserPinned = true;
        } else if (event === 1) {
          virtual.flushPendingCorrection();
          virtual.setViewport({ scrollTop: 30, size: virtual.getSnapshot().viewportSize, source: "user" });
          expect(virtual.getSnapshot()).toMatchObject({ correctionEvent: false, programmatic: false, pinned: true });
          lastUserPinned = true;
        } else if (event === 2) {
          virtual.setViewport({ scrollTop: 0, size: virtual.getSnapshot().viewportSize, source: "programmatic" });
          virtual.setViewport({ scrollTop: 30, size: virtual.getSnapshot().viewportSize, source: "user" });
          expect(virtual.getSnapshot()).toMatchObject({ correctionEvent: false, programmatic: false, pinned: true });
          lastUserPinned = true;
          virtual.setViewport({ scrollTop: 0, size: virtual.getSnapshot().viewportSize, source: "user" });
          expect(virtual.getSnapshot()).toMatchObject({ correctionEvent: true, programmatic: true, pinned: true });
        } else {
          virtual.setViewport({ scrollTop: 30, size: virtual.getSnapshot().viewportSize, source: "user" });
          expect(virtual.getSnapshot().correctionEvent).toBe(true);
          virtual.setViewport({ scrollTop: 0, size: virtual.getSnapshot().viewportSize, source: "user" });
          expect(virtual.getSnapshot()).toMatchObject({ correctionEvent: false, programmatic: false, pinned: false });
        }

        const append = virtual.beforeMutation();
        virtual.setOutline([...items([10, 30]).outline, { id: "row-2", kind: "10:2" }]);
        expect(virtual.afterMutation(append).followedBottom).toBe(lastUserPinned);
      }
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

describe("incremental outline updates", () => {
  test("append and prepend hints stay equal to full rebuilds through random structural changes", () => {
    let seed = 0x51f15e;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    let serial = 0;
    let outline: OutlineItem[] = [];
    const expectedUnseen = new Set<string>();
    const incremental = createVirtualizer({ estimateSize: (kind) => Number(kind), overscan: 20 });
    const rebuilt = createVirtualizer({ estimateSize: (kind) => Number(kind), overscan: 20 });
    incremental.setViewport({ scrollTop: 0, size: 80, source: "user" });
    rebuilt.setViewport({ scrollTop: 0, size: 80, source: "user" });
    for (let step = 0; step < 300; step++) {
      const count = 1 + Math.floor(random() * 4);
      const added = Array.from({ length: count }, () => ({ id: `random-${serial++}`, kind: String(5 + Math.floor(random() * 40)) }));
      const operation = Math.floor(random() * 5);
      const wasPinned = incremental.getSnapshot().pinned;
      const from = outline;
      if (operation < 2) {
        outline = [...outline, ...added];
        incremental.setOutline(outline, { from, splices: [{ index: from.length, deleteCount: 0, items: added }] });
        if (!wasPinned) for (const { id } of added) expectedUnseen.add(id);
      } else if (operation < 3) {
        outline = [...added, ...outline];
        incremental.setOutline(outline, { from, splices: [{ index: 0, deleteCount: 0, items: added }] });
      } else if (operation < 4 && from.length > 0) {
        // A fold: one row is replaced in place (or a row inserted in the middle), then another row goes.
        const index = Math.floor(random() * from.length);
        const deleteCount = Math.min(from.length - index, Math.floor(random() * 3));
        const insert = added.slice(0, 1);
        const between = from.slice();
        const replaced = between.splice(index, deleteCount, ...insert);
        const removeAt = Math.floor(random() * between.length);
        outline = between.slice();
        const [gone] = outline.splice(removeAt, 1);
        const replacedUnseen = replaced.some(({ id }) => expectedUnseen.has(id));
        for (const { id } of replaced) expectedUnseen.delete(id);
        if (!wasPinned && replacedUnseen) expectedUnseen.add(insert[0]!.id);
        expectedUnseen.delete(gone!.id);
        incremental.setOutline(outline, { from, splices: [{ index, deleteCount, items: insert }, { index: removeAt, deleteCount: 1, items: [] }] });
      } else {
        const kept = outline.filter(() => random() > 0.2);
        outline = [...kept.slice(0, Math.floor(kept.length / 2)), ...added, ...kept.slice(Math.floor(kept.length / 2))];
        incremental.setOutline(outline);
        const ids = new Set(outline.map(({ id }) => id));
        for (const id of expectedUnseen) if (!ids.has(id)) expectedUnseen.delete(id);
      }
      rebuilt.setOutline(outline);
      // Measured rows keep their size through edits; per-kind medians must agree with a rebuild's.
      if (outline.length && random() < 0.3) {
        const { id } = outline[Math.floor(random() * outline.length)]!;
        const size = 5 + Math.floor(random() * 60);
        incremental.measure(id, size);
        rebuilt.measure(id, size);
      }
      const max = Math.max(0, rebuilt.getSnapshot().totalSize - 80);
      const top = random() * max;
      incremental.setViewport({ scrollTop: top, size: 80, source: "user" });
      rebuilt.setViewport({ scrollTop: top, size: 80, source: "user" });
      const { unseenCount, ...incrementalLayout } = incremental.getSnapshot();
      const { unseenCount: _rebuiltUnseen, ...rebuiltLayout } = rebuilt.getSnapshot();
      expect(incrementalLayout).toEqual(rebuiltLayout);
      if (incremental.getSnapshot().pinned) expectedUnseen.clear();
      expect(unseenCount).toBe(expectedUnseen.size);
    }
  });

  test("only surviving end appends remain unseen after prepends and replacements", () => {
    const virtual = createVirtualizer({ estimateSize: () => 10 });
    const current = Array.from({ length: 100 }, (_, index) => ({ id: `row-${index}`, kind: "x" }));
    virtual.setOutline(current);
    virtual.setViewport({ scrollTop: 0, size: 10, source: "user" });

    const history = Array.from({ length: 500 }, (_, index) => ({ id: `history-${index}`, kind: "x" }));
    const older = [...history, ...current];
    virtual.setOutline(older, { from: current, splices: [{ index: 0, deleteCount: 0, items: history }] });
    expect(virtual.getSnapshot().unseenCount).toBe(0);

    const latest = [{ id: "latest-1", kind: "x" }, { id: "latest-2", kind: "x" }];
    virtual.setOutline([...older, ...latest], { from: older, splices: [{ index: older.length, deleteCount: 0, items: latest }] });
    expect(virtual.getSnapshot().unseenCount).toBe(2);

    virtual.setOutline([...current, latest[1]!]);
    expect(virtual.getSnapshot().unseenCount).toBe(1);
    virtual.setOutline(current);
    expect(virtual.getSnapshot().unseenCount).toBe(0);
  });

  test("a fold replaces one row in place: no rebuild, every other measured size kept, the reading position held", () => {
    let estimates = 0;
    const virtual = createVirtualizer({ estimateSize: () => (estimates++, 40), overscan: 0 });
    const outline = Array.from({ length: 10_000 }, (_, index) => ({ id: `row-${index}`, kind: index === 5_000 ? "approval" : "row" }));
    outline.push({ id: "tool", kind: "tool" });
    virtual.setOutline(outline);
    virtual.setLoaded("all");
    virtual.setViewport({ scrollTop: 0, size: 0, source: "user" });
    for (let index = 4_990; index < 5_010; index++) virtual.measure(`row-${index}`, 10 + index % 7);
    virtual.setViewport({ scrollTop: 0, size: 200, source: "user" });
    virtual.scrollToId("row-5005");
    virtual.setViewport({ scrollTop: virtual.getSnapshot().scrollTop, size: 200, source: "user" });
    const before = virtual.getSnapshot();
    const sizes = new Map(before.rows.map(({ id, size }) => [id, size]));
    const anchorTop = before.rows.find(({ id }) => id === "row-5005")!.start - before.scrollTop;
    estimates = 0;
    // The tool row (last) folds into the approval's place: delete it at the end, replace the approval with it.
    const folded = outline.slice(0, -1);
    folded[5_000] = { id: "tool", kind: "tool" };
    const result = mutate(virtual, () => virtual.setOutline(folded, {
      from: outline,
      splices: [{ index: outline.length - 1, deleteCount: 1, items: [] }, { index: 5_000, deleteCount: 1, items: [{ id: "tool", kind: "tool" }] }],
    }));
    // A rebuild estimates every unmeasured row again (about 10,000 calls); a replace estimates only what it adds.
    expect(estimates).toBeLessThanOrEqual(1);
    const after = virtual.getSnapshot();
    for (const row of after.rows) if (row.id !== "tool" && sizes.has(row.id)) expect(row.size).toBe(sizes.get(row.id)!);
    expect(after.rows.find(({ id }) => id === "row-5005")!.start - after.scrollTop).toBeCloseTo(anchorTop, 6);
    expect(result.scrollTop).toBe(after.scrollTop);
    // The tool row keeps its estimate and moves; the measured approval row goes.
    expect(after.totalSize).toBe(before.totalSize - (10 + 5_000 % 7));
  });

  test("an update from an outline the engine did not receive rebuilds from the full outline", () => {
    const virtual = createVirtualizer({ estimateSize: () => 10 });
    const first = [{ id: "a", kind: "x" }];
    const missed = [...first, { id: "b", kind: "x" }];
    virtual.setOutline(first);
    virtual.setOutline([...missed, { id: "c", kind: "x" }], { from: missed, splices: [{ index: 2, deleteCount: 0, items: [{ id: "c", kind: "x" }] }] });
    expect(virtual.getSnapshot().totalSize).toBe(30);
  });

  test("a bad splice throws and leaves the layout whole", () => {
    const virtual = createVirtualizer({ estimateSize: () => 10 });
    const outline = [{ id: "a", kind: "x" }, { id: "b", kind: "x" }];
    virtual.setOutline(outline);
    expect(() => virtual.setOutline([{ id: "b", kind: "x" }, { id: "b", kind: "x" }], { from: outline, splices: [{ index: 0, deleteCount: 1, items: [{ id: "b", kind: "x" }] }] })).toThrow("unique");
    expect(() => virtual.setOutline(outline, { from: outline, splices: [{ index: 3, deleteCount: 0, items: [] }] })).toThrow("outside");
    expect(() => virtual.setOutline(outline, { from: outline, splices: [{ index: 0, deleteCount: 1, items: [] }] })).toThrow("does not match");
    virtual.setViewport({ scrollTop: 0, size: 100, source: "user" });
    expect(virtual.getSnapshot().rows.map(({ id }) => id)).toEqual(["a", "b"]);
  });

  test("a later bad splice after an applied one makes the next update rebuild, never edit a half-edited layout", () => {
    const virtual = createVirtualizer({ estimateSize: () => 10 });
    const outline = [{ id: "a", kind: "x" }, { id: "b", kind: "x" }];
    virtual.setOutline(outline);
    const next = [{ id: "c", kind: "x" }, { id: "a", kind: "x" }, { id: "b", kind: "x" }, { id: "c", kind: "x" }];
    expect(() => virtual.setOutline(next, { from: outline, splices: [{ index: 0, deleteCount: 0, items: [{ id: "c", kind: "x" }] }, { index: 3, deleteCount: 0, items: [{ id: "c", kind: "x" }] }] })).toThrow("unique");
    const good = [{ id: "a", kind: "x" }, { id: "b", kind: "x" }, { id: "d", kind: "x" }];
    virtual.setOutline(good, { from: outline, splices: [{ index: 2, deleteCount: 0, items: [{ id: "d", kind: "x" }] }] });
    virtual.setViewport({ scrollTop: 0, size: 100, source: "user" });
    expect(virtual.getSnapshot().rows.map(({ id }) => id)).toEqual(["a", "b", "d"]);
  });

  test("all-loaded mode follows incremental outline updates", () => {
    const virtual = createVirtualizer({ estimateSize: () => 10 });
    const outline = [{ id: "a", kind: "x" }];
    virtual.setOutline(outline);
    virtual.setLoaded("all");
    virtual.setOutline([...outline, { id: "b", kind: "x" }], { from: outline, splices: [{ index: 1, deleteCount: 0, items: [{ id: "b", kind: "x" }] }] });
    virtual.setViewport({ scrollTop: 0, size: 20, source: "user" });
    expect(virtual.getSnapshot().rows.map((row) => row.loaded)).toEqual([true, true]);
  });
});

test("explicit upward intent releases follow until the user reaches the exact bottom", () => {
  const virtual = engine([100, 100], 10, 190);
  virtual.setFollow(false);
  virtual.setViewport({ scrollTop: 189, size: 10, source: "user" });
  expect(virtual.getSnapshot().pinned).toBe(false);
  const two = [{ id: "row-0", kind: "100:0" }, { id: "row-1", kind: "100:1" }];
  virtual.setOutline(two);
  virtual.setOutline([...two, { id: "row-2", kind: "100:2" }], { from: two, splices: [{ index: 2, deleteCount: 0, items: [{ id: "row-2", kind: "100:2" }] }] });
  expect(virtual.getSnapshot().unseenCount).toBe(1);
  virtual.setViewport({ scrollTop: 290, size: 10, source: "user" });
  expect(virtual.getSnapshot()).toMatchObject({ pinned: true, unseenCount: 0 });
});

test("measurement growth keeps a pinned viewport at the bottom", () => {
  const virtual = engine([100, 100], 100, 100);
  virtual.setFollow(true);
  const token = virtual.beforeMutation();
  virtual.measure("row-1", 200);
  virtual.afterMutation(token);
  expect(virtual.getSnapshot()).toMatchObject({ pinned: true, scrollTop: 200 });
});

test("a host follow request re-pins an unpinned viewport", () => {
  const virtual = engine([100, 100], 100, 0);
  virtual.setFollow(false);
  expect(virtual.requestFollow()).toBe(100);
  expect(virtual.getSnapshot()).toMatchObject({ pinned: true, scrollTop: 100, unseenCount: 0 });
});

test("scrollToEnd and scrollToId notify with follow mode already updated", () => {
  const virtual = engine(Array(50).fill(20), 100, 0);
  virtual.setViewport({ scrollTop: 0, size: 100, source: "user" });
  const seen: boolean[] = [];
  virtual.subscribe(() => seen.push(virtual.getSnapshot().pinned));
  virtual.scrollToEnd();
  virtual.scrollToId("row-10");
  expect(seen).toEqual([true, false]);
});

test("releasing follow clears the last correction's jump, so the adapter does not undo the user's scroll", () => {
  const virtual = engine(Array(50).fill(20), 100, 900);
  virtual.scrollToEnd();
  mutate(virtual, () => virtual.measure("row-49", 60));
  expect(Math.abs(virtual.getSnapshot().jump)).toBeGreaterThan(0);
  virtual.setFollow(false);
  expect(virtual.getSnapshot().jump).toBe(0);
});
