import { runWorkload } from "./bench-workload.js";

const root = new URL("..", import.meta.url).pathname;
const injection = process.env.BENCH_INJECT === "quadratic";
const result = await runWorkload(root, injection);
console.log(JSON.stringify({
  ...result,
  gates: { scaling: "enforced per named case", absoluteTimings: "report-only" },
  injection: injection
    ? { mode: "quadratic", purpose: "manual sensitivity check; adds per-event work proportional to seed size" }
    : null,
  environment: { bun: Bun.version, os: process.platform, timing: "process CPU", throttle: "none" },
}, null, 2));

if (result.prepend.rows !== 110_000 || result.outlineSize !== 110_000) {
  console.error("prepend result correctness failed");
  process.exit(1);
}
for (const stream of result.streams) {
  if (stream.callbackCount !== 1 || stream.receiptSize !== 0) {
    console.error(`${stream.name} result correctness failed`);
    process.exit(1);
  }
  if (stream.ratio > stream.maximumScalingRatio) {
    console.error(`${stream.name} scaling failed: 10x seed size took ${stream.ratio.toFixed(3)}x (limit ${stream.maximumScalingRatio.toFixed(1)}x)`);
    process.exit(1);
  }
}
