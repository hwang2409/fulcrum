import { runWorkload } from "./bench-workload.js";

const root = new URL("..", import.meta.url).pathname;
const injection = process.env.BENCH_INJECT === "quadratic";
const result = await runWorkload(root, injection);
console.log(JSON.stringify({
  ...result,
  gates: { perDeltaRatio: "enforced per named case", absoluteTimings: "report-only" },
  injection: injection
    ? { mode: "quadratic", purpose: "manual sensitivity check; adds per-event work proportional to seed size" }
    : null,
  environment: { bun: Bun.version, os: process.platform, timing: "process CPU", throttle: "none" },
}, null, 2));

if (result.prepend.rows !== 110_000 || result.outlineSize !== 110_000) {
  console.error("prepend result correctness failed");
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
