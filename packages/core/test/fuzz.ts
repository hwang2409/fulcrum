export const seededRandom = (seed: number) => () => (
  (seed = Math.imul(seed ^ seed >>> 15, 1 | seed), seed ^= seed + Math.imul(seed ^ seed >>> 7, 61 | seed)),
  ((seed ^ seed >>> 14) >>> 0) / 4294967296
);
