import { expect, test } from "bun:test";
import { heapStats } from "bun:jsc";
import { createRunStore } from "../src/index.js";

const DELTAS = 50_000;
const DELTA = "x".repeat(100);
const FINAL_TEXT_BYTES = DELTAS * DELTA.length;
const RETAINED_HEAP_LIMIT = FINAL_TEXT_BYTES * 3 + 8_000_000;

test("ending history releases accepted event objects and later dispatches are not retained", () => {
  const store = createRunStore((flush) => flush());
  let first: WeakRef<object>;
  let after: WeakRef<object>;
  (() => {
    store.beginHistory();
    const retained = { type: "usage" as const, usage: { input: 1, output: 1 } };
    first = new WeakRef(retained);
    store.dispatch(retained);
    store.endHistory();
    const ordinary = { type: "usage" as const, usage: { input: 2, output: 2 } };
    after = new WeakRef(ordinary);
    store.dispatch(ordinary);
  })();

  Bun.gc(true);
  expect(first!.deref()).toBeUndefined();
  expect(after!.deref()).toBeUndefined();
  expect(store.getState().usage).toEqual({ input: 3, output: 3 });
});

test(
  "frame reads do not retain historical full strings",
  () => {
    Bun.gc(true);
    const baseline = heapStats().heapSize;
    const store = createRunStore(() => {});

    for (let i = 0; i < DELTAS; i++) {
      store.dispatch({
        type: "message_delta",
        message_id: "memory",
        delta: DELTA,
      });
      if ((i + 1) % 4 === 0) {
        const item = store.getItem("message:memory");
        if (
          item?.type !== "message" ||
          item.text?.length !== (i + 1) * DELTA.length ||
          item.text.at(-1) !== "x"
        )
          throw new Error("stream read did not include every delta");
      }
    }

    Bun.gc(true);
    const retained = heapStats().heapSize - baseline;
    store.dispose();

    expect(retained).toBeLessThan(RETAINED_HEAP_LIMIT);
  },
  30_000,
);

test("held stream versions that were each read do not each pin a full string", () => {
  const deltas = 5_000;
  const finalTextBytes = deltas * DELTA.length;
  Bun.gc(true);
  const baseline = heapStats().heapSize;
  const store = createRunStore(() => {});
  // A renderer that keeps every snapshot it drew. A per-version text cache would retain about 1,667 strings averaging
  // 250 KB here (over 400 MB); one cache per stream retains the newest string only. Each read is flattened (`at(-1)`)
  // as drawing does: an unflattened rope shares the chain's storage and hides a per-version cache.
  const held: unknown[] = [];

  for (let i = 0; i < deltas; i++) {
    store.dispatch({ type: "message_delta", message_id: "held", delta: DELTA });
    if ((i + 1) % 3 === 0) {
      const item = store.getItem("message:held");
      if (item?.type !== "message" || item.text?.length !== (i + 1) * DELTA.length || item.text.at(-1) !== "x")
        throw new Error("stream read did not include every delta");
      held.push(item);
    }
  }

  Bun.gc(true);
  const retained = heapStats().heapSize - baseline;
  expect(held).toHaveLength(Math.floor(deltas / 3));
  store.dispose();

  expect(retained).toBeLessThan(finalTextBytes * 3 + 8_000_000);
}, 30_000);

// Runs rope-probe.ts in a child process: a heap snapshot leaves JSC slower for the rest of the process.
type Probe = { ropesPerAppend: number; joinedPerChar: number; stringBytesPerChar: number };
function probe(...args: (string | number)[]): Probe {
  const child = Bun.spawnSync([process.execPath, new URL("./rope-probe.ts", import.meta.url).pathname, ...args.map(String)], { timeout: 60_000 });
  if (child.exitCode !== 0) throw new Error(`rope probe failed: ${child.stderr.toString()}`);
  return JSON.parse(child.stdout.toString()) as Probe;
}

// Each read's text is a rope node over the previous read's text; a cache that only extends keeps one node per read for
// the stream's life (20 B each in V8). The rebuild keeps those of the reads since the last 1/8 of growth: with equal
// appends from empty, at most 1/9 per append. Counted in a heap snapshot (child process), not by heap totals.
test.each([[4_000, 100], [20_000, 20]])("a stream read after each of %i appends of %i characters keeps few rope nodes", (appends, size) => {
  const { ropesPerAppend, joinedPerChar } = probe(appends, size);
  console.log(`${appends}x${size}: ${ropesPerAppend.toFixed(4)} rope nodes per append, ${joinedPerChar.toFixed(2)} characters joined per added one`);
  // Without the rebuild: 1. With it: at most 1/9; the limit sits at their geometric middle.
  expect(ropesPerAppend).toBeLessThanOrEqual(1 / 3);
  // A read joins its new text (1), a run compaction its run (1), and the rebuilds at most 9 per added character.
  expect(joinedPerChar).toBeLessThanOrEqual(11);
}, 60_000);

// #99's renderer, at 2 MB, measured per byte of text so no constant hides a cost that scales with it: holding every
// read snapshot keeps the chunks and run joins (about 3.2 bytes of strings per byte of text). A rebuild whose flat copy
// a chunk keeps adds one full copy per rebuild that any held snapshot reaches (about 11.4).
test("holding every read snapshot of a 2 MB stream keeps strings in proportion to its text", () => {
  const { stringBytesPerChar } = probe(20_000, 100, "held");
  console.log(`held 20000x100: ${stringBytesPerChar.toFixed(2)} string bytes per character`);
  // The limit sits near the geometric middle of the two.
  expect(stringBytesPerChar).toBeLessThanOrEqual(6);
}, 60_000);

// Bounded tool text owns its strings: a store fed 8 or 32 fresh 10 MiB outputs keeps 32 KiB per item, and nothing
// it keeps holds a parent alive. The control keeps the same bytes as plain slices and must scale with the parents,
// or this engine cannot show the difference and the probe proves nothing.
test("retained tool text does not keep its 10 MiB parents alive (Bun/JSC, 8 vs 32 parents)", () => {
  const grown = (mode: string, count: number) => {
    const child = Bun.spawnSync([process.execPath, new URL("./retention-probe.ts", import.meta.url).pathname, mode, String(count)], { timeout: 120_000 });
    if (child.exitCode !== 0) throw new Error(`retention probe failed: ${child.stderr.toString()}`);
    return (JSON.parse(child.stdout.toString()) as { grownBytes: number }).grownBytes / (1024 * 1024);
  };
  const slices = grown("slice", 32) - grown("slice", 8);
  const store = grown("store", 32) - grown("store", 8);
  console.log(`8 -> 32 parents: plain slices +${slices.toFixed(1)} MiB, store +${store.toFixed(1)} MiB`);
  expect(slices, "the control must show retained parents (24 more parents are 240 MiB)").toBeGreaterThan(100);
  expect(store, "24 more items of 32 KiB are under 1 MiB; a retained parent is 10 MiB").toBeLessThan(2);
}, 240_000);
