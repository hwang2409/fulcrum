import { createRunStore } from "../packages/core/src/index.js";

const absoluteBudget = Number(process.env.CI ? 250 : 50);
const scalingBudget = 4;
const runs = 5;
type Measurement = { small: number; large: number; ratio: number };

function run(seedCount: number, flushEvery: number) {
  const store = createRunStore(() => {});
  for (let i = 0; i < seedCount; i++) {
    store.dispatch({ type: "message_commit", message_id: `seed-${i}`, message: { role: "assistant", content: [{ type: "text", text: "seed" }] } });
  }
  store.getState();
  const streamId = `message:assistant-${seedCount + 1}`;
  const start = performance.now();
  for (let i = 0; i < 50_000; i++) {
    store.dispatch({ type: "message_delta", delta: "x".repeat(100) });
    if (i % flushEvery === flushEvery - 1) store.getState();
  }
  const elapsed = performance.now() - start;
  store.getState();
  const item = store.getItem(streamId);
  if (item?.type !== "message" || item.text?.length !== 5_000_000) throw new Error("invalid stream result");
  return elapsed;
}

function collectRuns(flushEvery: number): Measurement[] {
  run(200, flushEvery);
  run(5_000, flushEvery);
  return Array.from({ length: runs }, () => {
    const small = run(200, flushEvery);
    if (typeof Bun.gc === "function") Bun.gc(true);
    const large = run(5_000, flushEvery);
    if (typeof Bun.gc === "function") Bun.gc(true);
    return { small, large, ratio: large / small };
  });
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(runs / 2)];
const report = (label: string, values: Measurement[]) => {
  const smallMedian = median(values.map(({ small }) => small));
  const largeMedian = median(values.map(({ large }) => large));
  const ratioMedian = median(values.map(({ ratio }) => ratio));
  console.log(`${label}: 200 messages median ${smallMedian.toFixed(2)} ms`);
  console.log(`${label}: 5000 messages median ${largeMedian.toFixed(2)} ms (budget ${absoluteBudget} ms)`);
  console.log(`${label}: scaling median ${ratioMedian.toFixed(2)}x (budget ${scalingBudget}x)`);
  return { largeMedian, ratioMedian };
};

const measurements = [
  report("enforced 800-event flush", collectRuns(800)),
  report("enforced 3-event flush", collectRuns(3)),
];
if (measurements.some(({ ratioMedian, largeMedian }) => ratioMedian > scalingBudget || largeMedian > absoluteBudget)) {
  console.error("enforced performance budget failed");
  process.exit(1);
}
