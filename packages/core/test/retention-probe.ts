// Run in a child process by memory.test.ts, so each count starts from a clean heap. Feeds `count` tool items one fresh
// 10 MiB output each (and a 10 MiB final result) into a store that keeps 32 KiB per item, then prints the heap growth
// after a full collection. `slice` is the control: it keeps the same 32 KiB as a plain `slice` of each parent, which
// the engine may back by the whole parent, so the probe proves it can see a retained parent.
import { heapStats } from "bun:jsc";
import { createRunStore } from "../src/index.js";

const [mode, count] = [process.argv[2]!, Number(process.argv[3])];
const KEEP = 32 * 1024;
const parent = (index: number) => `${index}`.padStart(8, "0").concat("x".repeat(10 * 1024 * 1024)).toLowerCase();
const kept: string[] = [];
const store = createRunStore((flush) => flush(), { toolOutputItemBytes: KEEP, toolOutputRunBytes: 1024 * 1024 * 1024 });
Bun.gc(true);
const before = heapStats().heapSize;
for (let index = 0; index < count; index++) {
  if (mode === "slice") { kept.push(parent(index).slice(-KEEP)); continue; }
  const tool_call = { id: String(index), name: "bash", arguments: {} };
  store.dispatch({ type: "tool_output", tool_call, output: parent(index) });
  store.dispatch({ type: "tool_end", tool_call, tool_result: { tool_call_id: String(index), content: parent(index), is_error: false } });
}
Bun.gc(true);
Bun.gc(true);
console.log(JSON.stringify({ grownBytes: heapStats().heapSize - before, kept: kept.length, items: store.getOutline().length }));
