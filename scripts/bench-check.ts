import { runWorkload } from "./bench-workload.js";

const absoluteBudget = Number(process.env.CI ? 250 : 50);
const scalingBudget = 4;
const root = new URL("..", import.meta.url).pathname;
const result = await runWorkload(root, process.env.BENCH_INJECT === "25");
console.log(JSON.stringify({ ...result, environment: { bun: Bun.version, os: process.platform, throttle: "none" } }, null, 2));
if (result.prepend.rows !== 110_000 || result.prepend.elapsed > 500) {
  console.error(`prepend performance budget failed (${result.prepend.elapsed.toFixed(2)} ms; accident alarm ${absoluteBudget} ms)`);
  process.exit(1);
}
if (result.stream.ratio > scalingBudget || result.stream.large > absoluteBudget) {
  console.error("enforced performance budget failed");
  process.exit(1);
}
