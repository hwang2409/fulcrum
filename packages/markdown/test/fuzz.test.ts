import { expect, test } from "bun:test";
import { runMarkdownFuzz } from "./fuzz.js";

test("500 seeded random documents preserve streaming invariants", () => {
  const stats = [0x23c0ffee, 0x5eed0001, 0x5eed0002, 0x5eed0003, 0x5eed0004]
    .map((seed) => runMarkdownFuzz(seed, 100));
  expect(stats.every((stats) => stats.nestedPipeTransitions === 0)).toBe(true);
}, 30_000);
