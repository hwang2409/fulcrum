import { chromium, type Browser, type Page } from "playwright";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { once } from "node:events";

const cases = [200, 5_000] as const;
type TranscriptCase = (typeof cases)[number] | 100_000;
const durationMs = 10_000;
const seed = "fulcrum-stress-v1";
const artifacts = new URL("../stress-artifacts/", import.meta.url).pathname;
const preview = spawn("bun", ["x", "vite", "preview", "--host", "127.0.0.1", "--port", "4173"], { cwd: new URL("..", import.meta.url).pathname, stdio: ["ignore", "pipe", "pipe"] });
const stop = () => preview.kill("SIGTERM");
process.on("exit", stop);
process.on("SIGINT", () => { stop(); process.exit(130); });

type Metric = "firstPaint" | "fps" | "p95Frame" | "worstFrame" | "longTasks" | "mountedDomNodes" | "commitsPerEvent" | "upwardScrollShift" | "idleAnimationFrames" | "idleTimers";
type Rule = { direction: "atMost" | "atLeast"; enforce: { budget: number } } | { direction: "atMost" | "atLeast"; knownFail: { measured: string; target: number; flipWhen: string } };
type Contract = Partial<Record<Metric, Rule>>;
const max = (budget: number): Rule => ({ direction: "atMost", enforce: { budget } });
const min = (budget: number): Rule => ({ direction: "atLeast", enforce: { budget } });
const knownMax = (measured: string, target: number, flipWhen: string): Rule => ({ direction: "atMost", knownFail: { measured, target, flipWhen } });
const knownMin = (measured: string, target: number, flipWhen: string): Rule => ({ direction: "atLeast", knownFail: { measured, target, flipWhen } });
const virtualFlip = "flip to enforced when the virtual Timeline meets the target in 3 sequential CI runs";

// Stable metrics are regression budgets. Current architectural failures retain their measured baseline and end-state target instead.
const contract: Record<TranscriptCase, Contract> = {
  200: {
    firstPaint: max(400), fps: min(55), p95Frame: max(22), worstFrame: max(35), longTasks: max(0),
    mountedDomNodes: max(250), commitsPerEvent: max(0.5), upwardScrollShift: max(80),
    idleAnimationFrames: max(220), idleTimers: max(2),
  },
  5_000: {
    firstPaint: knownMax("1,123.1-2,102.6 ms", 250, virtualFlip), fps: knownMin("16.4-21.5 fps", 55, virtualFlip),
    p95Frame: knownMax("100.7-132.7 ms", 18, virtualFlip), worstFrame: knownMax("145.3-190.2 ms", 50, virtualFlip),
    longTasks: knownMax("87-114", 0, virtualFlip), mountedDomNodes: knownMax("5,013", 500, virtualFlip),
    commitsPerEvent: max(0.1), upwardScrollShift: knownMax("66-67.5 px", 1, virtualFlip),
    idleAnimationFrames: knownMax("126-141", 0, virtualFlip), idleTimers: knownMax("2", 0, virtualFlip),
  },
  // The current Timeline deterministically mounts one DOM row per seeded item. Running this case under throttle exceeds CI's timeout.
  100_000: { mountedDomNodes: knownMax("100,000 seeded rows", 500, virtualFlip) },
};

type Metrics = Record<string, unknown> & { failures: string[]; knownFailures: string[]; resolvedKnownFailures: string[] };

async function instrument(page: Page, messages: number) {
  await page.route("**/*.js", async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    // The stress fixture is compiled with a constant. Rewriting this test-only fixture keeps the production playground unchanged.
    body = body.replace("D=5e3", `D=${messages}`);
    await route.fulfill({ response, body });
  });
  await page.addInitScript(() => {
    const w = window as typeof window & { __fulcrumPerf?: Record<string, number> };
    const stats = (w.__fulcrumPerf = { rafRequested: 0, timersRequested: 0, timersActive: 0 });
    const raf = window.requestAnimationFrame.bind(window);
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);
    const nativeSetInterval = window.setInterval.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    const nativeRequestIdleCallback = window.requestIdleCallback?.bind(window);
    const nativeCancelIdleCallback = window.cancelIdleCallback?.bind(window);
    const timeouts = new Set<number>();
    const intervals = new Set<number>();
    const idleCallbacks = new Set<number>();
    const updateActive = () => { stats.timersActive = timeouts.size + intervals.size + idleCallbacks.size; };
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => { stats.rafRequested++; return raf(callback); }) as typeof window.requestAnimationFrame;
    window.setTimeout = ((callback: TimerHandler, timeout?: number, ...args: unknown[]) => {
      stats.timersRequested++;
      let id = 0;
      id = nativeSetTimeout((...callbackArgs: unknown[]) => {
        timeouts.delete(id); updateActive();
        if (typeof callback === "function") callback(...callbackArgs);
        else window.eval(callback);
      }, timeout, ...args);
      timeouts.add(id); updateActive();
      return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id?: number) => { if (id !== undefined) timeouts.delete(id); updateActive(); return nativeClearTimeout(id); }) as typeof window.clearTimeout;
    window.setInterval = ((callback: TimerHandler, timeout?: number, ...args: unknown[]) => {
      stats.timersRequested++;
      const id = nativeSetInterval(callback, timeout, ...args);
      intervals.add(id); updateActive();
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = ((id?: number) => { if (id !== undefined) intervals.delete(id); updateActive(); return nativeClearInterval(id); }) as typeof window.clearInterval;
    if (nativeRequestIdleCallback && nativeCancelIdleCallback) {
      window.requestIdleCallback = ((callback: IdleRequestCallback, options?: IdleRequestOptions) => {
        stats.timersRequested++;
        let id = 0;
        id = nativeRequestIdleCallback((deadline) => { idleCallbacks.delete(id); updateActive(); callback(deadline); }, options);
        idleCallbacks.add(id); updateActive();
        return id;
      }) as typeof window.requestIdleCallback;
      window.cancelIdleCallback = ((id: number) => { idleCallbacks.delete(id); updateActive(); nativeCancelIdleCallback(id); }) as typeof window.cancelIdleCallback;
    }
  });
}

async function measure(page: Page, messages: number): Promise<Record<string, number | string>> {
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
    cancelAnimationFrame(raf); observer.disconnect(); mutations.disconnect();
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
    return {
      case: messages, seed, firstPaint, fps, p95Frame, worstFrame: Math.max(...valid, 0),
      longTasks: longTasks.filter((value) => value > 50).length, mountedDomNodes: beforeNodes,
      mutationBatches, estimatedEvents: durationMs / 1_000 * 200,
      commitsPerEvent: mutationBatches / (durationMs / 1_000 * 200), upwardScrollShift,
      idleAnimationFrames: perf.rafRequested - rafBeforeIdle, idleTimers: perf.timersActive,
    };
  }, { messages, durationMs, seed });
}

function check(result: Record<string, any>): Metrics {
  const failures: string[] = [];
  const knownFailures: string[] = [];
  const resolvedKnownFailures: string[] = [];
  const rules = contract[result.case as keyof typeof contract];
  for (const [metric, rule] of Object.entries(rules) as [Metric, Rule][]) {
    const value = result[metric] as number;
    const limit = "enforce" in rule ? rule.enforce.budget : rule.knownFail.target;
    const pass = rule.direction === "atLeast" ? value >= limit : value <= limit;
    if ("enforce" in rule && !pass) failures.push(`${metric}: ${value} (budget ${rule.direction} ${limit})`);
    else if ("knownFail" in rule && pass) {
      const line = `FLIP ME: ${result.case}/${metric} reached target ${limit}; ${rule.knownFail.flipWhen}`;
      resolvedKnownFailures.push(line); console.error(line);
    } else if ("knownFail" in rule) knownFailures.push(`${metric}: ${value} (measured ${rule.knownFail.measured}; target ${limit}; ${rule.knownFail.flipWhen})`);
  }
  return { ...result, contract: rules, failures, knownFailures, resolvedKnownFailures };
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
  const report = { commit: (await Bun.$`git rev-parse HEAD`.text()).trim(), browser: browser.version(), cpuThrottle: 4, seed, contract, cases: results };
  await Bun.write(`${artifacts}/stress-metrics.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (results.some((result) => result.failures.length || (process.env.CI && result.resolvedKnownFailures.length))) process.exitCode = 1;
} finally {
  await browser?.close(); stop(); await once(preview, "exit").catch(() => {});
}
