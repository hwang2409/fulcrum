// Large highlighted blocks in real chromium, with the page's CPU throttled (CPU_THROTTLE, default 4; the worker is not
// throttled). On a page that already shows a run, a markdown fence of 9,999 cpp lines (329,968 tokens) must mount, color,
// and scroll a page per frame without real jank; its first visible lines must color without waiting for the whole block; the bounded view must scroll by
// keyboard, copy the whole text, and let find-in-page reach its visible lines. Timing checks use five measured samples
// after a discarded warm-up: two samples with a task over 80 ms fail, while any task over 150 ms is pathological.
// This tolerates one scheduler or GC spike on a loaded CI runner while rejecting repeated visible jank.
// A small block asked for while a
// 330k-token result is still being delivered must color within two frames of the time it takes on its own. A fence
// under the whole-block cap must send its mounted ranges to the worker before its whole block, and a small block asked
// for right after it mounts must still color in time. LINES sets
// the fence size (to measure the inline path, or a base without the bounded view). Runs vite's dev server with
// production react.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { closeBrowser, stopChild } from "./lifecycle";

const app = new URL("../", import.meta.url);
const fixture = new URL(".large-blocks-test.html", app);
const port = 4176;
const lines = Number(process.env.LINES ?? 9_999);
const throttle = Number(process.env.CPU_THROTTLE ?? 4);
await writeFile(fixture, `<!doctype html><body><div id="root"></div><script type="module">
import "@fulcrum/react/styles.css";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createHighlighter } from "@fulcrum/highlight";
import { Markdown } from "@fulcrum/markdown/react";
import { parseMarkdown } from "@fulcrum/markdown";
import { createRunStore } from "@fulcrum/core";
import { Message, RunProvider, Timeline, ToolCall } from "@fulcrum/react";
const line = "A<B<C,D>,E<F>>::g(h++,--i,j+=k,l?m:n); // x\\n";
const code = "int first_marker = 1;\\n" + line.repeat(${lines} - 2) + "int last_marker = 2;\\n";
const bigCode = line.repeat(9_999);
const small = "int main() { return 0; }\\n";
const typed = (tokens) => tokens.some((token) => token.type);
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
const until = async (test, ms = 120_000) => { const end = performance.now() + ms; while (!test()) { if (performance.now() > end) throw new Error("timed out"); await new Promise((resolve) => setTimeout(resolve, 5)); } };
async function measure(run) {
  const tasks = [];
  const observer = new PerformanceObserver((list) => tasks.push(...list.getEntries().map((entry) => entry.duration)));
  observer.observe({ type: "longtask", buffered: false });
  let last = performance.now(), gap = 0;
  const probe = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; }, 5);
  let result;
  try { result = await run(); }
  finally { await nextFrame(); clearInterval(probe); observer.disconnect(); }
  return { ...result, longTasks: tasks, maxLongTask: Math.max(0, ...tasks), maxProbeGap: gap };
}
const highlight = createHighlighter();
const warm = { id: "warm", version: 1, state: "done" };
const warmed = new Promise((resolve) => { const stop = highlight.subscribe(warm.id, () => { stop(); resolve(); }); });
await highlight(small, "cpp", warm);
await warmed;
const results = {};
// The small block on its own, then asked for right after the first part of a 330k-token result reaches the page.
const own = performance.now();
await highlight(small, "cpp", { id: "own", version: 1, state: "done" });
const ownMs = performance.now() - own;
const big = highlight(bigCode, "cpp", { id: "big", version: 1, state: "done" });
await until(() => window.__parts > 0);
const asked = performance.now();
const behind = await highlight(small.replace("0", "1"), "cpp", { id: "behind", version: 1, state: "done" });
const behindMs = performance.now() - asked;
const bigTokens = await big;
results.queue = { ownMs: Math.round(ownMs), behindMs: Math.round(behindMs), smallColored: typed(behind), bigTokens: bigTokens.length, bigColored: typed(bigTokens), longTasks: [], maxLongTask: 0, maxProbeGap: 0 };
// The markdown fence, from mount until its first lines are colored, and then for one more second.
const fence = "\`\`\`cpp\\n" + code + "\`\`\`\\n";
const parsing = performance.now();
parseMarkdown(fence);
const parseMs = Math.round(performance.now() - parsing); // the markdown parse alone, which the mount includes
const root = createRoot(document.getElementById("root"));
// A page that already shows a run: react, the styles, and a small fence are in place before the large block arrives.
flushSync(() => root.render(createElement(Markdown, { id: "small", source: "\`\`\`cpp\\n" + small + "\`\`\`\\n", highlight })));
await nextFrame();
await nextFrame();
const block = () => document.querySelector("[data-part=md-code-block]");
// A fence under the whole-block cap (220 dense lines, 9,900 characters): its mounted ranges go to the worker first and
// color, then the whole block is asked for; a small block asked for right after the mount still colors in time.
const underRoot = createRoot(document.body.appendChild(document.createElement("div")));
results.under = await measure(async () => {
  const from = window.__posted.length;
  const started = performance.now();
  flushSync(() => underRoot.render(createElement(Markdown, { id: "under", source: "\`\`\`cpp\\n" + line.repeat(220) + "\`\`\`\\n", highlight })));
  const asked = performance.now();
  const smallTokens = await highlight(small.replace("0", "2"), "cpp", { id: "behind-under", version: 1, state: "done" });
  const behindMs = performance.now() - asked;
  const viewer = () => document.querySelector("[data-part=md-code-block][data-size=large]");
  await until(() => viewer()?.querySelector("[class^=tok-]"));
  const colorMs = performance.now() - started;
  await until(() => window.__posted.slice(from).some((post) => post.id.endsWith(":whole") && window.__replied[post.requestId]), 10_000).catch(() => {});
  const posts = window.__posted.slice(from).filter((post) => post.id.startsWith("under"));
  const wholeAt = posts.findIndex((post) => post.id.endsWith(":whole"));
  const whole = posts[wholeAt];
  underRoot.unmount();
  return { colorMs: Math.round(colorMs), behindMs: Math.round(behindMs), smallColored: typed(smallTokens), ranges: wholeAt, wholeAfterRanges: wholeAt > 0, wholeMs: whole && window.__replied[whole.requestId] ? Math.round(window.__replied[whole.requestId] - whole.at) : null };
});
results.markdown = await measure(async () => {
  const started = performance.now();
  flushSync(() => root.render(createElement(Markdown, { id: "large", source: fence, highlight })));
  const mountMs = performance.now() - started;
  await until(() => block()?.querySelector("[class^=tok-]"));
  const colorMs = performance.now() - started;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return { parseMs, mountMs: Math.round(mountMs), colorMs: Math.round(colorMs), spans: block().querySelectorAll("[class^=tok-]").length, elements: block().querySelectorAll("*").length };
});
// Scrolling the bounded view a page per frame: each frame mounts and colors new rows.
const viewer = block().querySelector("[data-part=text-viewer]");
if (viewer) results.scroll = await measure(async () => {
  let worstFrame = 0;
  for (let frame = 0, last = performance.now(); frame < 120; frame++) {
    viewer.scrollTop += viewer.clientHeight;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const now = performance.now();
    worstFrame = Math.max(worstFrame, now - last);
    last = now;
  }
  viewer.scrollTop = 0;
  return { worstFrame: Math.round(worstFrame) };
});
// An opened read viewer of the same file, scrolled a page per frame: highlighted ranges by the same rule as the fence.
root.render(null);
await nextFrame();
const store = createRunStore();
const call = { id: "r", name: "read", arguments: { path: "a.cpp" } };
store.dispatch({ type: "tool_start", tool_call: call, view: { kind: "read", path: "a.cpp" } });
store.dispatch({ type: "tool_end", tool_call: call, tool_result: { tool_call_id: "r", content: code, is_error: false } });
await nextFrame(); // the store applies events on the next frame
flushSync(() => root.render(createElement(RunProvider, { store, highlight }, createElement(ToolCall, { id: "tool:r" }))));
const card = document.querySelector("[data-id='tool:r']");
if (card.tagName === "DETAILS" && !card.open) { card.open = true; card.dispatchEvent(new Event("toggle")); }
await nextFrame();
const readSamples = [];
let readWarmup;
for (let sample = 0; sample < 6; sample++) {
  if (sample) {
    root.render(null);
    await nextFrame();
    flushSync(() => root.render(createElement(RunProvider, { store, highlight }, createElement(ToolCall, { id: "tool:r" }))));
    const nextCard = document.querySelector("[data-id='tool:r']");
    if (nextCard.tagName === "DETAILS" && !nextCard.open) { nextCard.open = true; nextCard.dispatchEvent(new Event("toggle")); }
    await nextFrame();
  }
  const measured = await measure(async () => {
    flushSync(() => document.querySelector("[data-id='tool:r'] [data-action=open-viewer]").click());
    const readViewer = document.querySelector("[data-id='tool:r'] [data-part=text-viewer]");
    await until(() => readViewer.querySelector("[class^=tok-]"));
    for (let frame = 0; frame < 120; frame++) {
      if (${JSON.stringify(Number(process.env.TIMING_GATE_SLOWDOWN_MS ?? 0))}) {
        const untilTime = performance.now() + ${JSON.stringify(Number(process.env.TIMING_GATE_SLOWDOWN_MS ?? 0))};
        while (performance.now() < untilTime) { /* deliberate proof slowdown */ }
      }
      readViewer.scrollTop += readViewer.clientHeight;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const colored = await until(() => readViewer.querySelector("[class^=tok-]"), 10_000).then(() => true, () => false);
    return { rows: readViewer.querySelectorAll("[data-part=text-viewer-row]").length, colored };
  });
  if (sample === 0) readWarmup = measured;
  else readSamples.push(measured);
}
results.readWarmup = readWarmup;
results.readSamples = readSamples;
results.read = readSamples.at(-1);
// Bounded tool output: 10 MiB streamed as 1 KiB appends into a store with a synchronous scheduler, so each sample is
// one dispatch through every subscriber's return, under the page's CPU throttle (CI calibrates it to 2x; the design's
// budgets were set at 4x, the local default). A frame every 64 appends keeps each observed task a real work slice.
results.toolOutput = await measure(async () => {
  const outputStore = createRunStore((flush) => flush());
  const outputCall = { id: "bounded", name: "shell", arguments: { command: "generate-output" } };
  const samples = [];
  for (let index = 0; index < 10 * 1024; index++) {
    const started = performance.now();
    outputStore.dispatch({ type: "tool_output", tool_call: outputCall, output: "x".repeat(1023) + "\\n" });
    samples.push(performance.now() - started);
    if (index % 64 === 63) await nextFrame();
  }
  outputStore.dispatch({ type: "tool_end", tool_call: outputCall, tool_result: { tool_call_id: "bounded", content: "", is_error: false } });
  samples.sort((a, b) => a - b);
  const item = outputStore.getItem("tool:bounded");
  const postsBefore = window.__posted.length;
  flushSync(() => root.render(createElement(RunProvider, { store: outputStore, highlight }, createElement(ToolCall, { id: "tool:bounded" }))));
  await nextFrame();
  const closedPosts = window.__posted.length - postsBefore;
  const outputCard = document.querySelector("[data-id='tool:bounded']");
  const openStarted = performance.now();
  if (outputCard.tagName === "DETAILS" && !outputCard.open) { outputCard.open = true; outputCard.dispatchEvent(new Event("toggle")); }
  await nextFrame();
  const openMs = performance.now() - openStarted;
  return {
    p95DispatchMs: samples[Math.floor(samples.length * 0.95)], maxDispatchMs: samples.at(-1), logicalBytes: item?.type === "tool" ? item.output.bytes : 0,
    retainedBytes: item?.type === "tool" ? item.output.retainedBytes : 0, closedHighlightRequests: closedPosts, openMs,
    notice: !!outputCard.textContent.match(/\\d+\\.\\d MB of 10.0 MB not kept/),
    mountedRanges: document.querySelectorAll("[data-id='tool:bounded'] [data-part=text-viewer-row]").length,
    outputNodes: document.querySelectorAll("[data-id='tool:bounded'] [data-part=tool-body] *").length,
  };
});
// One oversized replacement (a third-party event carrying 64 MiB): exact bytes and the tail's line numbers need one
// scan on the main thread. Reported, not bounded: the 10 MiB streaming bounds above are the gate.
{
  const replaceStore = createRunStore((flush) => flush());
  const replaceCall = { id: "replace", name: "shell", arguments: {} };
  const huge = "r".repeat(64 * 1024 * 1024 - 1) + "\\n";
  const started = performance.now();
  replaceStore.dispatch({ type: "tool_output", tool_call: replaceCall, output: huge, replace: true });
  const item = replaceStore.getItem("tool:replace");
  results.toolReplacement = { dispatchMs: Math.round(performance.now() - started), retainedBytes: item.output.retainedBytes, logicalBytes: item.output.bytes };
}
// Heap probe (run from the gate through CDP): keep 32 KiB of each of "count" fresh 10 MiB parents, as plain slices
// (the control, which V8 backs by the parent) or as one store's tool outputs.
window.__retain = (mode, count) => {
  const kept = [];
  const store = createRunStore((flush) => flush(), { toolOutputItemBytes: 32 * 1024, toolOutputRunBytes: 1024 * 1024 * 1024 });
  for (let index = 0; index < count; index++) {
    const parent = String(index).padStart(8, "0").concat("x".repeat(10 * 1024 * 1024)).toLowerCase();
    if (mode === "slice") kept.push(parent.slice(-32 * 1024));
    else store.dispatch({ type: "tool_output", tool_call: { id: String(index), name: "bash", arguments: {} }, output: parent });
  }
  window.__kept = [kept, store];
};
root.render(createElement(Markdown, { id: "large", source: fence, highlight }));
await nextFrame();
await nextFrame();
// Code-heavy rows in a non-virtual timeline, whose off-screen rows content-visibility skips: the node side counts the
// layouts their mount forces. Every fence overflows its row, so a per-box layout read on mount costs one layout per row.
window.__codeRows = async (count) => {
  const store = createRunStore();
  const fenceLine = "const deliberatelyLongName = compute(first, second, third, fourth, fifth, sixth, seventh);";
  for (let i = 0; i < count; i++) store.dispatch({ type: "message_commit", message_id: "c" + i, message: { role: "assistant", content: [{ type: "text", text: "row " + i + "\\n\\n\`\`\`ts\\n" + fenceLine + "\\n\`\`\`" }] } });
  await nextFrame(); // the store applies events on the next frame
  const host = document.body.appendChild(document.createElement("div"));
  host.style.cssText = "height:800px;overflow:auto";
  const rowsRoot = createRoot(host);
  const renderers = { message: ({ id }) => createElement(Message, { id, markdown: Markdown }) };
  window.__codeRowsUnmount = () => { rowsRoot.unmount(); host.remove(); };
  rowsRoot.render(createElement(RunProvider, { store }, createElement(Timeline, { virtual: false, renderers })));
  for (let frame = 0; frame < 6; frame++) await new Promise(requestAnimationFrame);
  const blocks = host.querySelectorAll("[data-part=md-code-block]");
  return { blocks: blocks.length, stops: host.querySelectorAll("[data-part=md-code-block][tabindex='0']").length, lastStop: blocks[blocks.length - 1]?.getAttribute("tabindex") === "0" };
};
window.__code = code;
window.__results = results;
</script>`);
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: app.pathname, stdio: "ignore", env: { ...process.env, NODE_ENV: "production" } }); // production react: the development build is several times slower
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let browserPid: number | undefined;
type Measured = { longTasks: number[]; maxLongTask: number; maxProbeGap: number; [key: string]: unknown };
const failures: string[] = [];
try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/.large-blocks-test.html`)).ok) break; } catch {}
    if (vite.exitCode !== null || attempt === 100) throw new Error("vite did not start");
    await Bun.sleep(100);
  }
  browser = await chromium.launch();
  // The browser's own pid, so a stuck close can be killed without touching any other chromium on the machine.
  const { processInfo } = await (await browser.newBrowserCDPSession()).send("SystemInfo.getProcessInfo");
  browserPid = processInfo.find((info) => info.type === "browser")?.id;
  const context = await browser.newContext({ viewport: { width: 1024, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://127.0.0.1:${port}` });
  const page = await context.newPage();
  if (throttle > 1) await (await context.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: throttle });
  await page.addInitScript(() => {
    const scope = window as typeof window & { __parts: number };
    scope.__parts = 0;
    const Native = window.Worker;
    Object.defineProperty(window, "Worker", { value: class extends Native {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener("message", (event) => {
          if (event.data && "part" in event.data) scope.__parts++;
          if (event.data && "requestId" in event.data) (window as typeof window & { __replied: Record<number, number> }).__replied[event.data.requestId] ??= performance.now();
        });
      }
    } });
  });
  page.on("pageerror", (error) => failures.push(error.message));
  // Every highlight request the page posts to the worker, in order, and when each reply arrived.
  await page.addInitScript(() => {
    const scope = window as typeof window & { __posted: Array<{ id: string; requestId: number; at: number }>; __replied: Record<number, number> };
    scope.__posted = [];
    scope.__replied = {};
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, data: { type?: string; requestId: number; context: { id: string } }, ...rest: [never]) {
      if (data?.type === "highlight") scope.__posted.push({ id: data.context.id, requestId: data.requestId, at: performance.now() });
      return post.call(this, data, ...rest);
    } as typeof post;
  });
  await page.goto(`http://127.0.0.1:${port}/.large-blocks-test.html`);
  console.log("page result wait start");
  const results = await page.waitForFunction(() => (window as typeof window & { __results?: unknown }).__results, undefined, { timeout: 240_000 })
    .then((handle) => handle.jsonValue()).catch((error) => { throw new Error([...failures, String(error)].join("\n")); })
    .finally(() => console.log("page result wait end")) as Record<string, Measured>;
  for (const [name, result] of Object.entries(results)) {
    if (name === "readSamples" || name === "readWarmup" || name === "toolReplacement") continue;
    const { longTasks, ...rest } = result as Measured;
    console.log(`${name}\tlong tasks ${longTasks.length}\tmax ${result.maxLongTask.toFixed(1)} ms\tmax probe gap ${result.maxProbeGap.toFixed(1)} ms\t${JSON.stringify(rest)}`);
    if (name !== "read" && longTasks.length) failures.push(`${name}: a main-thread task reached 50 ms`);
    // The mount's gap also holds markdown's one-shot parse of the 440 kB message (about 11 ms at 4x), which runs in the
    // same task and is not this path's work: there only long tasks fail, and the gap is reported.
    // The probe gap also holds runner scheduling jitter (one CI run measured 51.1 ms with no long task). The bug it
    // guards froze the page for 5,388 ms, so the gap bound is 100 ms; real 50 ms tasks still fail through longTasks.
    if (name !== "markdown" && result.maxProbeGap >= 100) failures.push(`${name}: the main thread was busy for ${result.maxProbeGap.toFixed(1)} ms`);
  }
  const readSamples = results.readSamples as Measured[];
  const readLongTaskCounts = readSamples.map((sample) => sample.longTasks.length);
  const affectedReadSamples = readSamples.filter((sample) => sample.longTasks.some((task) => task > 80)).length;
  const readMaxTask = Math.max(0, ...readSamples.flatMap((sample) => sample.longTasks));
  console.log(`read timing samples: counts [${readLongTaskCounts.join(", ")}], max tasks [${readSamples.map((sample) => sample.maxLongTask.toFixed(1)).join(", ")}] ms`);
  if (affectedReadSamples >= 2) failures.push(`read: ${affectedReadSamples} of five samples had a main-thread task over 80 ms`);
  if (readMaxTask > 150) failures.push(`read: pathological main-thread task ${readMaxTask.toFixed(1)} ms`);
  if (!results.read?.colored) failures.push("read: the scrolled-to rows of the opened read viewer never colored");
  const { toolOutput, toolReplacement } = results;
  console.log(`tool output replacement: ${JSON.stringify(toolReplacement)}`);
  if ((toolOutput.p95DispatchMs as number) > 1) failures.push(`tool output: p95 append dispatch took ${Number(toolOutput.p95DispatchMs).toFixed(3)} ms (limit 1 ms)`);
  if ((toolOutput.logicalBytes as number) !== 10 * 1024 * 1024 || (toolOutput.retainedBytes as number) > 2 * 1024 * 1024) failures.push(`tool output: retention result was invalid (${JSON.stringify(toolOutput)})`);
  if ((toolReplacement.logicalBytes as number) !== 64 * 1024 * 1024 || (toolReplacement.retainedBytes as number) > 2 * 1024 * 1024) failures.push(`tool output: the replacement was not bounded (${JSON.stringify(toolReplacement)})`);
  if (!toolOutput.notice) failures.push("tool output: the opened card does not say how much was not kept");
  if ((toolOutput.openMs as number) > 50) failures.push(`tool output: open took ${Number(toolOutput.openMs).toFixed(1)} ms (limit 50 ms)`);
  if ((toolOutput.mountedRanges as number) > 200 || (toolOutput.outputNodes as number) > 500) failures.push(`tool output: mounted work exceeded the viewer bounds (${JSON.stringify(toolOutput)})`);
  // Retained tool text owns its strings: 24 more 10 MiB parents must not stay alive. The control (plain slices) must
  // show them, or this engine cannot tell the difference and the probe proves nothing.
  const heapCdp = await context.newCDPSession(page);
  const heapGrowth = async (mode: string, count: number) => {
    await heapCdp.send("HeapProfiler.collectGarbage");
    const before = (await heapCdp.send("Runtime.getHeapUsage")).usedSize;
    await page.evaluate(([retainMode, retainCount]) => (window as typeof window & { __retain(mode: string, count: number): void }).__retain(retainMode as string, retainCount as number), [mode, count]);
    await heapCdp.send("HeapProfiler.collectGarbage");
    const after = (await heapCdp.send("Runtime.getHeapUsage")).usedSize;
    await page.evaluate(() => { (window as typeof window & { __kept?: unknown }).__kept = undefined; });
    return (after - before) / (1024 * 1024);
  };
  const sliceGrowth = (await heapGrowth("slice", 32)) - (await heapGrowth("slice", 8));
  const storeGrowth = (await heapGrowth("store", 32)) - (await heapGrowth("store", 8));
  console.log(`tool output heap, 8 -> 32 parents of 10 MiB: plain slices +${sliceGrowth.toFixed(1)} MiB, store +${storeGrowth.toFixed(1)} MiB`);
  if (sliceGrowth < 100) failures.push(`tool output heap: the control kept only ${sliceGrowth.toFixed(1)} MiB for 24 more parents, so the probe cannot see a retained parent`);
  if (storeGrowth > 2) failures.push(`tool output heap: the store kept ${storeGrowth.toFixed(1)} MiB for 24 more parents (32 KiB each is under 1 MiB)`);
  const { queue } = results;
  if (!queue.smallColored || !queue.bigColored) failures.push(`queue: both blocks must color (${JSON.stringify(queue)})`);
  // The regression this guards is the small block waiting for the whole large one: 325-335 ms on main before the fix.
  // Two or three frames of scheduling (34-50 ms) are noise on a loaded CI runner, so the bound sits well between them.
  if ((queue.behindMs as number) > (queue.ownMs as number) + 100) failures.push(`queue: the small block took ${queue.behindMs} ms behind the large one, ${queue.ownMs} ms on its own`);
  const { under } = results;
  if (!under.wholeAfterRanges) failures.push(`under the cap: the whole block was asked for before the mounted ranges (${JSON.stringify(under)})`);
  if (under.wholeMs === null) failures.push("under the cap: the whole block was never asked for or never answered");
  if (!under.smallColored || (under.behindMs as number) > (queue.ownMs as number) + 100) failures.push(`under the cap: a small block took ${under.behindMs} ms behind the fence, ${queue.ownMs} ms on its own`);
  // The bounded view: keyboard scrolling, whole-text copy, find-in-page.
  const viewer = page.locator("[data-part=md-code-block] [data-part=text-viewer]");
  if (!(await viewer.count())) failures.push("markdown: the large fence has no bounded viewer");
  else {
    const indicator = await page.locator("[data-part=md-code-block] [data-part=text-viewer-count]").textContent();
    if (!indicator?.includes(lines.toLocaleString("en-US") + " lines")) failures.push(`markdown: the line indicator reads "${indicator}"`);
    if (!(await page.evaluate(() => window.find("first_marker")))) failures.push("markdown: find-in-page did not reach the first line");
    await viewer.focus();
    await page.keyboard.press("End");
    const reached = await page.waitForFunction(() => {
      const last = [...document.querySelectorAll("[data-part=md-code-block] [data-part=text-viewer-row]")].find((row) => row.textContent!.includes("last_marker"));
      return !!last?.querySelector("[class^=tok-]");
    }, undefined, { timeout: 10_000 }).then(() => true, () => false);
    if (!reached) failures.push("markdown: End did not scroll to a colored last line");
    await page.evaluate(() => getSelection()?.removeAllRanges());
    if (!(await page.evaluate(() => window.find("last_marker")))) failures.push("markdown: find-in-page did not reach the visible last line");
    await page.locator("[data-part=md-code-block] [data-action=copy]").click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    const code = await page.evaluate(() => (window as typeof window & { __code: string }).__code);
    if (copied !== code) failures.push(`markdown: copy gave ${copied.length} characters, expected ${code.length}`);
  }
  // A code or table box becomes a keyboard tab stop from the browser's own layout, never from a read on mount: a read per
  // box lays out every row content-visibility skips (201 forced layouts for 200 rows, 5,001 for 5,000 measured on the
  // read; 3 without it).
  const metrics = await context.newCDPSession(page);
  await metrics.send("Performance.enable");
  const layoutCount = async () => (await metrics.send("Performance.getMetrics")).metrics.find((metric) => metric.name === "LayoutCount")?.value ?? 0;
  const rowCount = 200;
  const layoutsBefore = await layoutCount();
  const rows = await page.evaluate((count) => (window as typeof window & { __codeRows: (count: number) => Promise<{ blocks: number; stops: number; lastStop: boolean }> }).__codeRows(count), rowCount);
  const mountLayouts = (await layoutCount()) - layoutsBefore;
  console.log(`code rows\t${rowCount} rows\tlayouts ${mountLayouts}\t${JSON.stringify(rows)}`);
  if (rows.blocks !== rowCount) failures.push(`code rows: ${rows.blocks} of ${rowCount} code blocks mounted`);
  if (mountLayouts >= rowCount / 4) failures.push(`code rows: mounting ${rowCount} rows forced ${mountLayouts} layouts; a per-box layout read on mount defeats content-visibility`);
  if (!rows.stops) failures.push("code rows: no visible overflowing code block became a tab stop");
  if (rows.lastStop) failures.push("code rows: an off-screen row was laid out on mount (its code block is already a tab stop)");
  // Scrolled into view, the last row is laid out: its box becomes a tab stop that Tab reaches from the box before it.
  const last = page.locator("[data-part=md-code-block]").last();
  await last.evaluate((node) => node.scrollIntoView({ block: "end" }));
  const reachable = await page.waitForFunction(() => [...document.querySelectorAll("[data-part=md-code-block]")].at(-1)?.getAttribute("tabindex") === "0", undefined, { timeout: 10_000 }).then(() => true, () => false);
  if (!reachable) failures.push("code rows: the last code block never became a tab stop after it scrolled into view");
  else {
    await page.locator("[data-part=md-code-block]").nth(-2).focus();
    await page.keyboard.press("Tab");
    if (!(await last.evaluate((node) => node === document.activeElement))) failures.push(`code rows: Tab from the box before did not reach the last code block (focused ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))})`);
  }
  await page.evaluate(() => (window as typeof window & { __codeRowsUnmount: () => void }).__codeRowsUnmount());
  await metrics.detach();
  if (failures.length) throw new Error(failures.join("\n"));
  console.log("large blocks: ok");
} catch (error) {
  // Printed before cleanup, so a cleanup that later hangs or fails cannot hide why the check failed.
  console.error(error);
  process.exitCode = 1;
}
// Each cleanup step is bounded and runs even when an earlier one failed; a cleanup failure fails the check.
const cleanup: Array<[string, () => Promise<unknown>]> = [
  ["browser", () => browser ? closeBrowser("large-blocks cleanup: browser.close", async () => {
    for (const context of browser!.contexts()) await context.close();
    await browser!.close();
  }, browserPid) : Promise.resolve()],
  ["vite", () => stopChild("large-blocks cleanup: vite", vite)],
  ["fixture", () => rm(fixture, { force: true })],
];
for (const [name, step] of cleanup) {
  console.log(`cleanup ${name}`);
  await step().catch((error) => { console.error(String(error)); process.exitCode = 1; });
}
process.exit(); // every cleanup above has finished or hit its deadline, and leftover handles must not keep the step alive
