import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm, writeFile } from "node:fs/promises";

const app = new URL("../", import.meta.url);
const fixture = new URL(".highlight-recipes-test.html", app);
const viteConfig = new URL(".highlight-recipes-vite.config.ts", app);
const port = 4183;
const workerUrl = `/@fs/${new URL("../../../packages/highlight/dist/worker.js", import.meta.url).pathname}`;
const baseline = process.env.BASELINE === "1";
await writeFile(viteConfig, "export default {};\n");
await writeFile(fixture, `<!doctype html><script type="module">
const workerUrl = ${JSON.stringify(workerUrl)};
const julia = "function greet(name)\\n  println(\\"hello $name\\")\\nend\\n";
const before = ${JSON.stringify(["tsx", "typescript", "javascript", "jsx", "python", "shell", "json", "diff", "rust", "go", "sql", "yaml", "css", "html", "markdown", "toml", "dockerfile", "c", "cpp", "java", "kotlin", "swift", "ruby", "php", "lua", "makefile", "ini", "xml", "graphql"])};
const typed = (tokens) => tokens.some((token) => token.type);
async function cold(preload) {
  const worker = new Worker(workerUrl, { type: "module" });
  const started = performance.now();
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.terminate(); reject(new Error("cold julia exceeded 30s")); }, 30000);
    worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
    worker.onmessage = ({ data }) => {
      if (data.error) { clearTimeout(timer); worker.terminate(); reject(new Error(data.error)); }
      if ((data.requestId === 30 || data.update?.id === "julia") && data.tokens && typed(data.tokens) && data.completion?.status !== "pending") {
        clearTimeout(timer); const elapsed = performance.now() - started; worker.terminate(); resolve(elapsed);
      }
    };
    if (preload) before.forEach((language, index) => worker.postMessage({ type: "highlight", requestId: index + 1, code: "x = f(\\"s\\", 1); // c\\n", context: { id: "before-" + index, version: 1, state: "done" }, grammar: { language, generation: 1 } }));
    worker.postMessage({ type: "highlight", requestId: 30, code: julia, context: { id: "julia", version: 1, state: "done" }, grammar: { language: "julia", generation: 1 } });
  });
}
async function loadTypescript() {
  const worker = new Worker(workerUrl, { type: "module" });
  await new Promise((resolve, reject) => {
    worker.onerror = (event) => reject(new Error(event.message));
    worker.onmessage = ({ data }) => {
      if (data.error) reject(new Error(data.error));
      if ((data.requestId === 1 || data.update?.id === "typescript") && data.tokens && typed(data.tokens) && data.completion?.status !== "pending") { worker.terminate(); resolve(); }
    };
    worker.postMessage({ type: "highlight", requestId: 1, code: "const value: number = 1;\\n", context: { id: "typescript", version: 1, state: "done" }, grammar: { language: "typescript", generation: 1 } });
  });
}
await loadTypescript();
window.__typescriptReady = true;
while (!window.__continue) await new Promise((resolve) => setTimeout(resolve, 10));
const direct = [], queued = [];
for (let i = 0; i < 5; i++) direct.push(await cold(false));
for (let i = 0; i < 5; i++) queued.push(await cold(true));
const summary = (values) => ({ median: [...values].sort((a, b) => a - b)[2], max: Math.max(...values), values });
window.__result = { direct: summary(direct), queued: summary(queued) };
</script>`);

const server = spawn("bun", ["x", "vite", "--config", viteConfig.pathname, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: app.pathname, stdio: "ignore" });
try {
  let ready = false;
  for (let index = 0; index <= 100 && !ready; index++) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/`)).ok; } catch {}
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error("vite did not start");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    const requests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => requests.push(request.url()));
    await page.goto(`http://127.0.0.1:${port}/${fixture.pathname.split("/").at(-1)}`);
    await page.waitForFunction(() => (window as typeof window & { __typescriptReady?: boolean }).__typescriptReady, undefined, { timeout: 30_000 });
    if (!requests.some((url) => url.includes("/langs/typescript.js")) || (!baseline && !requests.some((url) => url.includes("/recipes/typescript.js"))))
      throw new Error("typescript did not fetch its separate grammar and recipe assets");
    if (requests.some((url) => url.includes("/langs/julia.js") || url.includes("/recipes/julia.js")))
      throw new Error("loading typescript fetched julia's grammar or recipe");
    await page.evaluate(() => { (window as typeof window & { __continue?: boolean }).__continue = true; });
    const result = await page.waitForFunction(() => (window as typeof window & { __result?: unknown }).__result, undefined, { timeout: 180_000 }).then((handle) => handle.jsonValue()) as { direct: { median: number; max: number; values: number[] }; queued: { median: number; max: number; values: number[] } };
    if (errors.length) throw new Error(errors.join("\n"));
    console.log(`chromium cold julia fresh-worker (5)\tmedian ${result.direct.median.toFixed(1)} ms\tmax ${result.direct.max.toFixed(1)} ms\t${result.direct.values.map((value) => value.toFixed(1)).join(", ")}`);
    console.log(`chromium 29-then-julia fresh-worker (5)\tmedian ${result.queued.median.toFixed(1)} ms\tmax ${result.queued.max.toFixed(1)} ms\t${result.queued.values.map((value) => value.toFixed(1)).join(", ")}`);
    if (!baseline && !process.env.CI && result.direct.median >= 1_000) throw new Error(`cold julia median ${result.direct.median.toFixed(1)} ms is not under 1000 ms`);
    const queuedLimit = process.env.CI ? 4_500 : 1_500;
    if (!baseline && result.queued.median >= queuedLimit) throw new Error(`29-then-julia median ${result.queued.median.toFixed(1)} ms is not under ${queuedLimit} ms`);
  } finally { await browser.close(); }
} finally {
  server.kill("SIGTERM");
  await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  await Promise.all([rm(fixture, { force: true }), rm(viteConfig, { force: true })]);
}
