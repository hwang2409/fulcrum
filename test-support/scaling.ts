import { expect } from "bun:test";

// Shared by every timing-based scaling test, so no test picks its own tight margin.
// Over a span S between the two sizes, work of order n^k grows ~S^k times. The default limit S^1.5 sits at the
// geometric middle between linear (~S) and quadratic (~S^2): at the minimum 32x span each side is ~5.7x from 181.
// A test that times a fixed window of work after `size` of setup (flat ~1 vs O(n) per step, which a fixed per-step
// cost dilutes far below S) passes a small exponent, set so the limit sits near the geometric middle of its measured
// clean and regressed ratios.
export const MIN_SPAN = 32;
// Below this a sample is mostly timer and scheduler noise; each size repeats its work until a sample reaches it.
const MIN_SAMPLE_NS = 1e6;
// Two warm-up ratios in a row this far over the limit are a certain failure; stop before the slow timed rounds.
const FAST_FAIL_FACTOR = 4;

/**
 * Times `prepare(size)()` at the smallest and largest size and fails when the time grows more than span^exponent.
 * `prepare` does untimed setup and returns the work to time; it is called again for every repeat, since work may
 * consume its setup. Only the two end sizes are judged: middle sizes add time but no extra separation.
 * One run of each size picks how many repeats make a sample of at least 1 ms; then one warm-up sample of each size is
 * taken. A warm-up ratio over 4x the limit is checked by a second warm-up, and fails at once only if that one is over
 * too, so one stall cannot fail the test. Then each round times both sizes (so load drift hits both alike), and the fastest per-repeat time of
 * `samples` rounds counts.
 */
export function expectGrowthBelow(
  sizes: readonly [smallest: number, largest: number],
  prepare: (size: number) => () => void,
  { exponent = 1.5, samples = 5 }: { exponent?: number; samples?: number } = {},
) {
  const span = sizes[1] / sizes[0];
  if (span < MIN_SPAN) throw new Error(`expectGrowthBelow needs sizes spanning at least ${MIN_SPAN}x, got ${span}x`);
  const limit = span ** exponent;
  const timeOnce = (size: number) => {
    const work = prepare(size);
    const start = Bun.nanoseconds();
    work();
    return Bun.nanoseconds() - start;
  };
  timeOnce(sizes[0]); // the first, unoptimized run of the small size would overstate its time
  const repeats = sizes.map((size) => Math.max(1, Math.ceil(MIN_SAMPLE_NS / timeOnce(size))));
  const time = (index: number) => {
    let total = 0;
    for (let repeat = 0; repeat < repeats[index]!; repeat++) total += timeOnce(sizes[index]!);
    return total / repeats[index]!;
  };
  const judge = (times: readonly number[], phase: string, bound: number) => {
    const ratio = times[1]! / times[0]!;
    const table = sizes.map((size, index) => `${size}: ${(times[index]! / 1e6).toFixed(2)} ms`).join(", ");
    expect(ratio, `${phase}time grew ${ratio.toFixed(1)}x over a ${span}x size span (limit ${span}^${exponent} = ${limit.toFixed(1)}); ${table}`).toBeLessThanOrEqual(bound);
    return ratio;
  };
  const warmUp = [time(0), time(1)];
  if (warmUp[1]! / warmUp[0]! > limit * FAST_FAIL_FACTOR) judge([time(0), time(1)], "warm-up ", limit * FAST_FAIL_FACTOR);
  const fastest = [Infinity, Infinity];
  for (let round = 0; round < samples; round++)
    for (const index of [0, 1]) fastest[index] = Math.min(fastest[index]!, time(index));
  return judge(fastest, "", limit);
}
