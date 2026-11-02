import { createRunStore } from "../packages/core/src/index.js";

const budget = Number(process.env.BENCH_BUDGET_MS ?? 50);
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
    if (i % 800 === 799) store.getState();
  }
  const state = store.getState();
  const item = state.itemsById[streamId];
  if (item?.type !== "message" || item.text?.length !== 5_000_000) throw new Error("invalid stream result");
  return performance.now() - start;
}

let failed = false;
for (const seedCount of [200, 5_000]) {
  const values = Array.from({ length: runs }, () => run(seedCount));
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(runs / 2)];
  const label = `${seedCount} messages`;
  console.log(`${label}: median ${median.toFixed(2)} ms (budget ${budget} ms)`);
  if (median > budget) {
    failed = true;
    console.log(`  runs: ${values.map((value) => value.toFixed(2)).join(", ")}`);
  }
}
if (failed) process.exit(1);
