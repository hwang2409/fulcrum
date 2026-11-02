import { createStreamingDocument } from "../packages/markdown/src/index.js";

const targetBytes = 100_000;
const deltaSize = 20;
const paragraph = `${"streaming markdown stays bounded ".repeat(3)}\n\n`;
const source = paragraph.repeat(Math.ceil(targetBytes / paragraph.length)).slice(0, targetBytes);
const document = createStreamingDocument();
const samples: number[] = [];
for (let index = 0; index < source.length; index += deltaSize) {
  const start = performance.now();
  document.append(source.slice(index, index + deltaSize));
  document.render();
  samples.push(performance.now() - start);
}
const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const quarter = Math.floor(samples.length / 4);
const early = average(samples.slice(quarter, quarter * 2));
const late = average(samples.slice(-quarter));
const ratio = late / early;
const frozenBefore = document.stats.frozenParses;
document.append("open tail");
document.render();
const sorted = [...samples].sort((a, b) => a - b);
const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
const failed = ratio > 2 || p95 > 2 || document.stats.frozenParses !== frozenBefore;
console.log(`markdown stream: ${source.length} bytes in ${samples.length} deltas`);
console.log(`per delta: ${average(samples).toFixed(4)} ms average, ${p95.toFixed(4)} ms p95`);
console.log(`late/early cost: ${ratio.toFixed(2)}x (budget 2.00x)`);
console.log(`parses: ${document.stats.frozenParses} frozen once, ${document.stats.tailParses} tails`);
if (failed) process.exit(1);
