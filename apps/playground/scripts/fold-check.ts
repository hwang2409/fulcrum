// Approval folds at scale: 100k rows, 4x CPU, the last message streaming, the reader parked below 30 pending
// approvals that fold into their tool rows one every 400 ms. A fold must be a small in-place edit: no long task
// (>= 50 ms) and no movement of the row the reader is looking at. Serves the built page at FOLD_ROOT (default: here).
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const root = process.env.FOLD_ROOT ?? new URL("..", import.meta.url).pathname;
const port = Number(process.env.FOLD_PORT ?? 4175);
const rows = Number(process.env.FOLD_ROWS ?? 100_000);
const folds = 30;
const preview = spawn("bun", ["x", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, stdio: "ignore" });
const stop = () => preview.kill("SIGTERM");
process.on("exit", stop);

type Fold = { fold(index: number): void; stream(): void; seedMs: number; approvalId(index: number): string };
const browser = await chromium.launch();
try {
  for (let i = 0; ; i++) {
    if (await fetch(`http://127.0.0.1:${port}/fold.html`).then((response) => response.ok, () => false)) break;
    if (i === 100) throw new Error("vite preview did not start");
    await Bun.sleep(100);
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/fold.html?rows=${rows}&folds=${folds}`);
  await page.waitForFunction(() => document.querySelector("[data-virtual-id]"), null, { timeout: 120_000 });
  const seedMs = await page.evaluate(() => (window as unknown as { __fold: Fold }).__fold.seedMs);
  // Park the reader below every approval (a wheel up first: only user intent releases follow), then let it settle.
  await page.mouse.move(640, 450);
  await page.mouse.wheel(0, -2_000);
  await Bun.sleep(300);
  await page.evaluate(() => { const scroll = document.querySelector<HTMLElement>("[data-testid=scroll]")!; scroll.scrollTop = scroll.scrollHeight * 0.6; });
  await Bun.sleep(1_500);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await Bun.sleep(1_000);
  const result = await page.evaluate(async (count) => {
    const api = (window as unknown as { __fold: Fold }).__fold;
    const scroll = document.querySelector<HTMLElement>("[data-testid=scroll]")!;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const top = scroll.getBoundingClientRect().top;
    const reference = [...scroll.querySelectorAll<HTMLElement>("[data-virtual-id]")].find((row) => row.getBoundingClientRect().top >= top)!;
    const id = reference.dataset.virtualId!;
    const offset = () => scroll.querySelector<HTMLElement>(`[data-virtual-id="${CSS.escape(id)}"]`)!.getBoundingClientRect().top - top;
    const start = offset();
    const tasks: { start: number; duration: number }[] = [];
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) tasks.push({ start: entry.startTime, duration: entry.duration }); }).observe({ type: "longtask" });
    const streaming = setInterval(api.stream, 50);
    const foldTimes: number[] = [];
    let drift = 0;
    for (let index = 0; index < count; index++) {
      foldTimes.push(performance.now());
      api.fold(index);
      await frame();
      drift = Math.max(drift, Math.abs(offset() - start));
      await sleep(400);
    }
    clearInterval(streaming);
    await sleep(200);
    const fromFolds = tasks.filter((task) => foldTimes.some((time) => task.start >= time && task.start < time + 300));
    const folded = foldTimes.every((_, index) => !document.querySelector(`[data-virtual-id="${CSS.escape(api.approvalId(index))}"]`));
    return { reference: id, folds: count, longTasks: tasks.length, foldLongTasks: fromFolds.length, worstFoldTaskMs: Math.max(0, ...fromFolds.map((task) => Math.round(task.duration))), driftPx: Math.round(drift * 10) / 10, folded };
  }, folds);
  if (!result.reference.startsWith("message:m")) throw new Error(`the reader is not parked mid-session: ${result.reference}`);
  const pass = result.foldLongTasks === 0 && result.driftPx < 1 && result.folded;
  console.log(JSON.stringify({ rows, cpuThrottle: 4, seedMs: Math.round(seedMs), ...result, pass }, null, 2));
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close();
  stop();
}
