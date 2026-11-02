import { createRunStore } from "../src/index.js";

const store = createRunStore(undefined, () => {});
for (let i = 0; i < 200; i++) {
  store.dispatch({
    type: "message_commit",
    message_id: `seed-${i}`,
    message: { role: "assistant", content: [{ type: "text", text: "seed" }] },
  });
}
const start = performance.now();
for (let i = 0; i < 50_000; i++) {
  store.dispatch({ type: "message_delta", delta: "x" });
}
const ms = performance.now() - start;
console.log(`${ms.toFixed(2)} ms total; ${(ms / 50_000).toFixed(6)} ms/event`);
