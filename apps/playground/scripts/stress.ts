import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";

const runs = 3;
const preview = spawn("bun", ["x", "vite", "preview", "--host", "127.0.0.1", "--port", "4173"], { cwd: new URL("..", import.meta.url).pathname, stdio: ["ignore", "pipe", "pipe"] });
const stop = () => preview.kill("SIGTERM");
process.on("exit", stop);
process.on("SIGINT", () => { stop(); process.exit(130); });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch("http://127.0.0.1:4173")).ok) break; } catch {}
    if (preview.exitCode !== null) throw new Error("vite preview exited");
    if (i === 99) throw new Error("vite preview did not start");
    await Bun.sleep(100);
  }
  browser = await chromium.launch();
  const browserVersion = browser.version();
  const results = [];
  for (let run = 1; run <= runs; run++) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto("http://127.0.0.1:4173");
    await page.evaluate(() => performance.mark("stress-start"));
    await page.selectOption("#mode", "stress");
    const result = await page.evaluate(async () => {
      const scroll = document.querySelector<HTMLElement>(".scroll")!;
      const started = performance.getEntriesByName("stress-start")[0]?.startTime ?? performance.now();
      await new Promise<void>((resolve) => {
        const check = () => document.querySelectorAll('[data-part="message"]').length >= 5000 ? resolve() : requestAnimationFrame(check);
        check();
      });
      const firstPaint = performance.now() - started;
      const frames: number[] = [];
      let last = performance.now();
      let raf = 0;
      const frame = () => { const now = performance.now(); frames.push(now - last); last = now; raf = requestAnimationFrame(frame); };
      const longTasks: number[] = [];
      const observer = new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => entry.duration)));
      observer.observe({ type: "longtask" });
      raf = requestAnimationFrame(frame);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      cancelAnimationFrame(raf); observer.disconnect();
      const valid = frames.filter((frame) => frame < 1000);
      const sorted = [...valid].sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
      const fps = valid.length / 10;

      scroll.scrollTop = scroll.scrollHeight / 2;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const items = [...document.querySelectorAll<HTMLElement>('[data-part="message"]')];
      const anchor = items.find((item) => { const rect = item.getBoundingClientRect(); return rect.top >= scroll.getBoundingClientRect().top && rect.bottom <= scroll.getBoundingClientRect().bottom; });
      let totalShift = 0, worstShift = 0;
      if (anchor) {
        for (let i = 0; i < 5; i++) {
          const before = anchor.getBoundingClientRect().top;
          const beforeScroll = scroll.scrollTop;
          scroll.scrollBy(0, -300);
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const expected = scroll.scrollTop - beforeScroll;
          const actual = anchor.getBoundingClientRect().top - before;
          const shift = Math.abs(actual + expected);
          totalShift += shift; worstShift = Math.max(worstShift, shift);
        }
      }
      scroll.scrollTop = scroll.scrollHeight;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const bottomBefore = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const bottomAfter = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
      scroll.scrollTop = Math.max(0, scroll.scrollTop - 500);
      const held = scroll.querySelector<HTMLElement>('[data-part="message"]:not(:first-child)');
      const heldBefore = held?.getBoundingClientRect().top ?? 0;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const heldAfter = held?.getBoundingClientRect().top ?? 0;
      return { firstPaint, fps, p95, longTasks: longTasks.filter((duration) => duration > 50).length, totalShift, worstShift, anchoring: getComputedStyle(scroll).overflowAnchor !== "none", bottomAfter: Math.abs(bottomAfter), bottomBefore: Math.abs(bottomBefore), heldShift: Math.abs(heldAfter - heldBefore) };
    });
    results.push({ run, ...result });
    await page.close();
  }
  console.log(`commit: ${Bun.env.GITHUB_SHA ?? (await Bun.$`git rev-parse HEAD`.text()).trim()}`);
  console.log(`browser: Chromium ${browserVersion}`);
  console.log("build: production (vite preview)");
  const numeric = ["firstPaint", "fps", "p95", "longTasks", "totalShift", "worstShift", "bottomAfter", "heldShift"] as const;
  const median = Object.fromEntries(numeric.map((key) => [key, [...results].map((result) => result[key]).sort((a, b) => a - b)[1]]));
  console.table([...results, { run: "median", ...median, anchoring: results.every((result) => result.anchoring) }]);
} finally {
  await browser?.close();
  stop();
  await once(preview, "exit").catch(() => {});
}
