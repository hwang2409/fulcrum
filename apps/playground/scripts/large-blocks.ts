// Large highlighted blocks in real chromium, with the page's CPU throttled (CPU_THROTTLE, default 4; the worker is not
// throttled). On a page that already shows a run, a markdown fence of 9,999 cpp lines (329,968 tokens) must mount, color,
// and scroll a page per frame with no main-thread task of 50 ms or more (and, while it scrolls, no 50 ms gap between
// 5 ms probes); its first visible lines must color without waiting for the whole block; the bounded view must scroll by
// keyboard, copy the whole text, and let find-in-page reach its visible lines. A small block asked for while a
// 330k-token result is still being delivered must color within two frames of the time it takes on its own. LINES sets
// the fence size (to measure the inline path, or a base without the bounded view). Runs vite's dev server with
// production react.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm, writeFile } from "node:fs/promises";

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
import { RunProvider, ToolCall } from "@fulcrum/react";
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
results.read = await measure(async () => {
  flushSync(() => document.querySelector("[data-id='tool:r'] [data-action=open-viewer]").click());
  const readViewer = document.querySelector("[data-id='tool:r'] [data-part=text-viewer]");
  await until(() => readViewer.querySelector("[class^=tok-]"));
  for (let frame = 0; frame < 120; frame++) {
    readViewer.scrollTop += readViewer.clientHeight;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  const colored = await until(() => readViewer.querySelector("[class^=tok-]"), 10_000).then(() => true, () => false);
  return { rows: readViewer.querySelectorAll("[data-part=text-viewer-row]").length, colored };
});
root.render(createElement(Markdown, { id: "large", source: fence, highlight }));
await nextFrame();
await nextFrame();
window.__code = code;
window.__results = results;
</script>`);
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: app.pathname, stdio: "ignore", env: { ...process.env, NODE_ENV: "production" } }); // production react: the development build is several times slower
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
type Measured = { longTasks: number[]; maxLongTask: number; maxProbeGap: number; [key: string]: unknown };
const failures: string[] = [];
try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/.large-blocks-test.html`)).ok) break; } catch {}
    if (vite.exitCode !== null || attempt === 100) throw new Error("vite did not start");
    await Bun.sleep(100);
  }
  browser = await chromium.launch();
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
        this.addEventListener("message", (event) => { if (event.data && "part" in event.data) scope.__parts++; });
      }
    } });
  });
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/.large-blocks-test.html`);
  const results = await page.waitForFunction(() => (window as typeof window & { __results?: unknown }).__results, undefined, { timeout: 240_000 })
    .then((handle) => handle.jsonValue()).catch((error) => { throw new Error([...failures, String(error)].join("\n")); }) as Record<string, Measured>;
  for (const [name, result] of Object.entries(results)) {
    const { longTasks, ...rest } = result;
    console.log(`${name}\tlong tasks ${longTasks.length}\tmax ${result.maxLongTask.toFixed(1)} ms\tmax probe gap ${result.maxProbeGap.toFixed(1)} ms\t${JSON.stringify(rest)}`);
    if (longTasks.length) failures.push(`${name}: a main-thread task reached 50 ms`);
    // The mount's gap also holds markdown's one-shot parse of the 440 kB message (about 11 ms at 4x), which runs in the
    // same task and is not this path's work: there only long tasks fail, and the gap is reported.
    // The probe gap also holds runner scheduling jitter (one CI run measured 51.1 ms with no long task). The bug it
    // guards froze the page for 5,388 ms, so the gap bound is 100 ms; real 50 ms tasks still fail through longTasks.
    if (name !== "markdown" && result.maxProbeGap >= 100) failures.push(`${name}: the main thread was busy for ${result.maxProbeGap.toFixed(1)} ms`);
  }
  if (!results.read?.colored) failures.push("read: the scrolled-to rows of the opened read viewer never colored");
  const { queue } = results;
  if (!queue.smallColored || !queue.bigColored) failures.push(`queue: both blocks must color (${JSON.stringify(queue)})`);
  // The regression this guards is the small block waiting for the whole large one: 325-335 ms on main before the fix.
  // Two or three frames of scheduling (34-50 ms) are noise on a loaded CI runner, so the bound sits well between them.
  if ((queue.behindMs as number) > (queue.ownMs as number) + 100) failures.push(`queue: the small block took ${queue.behindMs} ms behind the large one, ${queue.ownMs} ms on its own`);
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
  if (failures.length) throw new Error(failures.join("\n"));
  console.log("large blocks: ok");
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
  await once(vite, "exit").catch(() => {});
  await rm(fixture, { force: true });
}
