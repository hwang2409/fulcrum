import { pathToFileURL } from "node:url";

export type WorkloadResult = {
  stream: { small: number; large: number; ratio: number };
  prepend: { elapsed: number; rows: number };
  outlineSize: number;
  callbackCount: number;
  receiptSize: number;
};

const burn = (iterations: number) => {
  let value = 0;
  for (let i = 0; i < iterations; i++) value = (value * 33 + i) % 1000003;
  return value;
};

export async function runWorkload(root: string, inject = false): Promise<WorkloadResult> {
  const { createRunStore } = await import(pathToFileURL(`${root}/packages/core/src/index.ts`).href);
  const runs = 5;
  const run = (seedCount: number, flushEvery: number) => {
    let callbackCount = 0;
    const store = createRunStore(() => callbackCount++);
    for (let i = 0; i < seedCount; i++) {
      store.dispatch({ type: "message_commit", message_id: `seed-${i}`, message: { role: "assistant", content: [{ type: "text", text: "seed" }] } });
    }
    store.getState();
    const streamId = `message:assistant-${seedCount + 1}`;
    const start = performance.now();
    for (let i = 0; i < 50_000; i++) {
      store.dispatch({ type: "message_delta", delta: "x".repeat(100) });
      if (inject) burn(60);
      if (i % flushEvery === flushEvery - 1) store.getState();
    }
    const elapsed = performance.now() - start;
    store.getState();
    const item = store.getItem(streamId);
    if (item?.type !== "message" || item.text?.length !== 5_000_000) throw new Error("invalid stream result");
    return { elapsed, callbackCount, receiptSize: store.getState().receipts.length };
  };
  const collect = (flushEvery: number) => {
    run(200, flushEvery);
    run(5_000, flushEvery);
    return Array.from({ length: runs }, () => {
      const small = run(200, flushEvery);
      if (typeof Bun.gc === "function") Bun.gc(true);
      const large = run(5_000, flushEvery);
      if (typeof Bun.gc === "function") Bun.gc(true);
      return { small: small.elapsed, large: large.elapsed, ratio: large.elapsed / small.elapsed, callbackCount: large.callbackCount, receiptSize: large.receiptSize };
    });
  };
  const eightHundred = collect(800);
  const three = collect(3);
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const stream = {
    small: median([...eightHundred, ...three].map((x) => x.small)),
    large: median([...eightHundred, ...three].map((x) => x.large)),
    ratio: median([...eightHundred, ...three].map((x) => x.ratio)),
  };
  const prependStore = createRunStore(() => {});
  prependStore.beginHistory();
  for (let i = 0; i < 100_000; i++) prependStore.dispatch({ type: "message_commit", message_id: `current-${i}`, message: { role: "assistant", content: [{ type: "text", text: "seed" }] } });
  prependStore.getState();
  const prependStart = performance.now();
  for (let page = 0; page < 50; page++) prependStore.prepend(Array.from({ length: 200 }, (_, row) => ({ type: "message_commit" as const, message_id: `older-${page}-${row}`, message: { role: "assistant", content: [{ type: "text", text: "old" }] } })));
  const prepend = { elapsed: performance.now() - prependStart, rows: prependStore.getOutline().length };
  return { stream, prepend, outlineSize: prepend.rows, callbackCount: eightHundred.at(-1)!.callbackCount, receiptSize: eightHundred.at(-1)!.receiptSize };
}
