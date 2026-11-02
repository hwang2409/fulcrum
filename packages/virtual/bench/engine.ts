import { createVirtualizer } from "../src/index.js";

const count = 100_000;
const outline = Array.from({ length: count }, (_, index) => ({ id: `row-${index}`, kind: index % 5 === 0 ? "large" : "normal" }));
let seed = 0x5eed1234;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);

const constructionStart = performance.now();
const virtual = createVirtualizer({ estimateSize: (kind) => kind === "large" ? 72 : 28 });
virtual.setOutline(outline);
virtual.setViewport({ scrollTop: 0, size: 800, source: "user" });
const construction = performance.now() - constructionStart;

const updateStart = performance.now();
for (let index = 0; index < 10_000; index++) {
  const row = random() % count;
  virtual.measure(`row-${row}`, 16 + (random() % 120));
}
const updates = performance.now() - updateStart;

virtual.setViewport({ scrollTop: 0, size: 0, source: "programmatic" });
const queryStart = performance.now();
for (let index = 0; index < 10_000; index++) virtual.scrollToId(`row-${random() % count}`);
const queries = performance.now() - queryStart;

console.log(`construction (100,000 rows): ${construction.toFixed(2)} ms`);
console.log(`10,000 point updates: ${updates.toFixed(2)} ms`);
console.log(`10,000 range queries: ${queries.toFixed(2)} ms`);
if (construction >= 100) throw new Error(`construction exceeded 100 ms target: ${construction.toFixed(2)} ms`);
