import { runWorkload } from "./bench-workload.js";

const root = new URL("..", import.meta.url).pathname;
const injection = process.env.BENCH_INJECT === "quadratic";
const result = await runWorkload(root, injection);
console.log(JSON.stringify({
  ...result,
  gates: { perDeltaRatio: "enforced per named case", toolOutputAppendRatio: 1.5, toolOutputCutAppendRatio: 1.5, toolOutputReplacementRatio: 12, findBytesRatio: 12, findChunkRatio: 2, absoluteTimings: "report-only" },
  injection: injection
    ? { mode: "quadratic", purpose: "manual sensitivity check; adds per-event work proportional to seed size" }
    : null,
  environment: { bun: Bun.version, os: process.platform, timing: "process CPU", throttle: "none" },
}, null, 2));

if (result.prepend.rows !== 110_000 || result.outlineSize !== 110_000) {
  console.error("prepend result correctness failed");
  process.exit(1);
}
if (result.toolOutput.appendPerKibRatio > 1.5) {
  console.error(`tool output append scaling failed: 10x retained history took ${result.toolOutput.appendPerKibRatio.toFixed(3)}x CPU per new KiB (limit 1.5x)`);
  process.exit(1);
}
if (result.toolOutput.cutAppendRatio > 1.5) {
  console.error(`tool output append after the item cut failed: 10x more lines took ${result.toolOutput.cutAppendRatio.toFixed(3)}x CPU per line (limit 1.5x)`);
  process.exit(1);
}
if (result.toolOutput.replacementRatio > 12) {
  console.error(`tool output replacement scaling failed: 10x replacement size took ${result.toolOutput.replacementRatio.toFixed(3)}x CPU (limit 12x)`);
  process.exit(1);
}
if (!result.find) {
  console.error("local find was not measured");
  process.exit(1);
}
if (result.find.bytesRatio > 12) {
  console.error(`local find scaling failed: 10x retained bytes took ${result.find.bytesRatio.toFixed(3)}x CPU (limit 12x)`);
  process.exit(1);
}
if (result.find.chunkRatio > 2) {
  console.error(`local find chunk scaling failed: the same bytes in 10x as many chunks took ${result.find.chunkRatio.toFixed(3)}x CPU (limit 2x)`);
  process.exit(1);
}
for (const queued of result.queuedPrepends) {
  if (queued.rows !== queued.largePageCount) {
    console.error(`${queued.name} result correctness failed`);
    process.exit(1);
  }
  if (queued.ratio > queued.maximumRatio) {
    console.error(`${queued.name} scaling failed: 10x pages took ${queued.ratio.toFixed(3)}x (limit ${queued.maximumRatio.toFixed(1)}x)`);
    process.exit(1);
  }
}
for (const stream of result.streams) {
  if (stream.callbackCount !== 1 || stream.receiptSize !== 0) {
    console.error(`${stream.name} result correctness failed`);
    process.exit(1);
  }
  if (stream.ratio > stream.maximumRatio) {
    console.error(`${stream.name} failed: the subject took ${stream.ratio.toFixed(3)}x the reference CPU per delta (limit ${stream.maximumRatio.toFixed(1)}x)`);
    process.exit(1);
  }
}
