import { createRunStore } from "../packages/core/src/index.js";

// Calibrated against realistic display-cadence flushing (3 events/frame), with headroom.
const absoluteBudget = Number(process.env.CI ? 5_000 : 5_000);
const scalingBudget = 35;
const runs = 5;

function run(seedCount: number) {
  const store = createRunStore(undefined, () => {});
  for (let i = 0; i < seedCount; i++) {
    store.dispatch({ type: "message_commit", message_id: `seed-${i}`, message: { role: "assistant", content: [{ type: "text", text: "seed" }] } });
  }
  store.getState();
  const streamId = `message:assistant-${seedCount + 1}`;
  const start = performance.now();
  for (let i = 0; i < 50_000; i++) {
    store.dispatch({ type: "message_delta", delta: "x".repeat(100) });
    // 200 events/s flushed at display cadence is about 3-4 events per frame.
    if (i % 3 === 2) store.getState();
  }
  const elapsed = performance.now() - start;
  const state = store.getState();
  const item = state.itemsById[streamId];
  if (item?.type !== "message" || item.text?.length !== 5_000_000) throw new Error("invalid stream result");
  return elapsed;
}

function collectRuns() {
  // warm up the JIT before collecting measurements
  run(200);
  run(5_000);
  const values = Array.from({ length: runs }, () => {
    const small = run(200);
    if (typeof Bun.gc === "function") Bun.gc(true);
    const large = run(5_000);
    if (typeof Bun.gc === "function") Bun.gc(true);
    return { small, large };
  });
  return values;
}

const values = collectRuns();
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(runs / 2)];
const smallRuns = values.map(({ small }) => small);
const largeRuns = values.map(({ large }) => large);
const ratios = values.map(({ small, large }) => large / small);
const smallMedian = median(smallRuns);
const largeMedian = median(largeRuns);
const ratioMedian = median(ratios);
const failed = ratioMedian > scalingBudget || largeMedian > absoluteBudget;

console.log(`200 messages: median ${smallMedian.toFixed(2)} ms`);
console.log(`5000 messages: median ${largeMedian.toFixed(2)} ms (budget ${absoluteBudget} ms)`);
console.log(`scaling: median ${ratioMedian.toFixed(2)}x (budget ${scalingBudget}x)`);
if (failed) {
  console.log(`200 runs: ${smallRuns.map((value) => value.toFixed(2)).join(", ")}`);
  console.log(`5000 runs: ${largeRuns.map((value) => value.toFixed(2)).join(", ")}`);
  console.log(`ratios: ${ratios.map((value) => value.toFixed(2)).join(", ")}`);
  process.exit(1);
}
