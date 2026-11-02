import { createRunStore } from "../src/index.js";

function run(seedCount: number) {
  const store = createRunStore(() => {});
  for (let i = 0; i < seedCount; i++) {
    store.dispatch({
      type: "message_commit",
      message_id: `seed-${i}`,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "seed" }],
      },
    });
  }
  store.getState();

  const streamId = `message:assistant-${seedCount + 1}`;
  const start = performance.now();
  for (let i = 0; i < 50_000; i++) {
    store.dispatch({ type: "message_delta", delta: "x".repeat(100) });
    if (i % 800 === 799) {
      const item = store.getItem(streamId);
      if (item?.type !== "message" || item.text?.at(-1) !== "x")
        throw new Error("invalid stream read");
    }
  }
  store.getState();
  const item = store.getItem(streamId);
  if (item?.type !== "message" || item.text?.length !== 5_000_000)
    throw new Error("invalid stream result");
  return performance.now() - start;
}

const small = run(5_000);
const large = run(100_000);
const ratio = large / small;
console.log(`5000 messages: ${small.toFixed(2)} ms`);
console.log(`100000 messages: ${large.toFixed(2)} ms`);
console.log(`scaling: ${ratio.toFixed(2)}x`);
if (ratio > 4) throw new Error(`delta cost scaled ${ratio.toFixed(2)}x with history`);
