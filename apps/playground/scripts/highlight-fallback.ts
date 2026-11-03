// The page's thread never tokenizes. In real chromium: with the worker blocked (tried 4 times, then plain text), with the
// worker killed (restarted, colors still arrive; killed 3 more times in 60 s, plain text), and with long valid work (the
// 440 kb, 9,999-line cpp block from review 4, twice: both colored, no restart), no main-thread task may reach 50 ms.
// CPU_THROTTLE=4 slows the page's thread through CDP (chromium does not throttle the worker with it).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm, writeFile } from "node:fs/promises";

const app = new URL("../", import.meta.url);
const fixture = new URL(".highlight-fallback-test.html", app);
const port = 4175;
const languages = ["typescript", "tsx", "javascript", "jsx", "python", "shell", "json", "diff", "rust", "go", "sql", "yaml", "css", "html", "markdown", "toml", "dockerfile", "c", "cpp", "java", "kotlin", "swift", "ruby", "php", "lua", "makefile", "ini", "xml", "graphql", "protobuf"];
await writeFile(fixture, `<!doctype html><script type="module">
import { createHighlighter } from "@fulcrum/highlight";
const languages = ${JSON.stringify(languages)};
const line = "export const value = items.map((item) => item.id).length; // x\\n";
const code = (language) => line.repeat(language === "cpp" || language === "ruby" ? 500 : 50);
const text = (tokens) => tokens.map((token) => token.text).join("");
const typed = (tokens) => tokens.some((token) => token.type);
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
const untilWorkers = async (count) => { while (window.__workers.length < count) await new Promise((resolve) => setTimeout(resolve, 10)); };
// Long tasks, and the longest gap between 5 ms probes, while run() is busy.
async function measure(run) {
  const tasks = [];
  const observer = new PerformanceObserver((list) => tasks.push(...list.getEntries().map((entry) => entry.duration)));
  observer.observe({ type: "longtask", buffered: false });
  let last = performance.now(), gap = 0;
  const probe = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; }, 5);
  let result;
  try { result = await run(); }
  finally { await nextFrame(); clearInterval(probe); observer.disconnect(); } // entries and gaps land after run() too
  return { ...result, longTasks: tasks, maxLongTask: Math.max(0, ...tasks), maxProbeGap: gap };
}
const all = (highlight, tag) => Promise.all(languages.map(async (language) => {
  const source = code(language);
  const tokens = await highlight(source, language, { id: tag + ":" + language, version: 1, state: "done" });
  return { language, exact: text(tokens) === source, typed: typed(tokens) };
}));
const results = {};
if (window.__mode === "blocked") {
  let told = 0;
  const highlight = createHighlighter({ onHighlightUnavailable: () => told++ });
  results.blocked = await measure(async () => {
    const blocks = await all(highlight, "blocked");
    await nextFrame();
    return { built: window.__built, told, exact: blocks.every((block) => block.exact), plain: blocks.every((block) => !block.typed) };
  });
  highlight.dispose();
} else if (window.__mode === "long") {
  let told = 0;
  const highlight = createHighlighter({ onHighlightUnavailable: () => told++ });
  const warm = { id: "long:warm", version: 1, state: "done" };
  const warmed = new Promise((resolve) => { const stop = highlight.subscribe(warm.id, () => { stop(); resolve(); }); });
  await highlight("int main() { return 0; }\\n", "cpp", warm);
  await warmed;
  const source = "A<B<C,D>,E<F>>::g(h++,--i,j+=k,l?m:n); // x\\n".repeat(9_999);
  for (const id of ["long:1", "long:2"]) {
    results[id] = await measure(async () => {
      const gaps = window.__messageGaps = [];
      const started = performance.now();
      const tokens = await highlight(source, "cpp", { id, version: 1, state: "done" });
      return { bytes: source.length, tokens: tokens.length, ms: Math.round(performance.now() - started), workers: window.__workers.length, told, maxWorkerSilence: Math.round(Math.max(0, ...gaps)), result: tokens };
    });
    // Checked outside the measured window: this page's own join of every token is not the library's work.
    const { result } = results[id];
    delete results[id].result;
    results[id].colored = text(result) === source && typed(result);
  }
  highlight.dispose();
} else {
  let told = 0;
  const highlight = createHighlighter({ onHighlightUnavailable: () => told++ });
  const kill = () => { const worker = window.__workers.at(-1); worker.terminate(); worker.onerror?.(new ErrorEvent("error")); };
  // First kill: the worker dies with every grammar's request pending; the replacement answers them, and colors arrive.
  results.restart = await measure(async () => {
    const id = "restart:cpp";
    const updated = new Promise((resolve) => { const stop = highlight.subscribe(id, () => { stop(); resolve(); }); });
    const pending = all(highlight, "restart");
    kill();
    const blocks = await pending;
    await updated;
    const cpp = highlight(code("cpp"), "cpp", { id, version: 1, state: "done" });
    return { workers: window.__workers.length, exact: blocks.every((block) => block.exact), cppColored: Array.isArray(cpp) && text(cpp) === code("cpp") && typed(cpp) };
  });
  // Three more kills inside 60 s: the 2nd and 3rd restart (after 1 s, then 4 s); the 4th crash in the window leaves
  // every block exact plain text, and the app is told once.
  results.dead = await measure(async () => {
    const pending = all(highlight, "dead");
    kill();
    await untilWorkers(3);
    kill();
    await untilWorkers(4);
    kill();
    const blocks = await pending;
    await nextFrame();
    return { workers: window.__workers.length, told, exact: blocks.every((block) => block.exact), plain: blocks.every((block) => !block.typed) };
  });
  highlight.dispose();
}
window.__results = results;
</script>`);
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: app.pathname, stdio: "ignore" });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
type Measured = { longTasks: number[]; maxLongTask: number; maxProbeGap: number; [key: string]: unknown };
try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/.highlight-fallback-test.html`)).ok) break; } catch {}
    if (vite.exitCode !== null || attempt === 100) throw new Error("vite did not start");
    await Bun.sleep(100);
  }
  browser = await chromium.launch();
  const failures: string[] = [];
  const throttle = Number(process.env.CPU_THROTTLE ?? 1);
  for (const mode of ["blocked", "killed", "long"] as const) {
    const page = await browser.newPage();
    if (throttle > 1) await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: throttle });
    await page.addInitScript((mode) => {
      const scope = window as typeof window & { __mode: string; __workers: Worker[]; __built: number; __messageGaps?: number[] };
      scope.__mode = mode;
      scope.__workers = [];
      scope.__built = 0;
      const Native = window.Worker;
      Object.defineProperty(window, "Worker", { value: mode === "blocked"
        ? class { constructor() { scope.__built++; throw new Error("worker blocked"); } }
        : class extends Native {
          constructor(...args: ConstructorParameters<typeof Worker>) {
            super(...args);
            scope.__workers.push(this);
            let last = performance.now(); // the longest silence between this worker's messages, while a test records it
            this.addEventListener("message", () => { const now = performance.now(); scope.__messageGaps?.push(now - last); last = now; });
          }
        } });
    }, mode);
    page.on("pageerror", (error) => failures.push(`${mode}: ${error.message}`));
    await page.goto(`http://127.0.0.1:${port}/.highlight-fallback-test.html`);
    const results = await page.waitForFunction(() => (window as typeof window & { __results?: unknown }).__results, undefined, { timeout: 120_000 }).then((handle) => handle.jsonValue()).catch((error) => { throw new Error([...failures, String(error)].join("\n")); }) as Record<string, Measured>;
    for (const [name, result] of Object.entries(results)) {
      const { longTasks, ...rest } = result;
      console.log(`${name}\tlong tasks ${longTasks.length}\tmax ${result.maxLongTask.toFixed(1)} ms\tmax probe gap ${result.maxProbeGap.toFixed(1)} ms\t${JSON.stringify(rest)}`);
      if (longTasks.length) failures.push(`${name}: a main-thread task reached 50 ms`);
    }
    const expected = mode === "blocked"
      ? { blocked: { built: 4, told: 1, exact: true, plain: true } }
      : mode === "killed"
        ? { restart: { workers: 2, exact: true, cppColored: true }, dead: { workers: 4, told: 1, exact: true, plain: true } }
        : { "long:1": { workers: 1, told: 0, colored: true }, "long:2": { workers: 1, told: 0, colored: true } };
    for (const [name, fields] of Object.entries(expected))
      for (const [field, value] of Object.entries(fields))
        if (results[name]?.[field] !== value) failures.push(`${name}.${field}: expected ${value}, got ${results[name]?.[field]}`);
    await page.close();
  }
  if (failures.length) throw new Error(failures.join("\n"));
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
  await once(vite, "exit").catch(() => {});
  await rm(fixture, { force: true });
}
