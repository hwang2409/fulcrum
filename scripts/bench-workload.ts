import { pathToFileURL } from "node:url";
import { median } from "./bench-statistics.js";

/** One timed stream: `deltas` deltas of `kind` after `seeds` committed messages. */
export type StreamSide = { kind: "text" | "reasoning"; seeds: number; deltas: number };

/**
 * A stream case times `subject` against `reference` with the same delta size, flush, and read pattern. The gate is
 * subject CPU per delta over reference CPU per delta: a larger subject catches per-event cost that grows with run
 * size; a different kind at the same size catches a stream path slower than the engine's own string concatenation.
 */
export type StreamCase = {
  name: string;
  deltaSize: number;
  flushEvery: number;
  /** Read the whole streamed text after every flush, as a renderer drawing each frame does. */
  readText: boolean;
  reference: StreamSide;
  subject: StreamSide;
  maximumRatio: number;
};

export type StreamResult = StreamCase & {
  referenceCpu: number;
  subjectCpu: number;
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

const streamCases: readonly StreamCase[] = [
  // 800-event samples: local [0.984, 1.116, 0.993], check CI max 1.343,
  // paired CI max 2.401. max(4, 1.5 * 2.401) = 4.
  { name: "800-event flush", deltaSize: 100, flushEvery: 800, readText: false, reference: { kind: "text", seeds: 500, deltas: 50_000 }, subject: { kind: "text", seeds: 5_000, deltas: 50_000 }, maximumRatio: 4 },
  // 3-event samples: local [1.175, 1.176, 1.358], check CI max 1.479,
  // paired CI max 1.279. max(4, 1.5 * 1.479) = 4.
  { name: "3-event flush", deltaSize: 100, flushEvery: 3, readText: false, reference: { kind: "text", seeds: 500, deltas: 50_000 }, subject: { kind: "text", seeds: 5_000, deltas: 50_000 }, maximumRatio: 4 },
  // Text stream vs plain-string reasoning stream, same 20,000 one-character deltas, whole text read every 3 events.
  // Samples (bun 1.4.4, darwin arm64): local [1.230, 1.147, 1.283, 1.165, 1.213]; main 8349b96, which rejoins every
  // chunk on each read, [32.9, 41.0, 45.8]. max(4, 1.5 * 1.283) = 4.
  { name: "text read every 3 events", deltaSize: 1, flushEvery: 3, readText: true, reference: { kind: "reasoning", seeds: 500, deltas: 20_000 }, subject: { kind: "text", seeds: 500, deltas: 20_000 }, maximumRatio: 4 },
  // Reasoning guard: 10x the deltas, flushed and read after every one. Reading a growing string flattens it, so this
  // shape is quadratic in characters on every engine; the guard catches a stream path that makes it worse (pr #99's
  // first head rejoined every chunk per read: 11.6x to 13.2x per delta at 5,000 vs 50,000). Samples: local
  // [4.739, 5.100, 2.243, 1.651, 2.317]; main 8349b96 [4.150, 4.957, 2.255]. max(4, 1.5 * 5.100) = 7.65, so 8.
  { name: "reasoning read every event", deltaSize: 1, flushEvery: 1, readText: true, reference: { kind: "reasoning", seeds: 500, deltas: 10_000 }, subject: { kind: "reasoning", seeds: 500, deltas: 100_000 }, maximumRatio: 8 },
];
const runs = 5;
let burnSink = 0;

const burn = (iterations: number) => {
  let value = 0;
  for (let i = 0; i < iterations; i++) value = (value * 33 + i) % 1000003;
  return value;
};

export async function runWorkload(root: string, injectQuadratic = false): Promise<WorkloadResult> {
  const { createRunStore } = await import(pathToFileURL(`${root}/packages/core/src/index.ts`).href);
  const run = ({ deltaSize, flushEvery, readText }: StreamCase, { kind, seeds: seedCount, deltas: deltaCount }: StreamSide) => {
    const delta = "x".repeat(deltaSize);
    const streamText = (item: any): string | undefined => kind === "text" ? item?.text : item?.message?.content.at(-1)?.text;
    let callbackCount = 0;
    const store = createRunStore(() => callbackCount++);
    for (let i = 0; i < seedCount; i++) {
      store.dispatch({ type: "message_commit", message_id: `seed-${i}`, message: { role: "assistant", content: [{ type: "text", text: "seed" }] } });
    }
    store.getState();
    const streamId = `message:assistant-${seedCount + 1}`;
    const start = process.cpuUsage();
    for (let i = 0; i < deltaCount; i++) {
      store.dispatch(kind === "text" ? { type: "message_delta", delta } : { type: "message_delta", kind, delta });
      if (injectQuadratic) burnSink ^= burn(Math.ceil(seedCount / 10));
      if (i % flushEvery !== flushEvery - 1) continue;
      store.getState();
      if (!readText) continue;
      // A renderer reads the whole text each frame; charCodeAt makes the engine flatten it as drawing would.
      const text = streamText(store.getItem(streamId))!;
      burnSink ^= text.charCodeAt(text.length - 1);
    }
    const usage = process.cpuUsage(start);
    const elapsed = (usage.user + usage.system) / 1_000;
    store.getState();
    if (streamText(store.getItem(streamId))?.length !== deltaCount * deltaSize) throw new Error("invalid stream result");
    return { elapsed, callbackCount, receiptSize: store.getState().receiptOrder.length };
  };

  let timedCpu = 0;
  const streams = streamCases.map((streamCase): StreamResult => {
    const { reference, subject } = streamCase;
    run(streamCase, reference);
    run(streamCase, subject);
    const measurements = Array.from({ length: runs }, () => {
      const referenceRun = run(streamCase, reference);
      if (typeof Bun.gc === "function") Bun.gc(true);
      const subjectRun = run(streamCase, subject);
      if (typeof Bun.gc === "function") Bun.gc(true);
      return { referenceRun, subjectRun };
    });
    timedCpu += measurements.reduce((total, { referenceRun, subjectRun }) => total + referenceRun.elapsed + subjectRun.elapsed, 0);
    return {
      ...streamCase,
      referenceCpu: median(measurements.map(({ referenceRun }) => referenceRun.elapsed)),
      subjectCpu: median(measurements.map(({ subjectRun }) => subjectRun.elapsed)),
      ratio: median(measurements.map(({ referenceRun, subjectRun }) => (subjectRun.elapsed / subject.deltas) / (referenceRun.elapsed / reference.deltas))),
      callbackCount: measurements.at(-1)!.subjectRun.callbackCount,
      receiptSize: measurements.at(-1)!.subjectRun.receiptSize,
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
