import { initialState, reduce } from "../src/index.js";

let state = initialState;
for (let i = 0; i < 200; i++) {
  state = reduce(state, {
    type: "message_commit",
    message_id: `seed-${i}`,
    message: { role: "assistant", content: [{ type: "text", text: "seed" }] },
  });
}
const start = performance.now();
for (let i = 0; i < 50_000; i++) {
  state = reduce(state, { type: "message_delta", delta: "x" });
}
const ms = performance.now() - start;
console.log(`${ms.toFixed(2)} ms total; ${(ms / 50_000).toFixed(4)} ms/event`);
