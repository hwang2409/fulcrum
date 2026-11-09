import { expect } from "bun:test";

// Shared by every timing-based scaling test, so no test picks its own tight margin.
// Over a span S between the two sizes, work of order n^k grows ~S^k times. The default limit S^1.5 sits at the
// geometric middle between linear (~S) and quadratic (~S^2): at the minimum 32x span each side is ~5.7x from 181.
// A test that times a fixed window of work after `size` of setup (flat ~1 vs O(n) per step ~S) passes
// `exponent: 0.25`, a quarter step below the middle, as the default sits a half step above linear.
export const MIN_SPAN = 32;
// Below this a sample is mostly timer and scheduler noise; each size repeats its work until a sample reaches it.
const MIN_SAMPLE_NS = 1e6;
// A warm-up ratio this far over the limit is a certain failure; stop before the slow timed rounds.
const FAST_FAIL_FACTOR = 4;

/**
 * Times `prepare(size)()` at the smallest and largest size and fails when the time grows more than span^exponent.
 * `prepare` does untimed setup and returns the work to time; it is called again for every repeat, since work may
 * consume its setup. Only the two end sizes are judged: middle sizes add time but no extra separation.
 * Each size is warmed up once (a warm-up ratio over 4x the limit fails at once), which also picks how many repeats
 * make a sample of at least 1 ms; then each round times both sizes (so load drift hits both alike), and the fastest
 * per-repeat time of `samples` rounds counts.
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
  timeOnce(sizes[0]); // the first, unoptimized run of the small size would understate the warm-up ratio
  const warmUp = sizes.map(timeOnce);
  const repeats = warmUp.map((time) => Math.max(1, Math.ceil(MIN_SAMPLE_NS / time)));
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
  judge(warmUp, "warm-up ", limit * FAST_FAIL_FACTOR);
  const fastest = [Infinity, Infinity];
  for (let round = 0; round < samples; round++)
    for (const index of [0, 1]) fastest[index] = Math.min(fastest[index]!, time(index));
  return judge(fastest, "", limit);
}
