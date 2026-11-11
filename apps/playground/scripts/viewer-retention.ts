// A long-lived text viewer: one page, many appends. Reports per-append time (first 20 vs last 20 median) and the heap
// retained after a forced garbage collection, before and after the appends. Passing --max-growth-kib makes the
// stable retained-heap measurement a gate; timing stays report-only because runner noise is larger than its effect.
// Needs a production build (`bun run build`). Usage:
//   bun scripts/viewer-retention.ts [--root <playground dir>] [--port 4191] [--fixture lines|single|read] [--lines N]
//     [--runs 10] [--appends 100] [--chars N] [--warmup N] [--classes] [--max-growth-kib N]
// `--chars N`: each append is a newline and N - 1 letters (default: "\npaired tail <i>"). `--lines N`: the read
// fixture's line count. `--warmup N`: appends before the first heap reading; they fill fixed-size caches (the virtual
// engine's 2,000-entry action log) and warm the JIT, so the measured growth is only what scales. `--classes`: also take
// a heap snapshot before and after the appends and print the classes whose live count or size grew most (V8 names
// rope strings "concatenated string"). A pair of runs with the same text in more appends gives the cost per append.
// The timed appends run with no forced collection; the two collections (before and after) only measure retention.
import { chromium, type Page } from "playwright";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: new URL("..", import.meta.url).pathname },
    port: { type: "string", default: "4191" },
    fixture: { type: "string", default: "lines" },
    runs: { type: "string", default: "10" },
    appends: { type: "string", default: "100" },
    chars: { type: "string" },
    lines: { type: "string" },
    warmup: { type: "string", default: "0" },
    classes: { type: "boolean", default: false },
    "max-growth-kib": { type: "string" },
  },
});
const port = Number(values.port);
const runs = Number(values.runs);
const maxGrowthKiB = values["max-growth-kib"] === undefined ? undefined : Number(values["max-growth-kib"]);
if (maxGrowthKiB !== undefined && (!Number.isFinite(maxGrowthKiB) || maxGrowthKiB < 0)) throw new Error("--max-growth-kib must be a non-negative number");
const appends = Number(values.appends);
const warmup = Number(values.warmup);
const query = new URLSearchParams({ viewerFixture: values.fixture! });
if (values.lines) query.set("viewerLines", values.lines);
const url = `http://127.0.0.1:${port}/gallery.html?${query}`;
const delta = (index: number) => values.chars ? `\n${"p".repeat(Number(values.chars) - 1)}` : `\npaired tail ${index}`;
const percentile = (list: number[], fraction: number) => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
};
const median = (list: number[]) => percentile(list, 0.5);

const preview = spawn("bun", ["x", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: values.root, stdio: "ignore" });
const browser = await chromium.launch({ args: ["--js-flags=--expose-gc"] });

async function retained(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const { usedSize } = await cdp.send("Runtime.getHeapUsage");
  await cdp.detach();
  return usedSize;
}

// Live count and self size by class: an object's constructor name, or the node type in parentheses for strings, code
// and other non-objects. Taken after the forced collections of `retained`, so it counts only live nodes.
async function classes(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const chunks: string[] = [];
  cdp.on("HeapProfiler.addHeapSnapshotChunk", ({ chunk }) => chunks.push(chunk));
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  await cdp.detach();
  const { snapshot: { meta }, nodes, strings } = JSON.parse(chunks.join("")) as { snapshot: { meta: { node_fields: string[]; node_types: [string[]] } }; nodes: number[]; strings: string[] };
  const width = meta.node_fields.length;
  const [typeAt, nameAt, sizeAt] = ["type", "name", "self_size"].map((field) => meta.node_fields.indexOf(field)) as [number, number, number];
  const result = new Map<string, { count: number; size: number }>();
  for (let at = 0; at < nodes.length; at += width) {
    const type = meta.node_types[0][nodes[at + typeAt]!]!;
    const key = type === "object" ? strings[nodes[at + nameAt]!]! : `(${type})`;
    const entry = result.get(key) ?? { count: 0, size: 0 };
    entry.count++;
    entry.size += nodes[at + sizeAt]!;
    result.set(key, entry);
  }
  return result;
}

const growth = (before: Map<string, { count: number; size: number }>, after: Map<string, { count: number; size: number }>) =>
  [...after].map(([key, { count, size }]) => ({ key, count: count - (before.get(key)?.count ?? 0), size: size - (before.get(key)?.size ?? 0) }))
    .filter(({ count, size }) => count !== 0 || size !== 0)
    .sort((a, b) => Math.abs(b.size) - Math.abs(a.size))
    .slice(0, 12)
    .map(({ key, count, size }) => `${key} ${count >= 0 ? "+" : ""}${count} (${size >= 0 ? "+" : ""}${size} B)`)
    .join("; ");

// One append in its own frame: from the frame's start to the viewer's first DOM mutation (as the layout gate measures).
const appendWall = (page: Page, index: number) => page.evaluate((tail) => new Promise<number>((resolve) => requestAnimationFrame(() => {
  const target = window as typeof window & { __appendViewerFixture: (delta: string) => void };
  const observer = new MutationObserver(() => {
    observer.disconnect();
    resolve(performance.now() - started);
  });
  observer.observe(document.querySelector('[data-part="tool-body"]')!, { childList: true, subtree: true, characterData: true, attributes: true });
  const started = performance.now();
  target.__appendViewerFixture(tail);
})), delta(index));

// Main-thread task time of one append (CDP TaskDuration, as the layout gate's task samples): it includes the work
// after the first mutation and any collection the append causes, so a sticky slow state shows here.
async function append(page: Page, index: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const task = async () => (await cdp.send("Performance.getMetrics")).metrics.find((metric) => metric.name === "TaskDuration")?.value ?? 0;
  const before = await task();
  const wall = await appendWall(page, index);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));
  const ms = (await task() - before) * 1_000;
  await cdp.detach();
  return { wall, task: ms };
}

try {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await fetch(url); break; } catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  const results: { first: number; last: number; growth: number; added: number; switched: boolean }[] = [];
  for (let run = 0; run < runs; run++) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const throttle = await page.context().newCDPSession(page);
    await throttle.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await throttle.detach();
    await page.goto(url);
    await page.getByRole("button", { name: /^open all/ }).click();
    await page.locator('[data-part="text-viewer"]').waitFor();
    await page.waitForTimeout(500);
    for (let index = 0; index < warmup; index++) await appendWall(page, index);
    const before = await retained(page);
    const classesBefore = values.classes ? await classes(page) : undefined;
    const samples: { wall: number; task: number }[] = [];
    let added = 0;
    for (let index = 0; index < appends; index++) { added += delta(warmup + index).length; samples.push(await append(page, warmup + index)); }
    const times = samples.map(({ task }) => task);
    const walls = samples.map(({ wall }) => wall);
    await page.waitForTimeout(200);
    const after = await retained(page);
    if (classesBefore) {
      const classesAfter = await classes(page);
      const ropes = (classesAfter.get("(concatenated string)")?.count ?? 0) - (classesBefore.get("(concatenated string)")?.count ?? 0);
      console.log(`run ${run + 1} classes: rope nodes ${ropes >= 0 ? "+" : ""}${ropes}; ${growth(classesBefore, classesAfter)}`);
    }
    const first = median(times.slice(0, 20));
    const last = median(times.slice(-20));
    const result = { first, last, growth: after - before, added, switched: last > first * 1.2 };
    results.push(result);
    console.log(`run ${run + 1}: task first 20 median ${first.toFixed(2)} ms, last 20 ${last.toFixed(2)} ms (${(last / first).toFixed(2)}x)${result.switched ? " SWITCHED" : ""}; retained heap +${(result.growth / 1024).toFixed(0)} KiB over ${appends} appends adding ${added} chars (${(result.growth / appends).toFixed(0)} B per append, ${(result.growth / added).toFixed(2)} B per char); wall first/last 20 ${median(walls.slice(0, 20)).toFixed(2)}/${median(walls.slice(-20)).toFixed(2)} ms; task times ${times.map((time) => time.toFixed(1)).join(" ")}`);
    await page.close();
  }
  const switched = results.filter(({ switched }) => switched).length;
  const retainedGrowth = results.map(({ growth }) => growth);
  const retainedMedian = median(retainedGrowth) / 1024;
  const retainedP90 = percentile(retainedGrowth, 0.9) / 1024;
  const retainedMax = Math.max(...retainedGrowth) / 1024;
  console.log(`summary ${values.fixture}${values.lines ? ` ${values.lines} lines` : ""}, 4x CPU throttle, ${appends} appends of ${values.chars ?? "~15"} chars after ${warmup} warm-up: switched ${switched}/${runs}; first-20 medians ${median(results.map(({ first }) => first)).toFixed(2)} ms, last-20 ${median(results.map(({ last }) => last)).toFixed(2)} ms; retained growth median ${retainedMedian.toFixed(0)} KiB, p90 ${retainedP90.toFixed(0)} KiB, max ${retainedMax.toFixed(0)} KiB`);
  if (maxGrowthKiB !== undefined && retainedMax > maxGrowthKiB) {
    console.error(`FAIL retained heap: ${retainedMax.toFixed(0)} KiB max exceeds ${maxGrowthKiB} KiB budget`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  preview.kill();
}
