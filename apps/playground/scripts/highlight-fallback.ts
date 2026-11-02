import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm, writeFile } from "node:fs/promises";

const app = new URL("../", import.meta.url);
const fixture = new URL(".highlight-fallback-test.html", app);
const port = 4175;
await writeFile(fixture, `<!doctype html><pre id="plain"></pre><script type="module">
import { createHighlighter } from "@fulcrum/highlight";
const line = "export const value: number = items.map((item) => item.id).length;\\n";
const results = [];
const highlight = createHighlighter();
for (const count of [50, 500]) {
  const code = line.repeat(count);
  document.querySelector("#plain").textContent = code;
  await new Promise(requestAnimationFrame);
  const tasks = [];
  const observer = new PerformanceObserver((list) => tasks.push(...list.getEntries().map((entry) => entry.duration)));
  observer.observe({ type: "longtask", buffered: false });
  const started = performance.now();
  const tokens = await highlight(code, "typescript", { id: "fallback-" + count, version: 1, state: "done" });
  await new Promise(requestAnimationFrame);
  observer.disconnect();
  results.push({ lines: count, elapsed: performance.now() - started, longTasks: tasks, exact: tokens.map((token) => token.text).join("") === code, plainVisibleFirst: document.querySelector("#plain").textContent === code });
}
highlight.dispose();
window.__highlightResults = results;
</script>`);
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: app.pathname, stdio: "ignore" });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/.highlight-fallback-test.html`)).ok) break; } catch {}
    if (vite.exitCode !== null || attempt === 100) throw new Error("vite did not start");
    await Bun.sleep(100);
  }
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addInitScript(() => { Object.defineProperty(window, "Worker", { value: class { constructor() { throw new Error("worker blocked"); } } }); });
  await page.goto(`http://127.0.0.1:${port}/.highlight-fallback-test.html`);
  const results = await page.waitForFunction(() => (window as typeof window & { __highlightResults?: unknown }).__highlightResults, undefined, { timeout: 120_000 }).then((handle) => handle.jsonValue()) as Array<{ lines: number; elapsed: number; longTasks: number[]; exact: boolean; plainVisibleFirst: boolean }>;
  for (const result of results) {
    console.log(`${result.lines} lines\t${result.elapsed.toFixed(1)} ms\tlong tasks ${result.longTasks.length}\tmax ${Math.max(0, ...result.longTasks).toFixed(1)} ms`);
    if (!result.exact || !result.plainVisibleFirst || result.longTasks.some((duration) => duration > 50)) throw new Error(`${result.lines}-line fallback failed: ${JSON.stringify(result)}`);
  }
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
  await once(vite, "exit").catch(() => {});
  await rm(fixture, { force: true });
}
