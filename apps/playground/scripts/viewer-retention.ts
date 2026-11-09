// A long-lived text viewer: one page, many appends. Reports per-append time (first 20 vs last 20 median) and the heap
// retained after a forced garbage collection, before and after the appends. Not a CI gate: a measurement harness for
// a viewer whose append cost doubled for the rest of the page's life once it switched (batch-k results, 2026-11-08).
// Needs a production build (`bun run build`). Usage:
//   bun scripts/viewer-retention.ts [--root <playground dir>] [--port 4191] [--fixture lines|single|read] [--lines N]
//     [--runs 10] [--appends 100] [--chars N] [--warmup N]
// `--chars N`: each append is a newline and N - 1 letters (default: "\npaired tail <i>"). `--lines N`: the read
// fixture's line count. `--warmup N`: appends before the first heap reading; they fill fixed-size caches (the virtual
// engine's 2,000-entry action log) and warm the JIT, so the measured growth is only what scales.
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
  },
});
const port = Number(values.port);
const runs = Number(values.runs);
const appends = Number(values.appends);
const warmup = Number(values.warmup);
const query = new URLSearchParams({ viewerFixture: values.fixture! });
if (values.lines) query.set("viewerLines", values.lines);
const url = `http://127.0.0.1:${port}/gallery.html?${query}`;
const delta = (index: number) => values.chars ? `\n${"p".repeat(Number(values.chars) - 1)}` : `\npaired tail ${index}`;
const median = (list: number[]) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]!;

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
    await page.goto(url);
    await page.getByRole("button", { name: /^open all/ }).click();
    await page.locator('[data-part="text-viewer"]').waitFor();
    await page.waitForTimeout(500);
    for (let index = 0; index < warmup; index++) await appendWall(page, index);
    const before = await retained(page);
    const samples: { wall: number; task: number }[] = [];
    let added = 0;
    for (let index = 0; index < appends; index++) { added += delta(warmup + index).length; samples.push(await append(page, warmup + index)); }
    const times = samples.map(({ task }) => task);
    const walls = samples.map(({ wall }) => wall);
    await page.waitForTimeout(200);
    const after = await retained(page);
    const first = median(times.slice(0, 20));
    const last = median(times.slice(-20));
    const result = { first, last, growth: after - before, added, switched: last > first * 1.2 };
    results.push(result);
    console.log(`run ${run + 1}: task first 20 median ${first.toFixed(2)} ms, last 20 ${last.toFixed(2)} ms (${(last / first).toFixed(2)}x)${result.switched ? " SWITCHED" : ""}; retained heap +${(result.growth / 1024).toFixed(0)} KiB over ${appends} appends adding ${added} chars (${(result.growth / appends).toFixed(0)} B per append, ${(result.growth / added).toFixed(2)} B per char); wall first/last 20 ${median(walls.slice(0, 20)).toFixed(2)}/${median(walls.slice(-20)).toFixed(2)} ms; task times ${times.map((time) => time.toFixed(1)).join(" ")}`);
    await page.close();
  }
  const switched = results.filter(({ switched }) => switched).length;
  console.log(`summary ${values.fixture}${values.lines ? ` ${values.lines} lines` : ""}, ${appends} appends of ${values.chars ?? "~15"} chars after ${warmup} warm-up: switched ${switched}/${runs}; first-20 medians ${median(results.map(({ first }) => first)).toFixed(2)} ms, last-20 ${median(results.map(({ last }) => last)).toFixed(2)} ms; retained growth median ${(median(results.map(({ growth }) => growth)) / 1024).toFixed(0)} KiB, max ${(Math.max(...results.map(({ growth }) => growth)) / 1024).toFixed(0)} KiB`);
} finally {
  await browser.close();
  preview.kill();
}
