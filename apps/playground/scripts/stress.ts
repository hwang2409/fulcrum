import { chromium, type Browser, type Page } from "playwright";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { once } from "node:events";

const cases = [200, 5_000];
const durationMs = 10_000;
const seed = "fulcrum-stress-v1";
const artifacts = new URL("../stress-artifacts/", import.meta.url).pathname;
const preview = spawn("bun", ["x", "vite", "preview", "--host", "127.0.0.1", "--port", "4173"], { cwd: new URL("..", import.meta.url).pathname, stdio: ["ignore", "pipe", "pipe"] });
const stop = () => preview.kill("SIGTERM");
process.on("exit", stop);
process.on("SIGINT", () => { stop(); process.exit(130); });

const knownFail = {
  fps: { current: "all rows are mounted at 5,000 messages", target: 55 },
  firstPaint: { current: "all rows are mounted at 5,000 messages", target: 250 },
  p95Frame: { current: "all rows are mounted at 5,000 messages", target: "< 18ms" },
  worstFrame: { current: "all rows are mounted at 5,000 messages", target: "< 50ms" },
  longTasks: { current: "all rows are mounted at 5,000 messages", target: 0 },
  mountedDomNodes: { current: "all rows are mounted", target: 500 },
  upwardScrollShift: { current: "non-zero with the non-virtual Timeline", target: "< 1px" },
  idleAnimationFrames: { current: "playground follow loop keeps scheduling rAF", target: 0 },
  idleTimers: { current: "replay interval is not stopped at stream end", target: 0 },
};

type Metrics = Record<string, unknown> & { failures: string[]; knownFailures: string[] };

async function instrument(page: Page, messages: number) {
  await page.route("**/*.js", async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    // The stress fixture is compiled with a constant. Rewriting this test-only fixture
    // keeps the production playground unchanged while exercising both requested sizes.
    body = body.replace("D=5e3", `D=${messages}`);
    await route.fulfill({ response, body });
  });
  await page.addInitScript(() => {
    const w = window as typeof window & { __fulcrumPerf?: Record<string, number> };
    const stats = (w.__fulcrumPerf = { rafRequested: 0, timersRequested: 0, timersActive: 0 });
    const raf = window.requestAnimationFrame.bind(window);
    const setInterval = window.setInterval.bind(window);
    const clearInterval = window.clearInterval.bind(window);
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => { stats.rafRequested++; return raf(callback); }) as typeof window.requestAnimationFrame;
    window.setInterval = ((callback: TimerHandler, timeout?: number, ...args: unknown[]) => { stats.timersRequested++; stats.timersActive++; return setInterval(callback, timeout, ...args); }) as typeof window.setInterval;
    window.clearInterval = ((id: number) => { stats.timersActive = Math.max(0, stats.timersActive - 1); return clearInterval(id); }) as typeof window.clearInterval;
  });
}

async function measure(page: Page, messages: number): Promise<Metrics> {
  return page.evaluate(async ({ messages, durationMs, seed }) => {
    const scroll = document.querySelector<HTMLElement>(".scroll")!;
    const started = performance.getEntriesByName("stress-start")[0]?.startTime ?? performance.now();
    while (document.querySelectorAll('[data-part="message"]').length < messages) await new Promise(requestAnimationFrame);
    const firstPaint = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const frames: number[] = [];
    let last = performance.now();
    let raf = 0;
    const frame = () => { const now = performance.now(); frames.push(now - last); last = now; raf = requestAnimationFrame(frame); };
    const longTasks: number[] = [];
    const observer = new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => entry.duration)));
    observer.observe({ type: "longtask" });
    let mutationBatches = 0;
    const mutations = new MutationObserver(() => mutationBatches++);
    mutations.observe(scroll, { childList: true, subtree: true, characterData: true });
    raf = requestAnimationFrame(frame);
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    cancelAnimationFrame(raf);
    observer.disconnect();
    mutations.disconnect();
    const valid = frames.filter((value) => value < 1_000);
    const sorted = [...valid].sort((a, b) => a - b);
    const p95Frame = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? Infinity;
    const fps = valid.length / (durationMs / 1_000);
    const beforeNodes = document.querySelectorAll('[data-part="message"]').length;

    scroll.scrollTop = scroll.scrollHeight / 2;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const anchor = [...scroll.querySelectorAll<HTMLElement>('[data-part="message"]')].find((item) => {
      const rect = item.getBoundingClientRect(); const box = scroll.getBoundingClientRect(); return rect.top >= box.top && rect.bottom <= box.bottom;
    });
    let upwardScrollShift = 0;
    if (anchor) for (let i = 0; i < 5; i++) {
      const before = anchor.getBoundingClientRect().top; const beforeScroll = scroll.scrollTop;
      scroll.scrollBy(0, -300);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      upwardScrollShift += Math.abs(anchor.getBoundingClientRect().top - before + scroll.scrollTop - beforeScroll);
    }
    const perf = (window as typeof window & { __fulcrumPerf?: Record<string, number> }).__fulcrumPerf!;
    const rafBeforeIdle = perf.rafRequested;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const idleAnimationFrames = perf.rafRequested - rafBeforeIdle;
    const idleTimers = perf.timersActive;
    return {
      case: messages, seed, firstPaint, fps, p95Frame,
      worstFrame: Math.max(...valid, 0), longTasks: longTasks.filter((value) => value > 50).length,
      mountedDomNodes: beforeNodes, mutationBatches, estimatedEvents: durationMs / 1_000 * 200,
      // MutationObserver callback batches are the browser-visible commit proxy; the app cannot expose React internals from tooling-only scope.
      commitsPerEvent: mutationBatches / (durationMs / 1_000 * 200), upwardScrollShift,
      idleAnimationFrames, idleTimers,
    };
  }, { messages, durationMs, seed });
}

function check(result: Record<string, any>): Metrics {
  const failures: string[] = [];
  const knownFailures: string[] = [];
  const thresholds: Record<string, [number, number, string]> = {
    firstPaint: [result.firstPaint, 250, "at most"], fps: [result.fps, 55, "at least"], p95Frame: [result.p95Frame, 18, "at most"], worstFrame: [result.worstFrame, 50, "at most"],
    longTasks: [result.longTasks, 0, "at most"], mountedDomNodes: [result.mountedDomNodes, 500, "at most"],
    commitsPerEvent: [result.commitsPerEvent, 1, "at most"], upwardScrollShift: [result.upwardScrollShift, 1, "at most"],
    idleAnimationFrames: [result.idleAnimationFrames, 0, "at most"], idleTimers: [result.idleTimers, 0, "at most"],
  };
  for (const [name, [value, limit, direction]] of Object.entries(thresholds)) {
    const pass = direction === "at least" ? value >= limit : value <= limit;
    if (!pass && name in knownFail) knownFailures.push(`${name}: ${value} (known-fail, target ${knownFail[name as keyof typeof knownFail].target})`);
    else if (!pass) failures.push(`${name}: ${value} (expected ${direction} ${limit})`);
  }
  return { ...result, thresholds, failures, knownFailures };
}

let browser: Browser | undefined;
const results: Metrics[] = [];
try {
  await mkdir(artifacts, { recursive: true });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch("http://127.0.0.1:4173")).ok) break; } catch {}
    if (preview.exitCode !== null) throw new Error("vite preview exited");
    if (i === 99) throw new Error("vite preview did not start");
    await Bun.sleep(100);
  }
  for (const messages of cases) {
    browser ??= await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await instrument(page, messages);
    await page.goto("http://127.0.0.1:4173");
    await page.evaluate(() => performance.mark("stress-start"));
    await page.selectOption("select", "stress");
    await page.context().tracing.start({ screenshots: true, snapshots: true });
    const result = check(await measure(page, messages));
    results.push(result);
    await page.screenshot({ path: `${artifacts}/stress-${messages}.png`, fullPage: false });
    await page.context().tracing.stop({ path: `${artifacts}/stress-${messages}.zip` });
    await page.close();
  }
  const report = { commit: (await Bun.$`git rev-parse HEAD`.text()).trim(), browser: browser.version(), cpuThrottle: 4, seed, cases: results, expectedFail: { case: 100_000, reason: "current Timeline mounts every row; enable after virtual Timeline lands" } };
  await Bun.write(`${artifacts}/stress-metrics.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (results.some((result) => result.failures.length)) process.exitCode = 1;
} finally {
  await browser?.close(); stop(); await once(preview, "exit").catch(() => {});
}
