import { createRunStore } from "../src/index.js";
const store = createRunStore(); const start = performance.now();
for (let i = 0; i < 50_000; i++) store.dispatch({ type: "message_delta", delta: "x" });
const ms = performance.now() - start; console.log(`${ms.toFixed(2)} ms total; ${(ms / 50_000).toFixed(4)} ms/event`);
