import { createRunStore } from "../src/index.js";

function run(seedCount: number) {
  const store = createRunStore(undefined, () => {});
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
      const item = store.getState().itemsById[streamId];
      if (item?.type !== "message" || item.text?.at(-1) !== "x")
        throw new Error("invalid stream read");
    }
  }
  const state = store.getState();
  const item = state.itemsById[streamId];
  if (item?.type !== "message" || item.text?.length !== 5_000_000)
    throw new Error("invalid stream result");
  return performance.now() - start;
}

for (const seedCount of [200, 5_000]) {
  const ms = run(seedCount);
  console.log(`${seedCount} messages: ${ms.toFixed(2)} ms`);
}
