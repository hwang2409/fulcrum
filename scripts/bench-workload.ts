import { pathToFileURL } from "node:url";
import { median } from "./bench-statistics.js";

export type StreamResult = {
  name: string;
  flushEvery: number;
  smallSeedCount: number;
  largeSeedCount: number;
  maximumScalingRatio: number;
  small: number;
  large: number;
  ratio: number;
  callbackCount: number;
  receiptSize: number;
};

export type PrependScalingResult = {
  name: string;
  smallPageCount: number;
  largePageCount: number;
  maximumRatio: number;
  small: number;
  large: number;
  ratio: number;
  rows: number;
};

export type WorkloadResult = {
  streams: StreamResult[];
  queuedPrepends: PrependScalingResult[];
  timedCpu: number;
  prepend: { elapsed: number; rows: number };
  outlineSize: number;
};

const streamCases = [
  // 800-event samples: local [0.984, 1.116, 0.993], check CI max 1.343,
  // paired CI max 2.401. max(4, 1.5 * 2.401) = 4.
  { name: "800-event flush", flushEvery: 800, smallSeedCount: 500, largeSeedCount: 5_000, maximumScalingRatio: 4 },
  // 3-event samples: local [1.175, 1.176, 1.358], check CI max 1.479,
  // paired CI max 1.279. max(4, 1.5 * 1.479) = 4.
  { name: "3-event flush", flushEvery: 3, smallSeedCount: 500, largeSeedCount: 5_000, maximumScalingRatio: 4 },
] as const;
const prependCases = [
  // Times only the prepend calls; the old queue copied every queued row on each call.
  // Linear samples: local standalone max 8.76 (11 runs), local paired a/b max 10.50
  // (7 runs). Quadratic main-store samples: local min 46.0 (11 runs).
  // max(4, 1.5 * 10.50) = 16.
  { name: "queued one-row prepend pages", smallPageCount: 2_000, largePageCount: 20_000, maximumRatio: 16 },
] as const;
const runs = 5;
let burnSink = 0;

const burn = (iterations: number) => {
  let value = 0;
  for (let i = 0; i < iterations; i++) value = (value * 33 + i) % 1000003;
  return value;
};

export async function runWorkload(root: string, injectQuadratic = false): Promise<WorkloadResult> {
  const { createRunStore } = await import(pathToFileURL(`${root}/packages/core/src/index.ts`).href);
  const run = (seedCount: number, flushEvery: number) => {
    let callbackCount = 0;
    const store = createRunStore(() => callbackCount++);
    for (let i = 0; i < seedCount; i++) {
      store.dispatch({ type: "message_commit", message_id: `seed-${i}`, message: { role: "assistant", content: [{ type: "text", text: "seed" }] } });
    }
    store.getState();
    const streamId = `message:assistant-${seedCount + 1}`;
    const start = process.cpuUsage();
    for (let i = 0; i < 50_000; i++) {
      store.dispatch({ type: "message_delta", delta: "x".repeat(100) });
      if (injectQuadratic) burnSink ^= burn(Math.ceil(seedCount / 10));
      if (i % flushEvery === flushEvery - 1) store.getState();
    }
    const usage = process.cpuUsage(start);
    const elapsed = (usage.user + usage.system) / 1_000;
    store.getState();
    const item = store.getItem(streamId);
    if (item?.type !== "message" || item.text?.length !== 5_000_000) throw new Error("invalid stream result");
    return { elapsed, callbackCount, receiptSize: store.getState().receiptOrder.length };
  };

  let timedCpu = 0;
  const streams = streamCases.map(({ name, flushEvery, smallSeedCount, largeSeedCount, maximumScalingRatio }) => {
    run(smallSeedCount, flushEvery);
    run(largeSeedCount, flushEvery);
    const measurements = Array.from({ length: runs }, () => {
      const small = run(smallSeedCount, flushEvery);
      if (typeof Bun.gc === "function") Bun.gc(true);
      const large = run(largeSeedCount, flushEvery);
      if (typeof Bun.gc === "function") Bun.gc(true);
      return { small, large };
    });
    timedCpu += measurements.reduce((total, { small, large }) => total + small.elapsed + large.elapsed, 0);
    return {
      name,
      flushEvery,
      smallSeedCount,
      largeSeedCount,
      maximumScalingRatio,
      small: median(measurements.map(({ small }) => small.elapsed)),
      large: median(measurements.map(({ large }) => large.elapsed)),
      ratio: median(measurements.map(({ small, large }) => large.elapsed / small.elapsed)),
      callbackCount: measurements.at(-1)!.large.callbackCount,
      receiptSize: measurements.at(-1)!.large.receiptSize,
    };
  });

  const runPrepend = (pageCount: number) => {
    const pages = Array.from({ length: pageCount }, (_, page) => [{ type: "message_commit" as const, message_id: `queued-${page}`, message: { role: "assistant", content: [{ type: "text", text: "old" }] } }]);
    const store = createRunStore(() => {});
    store.beginHistory();
    // A collection inside a sub-millisecond sample swamped it in paired a/b runs.
    if (typeof Bun.gc === "function") Bun.gc(true);
    const start = process.cpuUsage();
    for (const page of pages) store.prepend(page);
    const usage = process.cpuUsage(start);
    const rows = store.getOutline().length;
    if (rows !== pageCount) throw new Error("invalid queued prepend result");
    store.dispose();
    return { elapsed: (usage.user + usage.system) / 1_000, rows };
  };
  const queuedPrepends = prependCases.map(({ name, smallPageCount, largePageCount, maximumRatio }) => {
    runPrepend(smallPageCount);
    runPrepend(largePageCount);
    const measurements = Array.from({ length: runs }, () => {
      const small = runPrepend(smallPageCount);
      if (typeof Bun.gc === "function") Bun.gc(true);
      const large = runPrepend(largePageCount);
      if (typeof Bun.gc === "function") Bun.gc(true);
      return { small, large };
    });
    timedCpu += measurements.reduce((total, { small, large }) => total + small.elapsed + large.elapsed, 0);
    return {
      name,
      smallPageCount,
      largePageCount,
      maximumRatio,
      small: median(measurements.map(({ small }) => small.elapsed)),
      large: median(measurements.map(({ large }) => large.elapsed)),
      ratio: median(measurements.map(({ small, large }) => large.elapsed / Math.max(small.elapsed, 0.001))),
      rows: measurements.at(-1)!.large.rows,
    };
  });

  const prependStore = createRunStore(() => {});
  prependStore.beginHistory();
  for (let i = 0; i < 100_000; i++) prependStore.dispatch({ type: "message_commit", message_id: `current-${i}`, message: { role: "assistant", content: [{ type: "text", text: "seed" }] } });
  prependStore.getState();
  const prependStart = process.cpuUsage();
  for (let page = 0; page < 50; page++) prependStore.prepend(Array.from({ length: 200 }, (_, row) => ({ type: "message_commit" as const, message_id: `older-${page}-${row}`, message: { role: "assistant", content: [{ type: "text", text: "old" }] } })));
  const prependUsage = process.cpuUsage(prependStart);
  const prepend = { elapsed: (prependUsage.user + prependUsage.system) / 1_000, rows: prependStore.getOutline().length };
  return { streams, queuedPrepends, timedCpu, prepend, outlineSize: prepend.rows };
}
