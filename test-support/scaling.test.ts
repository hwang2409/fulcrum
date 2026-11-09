import { expect, test } from "bun:test";
import { expectGrowthBelow } from "./scaling.js";

let sink = 0;
const loop = (size: number) => { for (let index = 0; index < size; index++) sink += index & 7; };

test("accepts linear work", () => {
  expectGrowthBelow([100_000, 3_200_000], (size) => () => loop(size));
});

test("rejects quadratic work at the warm-up, before the timed rounds", () => {
  let calls = 0;
  const started = Bun.nanoseconds();
  expect(() => expectGrowthBelow([100, 6_400], (size) => () => {
    calls++;
    for (let outer = 0; outer < size; outer++) loop(size);
  })).toThrow("warm-up time grew");
  // The 100 size repeats up to the 1 ms sample floor; the 6,400 size (~40 ms, 4096x the 100 size against a fast-fail bound of 2048x) runs only its one warm-up.
  expect(calls).toBeLessThan(200);
  expect(Bun.nanoseconds() - started).toBeLessThan(5e9);
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
