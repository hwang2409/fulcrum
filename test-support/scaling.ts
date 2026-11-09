import { expect } from "bun:test";

// Shared by every timing-based scaling test: separates linear from quadratic growth with a wide margin on both sides.
// Over a span of S between the smallest and largest size, linear work grows ~S times and quadratic work ~S^2 times.
// The limit is S^1.5, the geometric middle, so at the minimum 32x span linear (~32) and quadratic (~1024) each sit
// ~5.7x away from it (181). That margin absorbs shared-runner noise without calibration; never tighten it.
export const MIN_SPAN = 32;

/**
 * `prepare(size)` does any untimed setup and returns the work to time. Every size is warmed up once, then each round
 * times all sizes in order (so load drift hits all sizes alike), and the fastest of `samples` rounds is kept per size.
 */
export function expectSubquadratic(sizes: readonly number[], prepare: (size: number) => () => void, samples = 5) {
  const smallest = sizes[0]!;
  const largest = sizes.at(-1)!;
  const span = largest / smallest;
  if (sizes.length < 2 || span < MIN_SPAN) throw new Error(`expectSubquadratic needs sizes spanning at least ${MIN_SPAN}x, got ${span}x`);
  const time = (size: number) => {
    const work = prepare(size);
    const start = Bun.nanoseconds();
    work();
    return Bun.nanoseconds() - start;
  };
  for (const size of sizes) time(size);
  const fastest = sizes.map(() => Infinity);
  for (let round = 0; round < samples; round++)
    sizes.forEach((size, index) => { fastest[index] = Math.min(fastest[index]!, time(size)); });
  const ratio = fastest.at(-1)! / fastest[0]!;
  const limit = span ** 1.5;
  const table = sizes.map((size, index) => `${size}: ${(fastest[index]! / 1e6).toFixed(2)} ms`).join(", ");
  expect(ratio, `time grew ${ratio.toFixed(1)}x over a ${span}x size span (linear ~${span}, quadratic ~${span ** 2}, limit ${limit.toFixed(0)}); ${table}`).toBeLessThanOrEqual(limit);
  return ratio;
}
