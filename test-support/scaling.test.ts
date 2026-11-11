import { expect, test } from "bun:test";
import { domShimAlarm, shimProperty } from "./dom-shim.js";
import { expectGrowthBelow } from "./scaling.js";
domShimAlarm(import.meta.path);

let sink = 0;
const loop = (size: number) => { for (let index = 0; index < size; index++) sink += index & 7; };

test("accepts linear work", () => {
  expectGrowthBelow([100_000, 3_200_000], (size) => () => loop(size));
});

test("rejects quadratic work at the warm-up, before the timed rounds", () => {
  let largeCalls = 0;
  const started = Bun.nanoseconds();
  expect(() => expectGrowthBelow([100, 6_400], (size) => () => {
    if (size === 6_400) largeCalls++;
    for (let outer = 0; outer < size; outer++) loop(size);
  })).toThrow("warm-up time grew");
  // The 6,400 size (~25 ms, 4096x the 100 size against a fast-fail bound of 2048x) runs only its repeat-picking run
  // and two warm-ups, never the timed rounds.
  expect(largeCalls).toBe(3);
  expect(Bun.nanoseconds() - started).toBeLessThan(5e9);
});

test("one stall in the judged warm-up does not fail linear work", () => {
  // A virtual clock makes this exact on any machine and under any load: each call costs size * 40 ns of clock, so the
  // clean ratio is exactly the 64x span (8x under the 512x limit), and no real stall can move a sample.
  const NS_PER_ITEM = 40;
  const [small, large] = [1_000, 64_000];
  const samples = 5;
  const fastFailBound = (large / small) ** 1.5 * 4;
  // The large call takes 2.56 ms >= the 1 ms sample floor, so its repeat count is 1 and large call 1 is exactly the
  // first judged warm-up sample (call 0 picks the count). Its stall is 10x the fast-fail bound times a large call.
  const stall = 10 * fastFailBound * large * NS_PER_ITEM;
  let clock = 0;
  let largeCalls = 0;
  const restoreNanoseconds = shimProperty(Bun, "nanoseconds", {
    ...Object.getOwnPropertyDescriptor(Bun, "nanoseconds"),
    value: () => clock,
  });
  try {
    expectGrowthBelow([small, large], (size) => () => {
      if (size === large && largeCalls++ === 1) clock += stall;
      clock += size * NS_PER_ITEM;
    }, { samples });
  } finally {
    restoreNanoseconds();
  }
  // repeat pick, two warm-ups (the second only because the first was over the fast-fail bound), the timed rounds
  expect(largeCalls).toBe(1 + 2 + samples);
});

test("rejects O(n)-per-step work under the flat exponent", () => {
  expect(() => expectGrowthBelow([1_000, 64_000], (size) => () => loop(size * 16), { exponent: 0.25 })).toThrow("time grew");
});

test("refuses a size span too narrow to separate the orders", () => {
  expect(() => expectGrowthBelow([10_000, 80_000], () => () => {})).toThrow("at least 32x");
});

test("repeats tiny work up to the timer floor so noise cannot set the ratio", () => {
  const calls = new Map<number, number>();
  expectGrowthBelow([10, 320], (size) => {
    calls.set(size, (calls.get(size) ?? 0) + 1);
    return () => loop(size);
  });
  // Work of microseconds per call: each sample sums many repeats instead of one sub-microsecond reading.
  expect(calls.get(10)!).toBeGreaterThan(100);
  expect(calls.get(320)!).toBeGreaterThan(100);
  expect(sink).toBeGreaterThan(0);
});
