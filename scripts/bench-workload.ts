import { pathToFileURL } from "node:url";
import { median } from "./bench-statistics.js";

export type StreamResult = {
  name: string;
  flushEvery: number;
  smallSeedCount: number;
  largeSeedCount: number;
  small: number;
  large: number;
  ratio: number;
  callbackCount: number;
  receiptSize: number;
};

export type WorkloadResult = {
  streams: StreamResult[];
  timedCpu: number;
  prepend: { elapsed: number; rows: number };
  outlineSize: number;
};

const streamCases = [
  { name: "800-event flush", flushEvery: 800, smallSeedCount: 500, largeSeedCount: 5_000 },
  { name: "3-event flush", flushEvery: 3, smallSeedCount: 500, largeSeedCount: 5_000 },
] as const;
const runs = 5;
let burnSink = 0;

const burn = (iterations: number) => {
  let value = 0;
  for (let i = 0; i < iterations; i++) value = (value * 33 + i) % 1000003;
  return value;
};

const addCpuFraction = (start: ReturnType<typeof process.cpuUsage>, fraction: number) => {
  const baseline = process.cpuUsage(start);
  const target = (baseline.user + baseline.system) * fraction;
  const injectionStart = process.cpuUsage();
  while (true) {
    burnSink ^= burn(100);
    const injected = process.cpuUsage(injectionStart);
    if (injected.user + injected.system >= target) return;
  }
};

export async function runWorkload(root: string, inject = false): Promise<WorkloadResult> {
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
      if (i % flushEvery === flushEvery - 1) store.getState();
    }
    if (inject) addCpuFraction(start, 0.25);
    const usage = process.cpuUsage(start);
    const elapsed = (usage.user + usage.system) / 1_000;
    store.getState();
    const item = store.getItem(streamId);
    if (item?.type !== "message" || item.text?.length !== 5_000_000) throw new Error("invalid stream result");
    return { elapsed, callbackCount, receiptSize: store.getState().receiptOrder.length };
  };

  let timedCpu = 0;
  const streams = streamCases.map(({ name, flushEvery, smallSeedCount, largeSeedCount }) => {
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
      small: median(measurements.map(({ small }) => small.elapsed)),
      large: median(measurements.map(({ large }) => large.elapsed)),
      ratio: median(measurements.map(({ small, large }) => large.elapsed / small.elapsed)),
      callbackCount: measurements.at(-1)!.large.callbackCount,
      receiptSize: measurements.at(-1)!.large.receiptSize,
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
  return { streams, timedCpu, prepend, outlineSize: prepend.rows };
}
