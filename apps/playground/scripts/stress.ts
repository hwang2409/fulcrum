import { chromium, type Browser, type Page } from "playwright";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { once } from "node:events";

const cases = [200, 5_000, 100_000] as const;
type TranscriptCase = (typeof cases)[number];
const durationMs = 10_000;
const repetitions = Number(process.env.STRESS_REPETITIONS ?? 3);
const samplesPerRound = repetitions;
const maxExtraRounds = 1;
const caseTimeoutMs = (durationMs + 20_000) * repetitions * (maxExtraRounds + 1);
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
    // Ten 4x-throttle runs mounted exactly 103 timeline nodes and committed
    // exactly 0.005 times per event. Counted work is stable enough for hard gates.
    mountedDomNodes: max(250), commitsPerEvent: max(0.5),
    upwardScrollShift: knownMax("66-67.5 px", 1, virtualFlip),
    idleAnimationFrames: max(0), idleTimers: max(0),
  },
  5_000: {
    // First paint misses its target (measured: 5k 308.5 ms median vs 250; 100k 399.4 vs 250);
    // tracked by the components lane first-paint follow-up. The 10-run 5k median/p90/max
    // was 308.5/330.6/412.8 ms. Frame p95 was 17.8/18.5/18.5 ms against 18 ms,
    // so it has no enforcement margin yet.
    firstPaint: knownMax("308.5/330.6/412.8 ms median/p90/max", 250, "first-paint profiling follow-up"), fps: min(55),
    p95Frame: knownMax("17.8/18.5/18.5 ms median/p90/max", 18, "first-paint profiling follow-up"), worstFrame: max(50),
    longTasks: max(0), mountedDomNodes: max(500),
    commitsPerEvent: max(0.1), upwardScrollShift: knownMax("66-67.5 px", 1, virtualFlip),
    idleAnimationFrames: max(0), idleTimers: max(0),
  },
  100_000: {
    // Report-only pending the same follow-up: 399.4/440.2/448.3 ms median/p90/max against 250 ms.
    firstPaint: knownMax("399.4/440.2/448.3 ms median/p90/max", 250, "first-paint profiling follow-up"),
    mountedDomNodes: max(500),
  },
};

type Metrics = Record<string, unknown> & { failures: string[]; knownFailures: string[]; resolvedKnownFailures: string[] };

async function instrument(page: Page) {
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
    const scroll = document.querySelector<HTMLElement>('[data-part="timeline-scroll"]')!;
    const started = performance.getEntriesByName("stress-start")[0]?.startTime ?? performance.now();
    const itemCount = () => Number(document.querySelector('[data-testid="readout"]')?.textContent?.match(/· (\d+) items/)?.[1] ?? 0);
    while (itemCount() < messages) await new Promise(requestAnimationFrame);
    const firstPaint = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    // Keep the calibrated commit gate on off-screen streaming; follow behavior has separate checks below.
    scroll.scrollTop = 0;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
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
    const commitsBefore = (window as typeof window & { __fulcrumStressPerf: { commits: number } }).__fulcrumStressPerf.commits;
    raf = requestAnimationFrame(frame);
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    cancelAnimationFrame(raf); observer.disconnect(); mutations.disconnect();
    const valid = frames.filter((value) => value < 1_000);
    const sorted = [...valid].sort((a, b) => a - b);
    const p95Frame = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? Infinity;
    const fps = valid.length / (durationMs / 1_000);
    const beforeNodes = scroll.querySelectorAll("*").length;
    scroll.scrollTop = scroll.scrollHeight / 2;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const anchor = [...scroll.querySelectorAll<HTMLElement>('[data-part="message"]')].find((item) => {
      const rect = item.getBoundingClientRect(); const box = scroll.getBoundingClientRect(); return rect.top >= box.top && rect.bottom <= box.bottom;
    });
    const anchorId = anchor?.dataset.id;
    let upwardScrollShift = 0;
    if (anchorId) for (let i = 0; i < 5; i++) {
      const beforeItem = scroll.querySelector<HTMLElement>(`[data-part="message"][data-id="${anchorId}"]`);
      if (!beforeItem) break;
      const before = beforeItem.getBoundingClientRect().top; const beforeScroll = scroll.scrollTop;
      scroll.scrollBy(0, -300);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const afterItem = scroll.querySelector<HTMLElement>(`[data-part="message"][data-id="${anchorId}"]`);
      if (!afterItem) break;
      upwardScrollShift += Math.abs(afterItem.getBoundingClientRect().top - before + scroll.scrollTop - beforeScroll);
    }
    const commits = (window as typeof window & { __fulcrumStressPerf: { commits: number } }).__fulcrumStressPerf.commits - commitsBefore;
    (window as typeof window & { __stopStress: () => void }).__stopStress();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const perf = (window as typeof window & { __fulcrumPerf?: Record<string, number> }).__fulcrumPerf!;
    const rafBeforeIdle = perf.rafRequested;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return {
      case: messages, seed, firstPaint, fps, p95Frame, worstFrame: Math.max(...valid, 0),
      longTasks: longTasks.filter((value) => value > 50).length, mountedDomNodes: beforeNodes,
      mutationBatches, estimatedEvents: durationMs / 1_000 * 200,
      commitsPerEvent: commits / (durationMs / 1_000 * 200), upwardScrollShift,
      idleAnimationFrames: perf.rafRequested - rafBeforeIdle, idleTimers: perf.timersActive,
    };
  }, { messages, durationMs, seed });
}

const metrics: Metric[] = ["firstPaint", "fps", "p95Frame", "worstFrame", "longTasks", "mountedDomNodes", "commitsPerEvent", "upwardScrollShift", "idleAnimationFrames", "idleTimers"];
const percentile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
};
const median = (values: number[]) => percentile(values, 0.5);

function aggregate(samples: Record<string, number | string>[]): Record<string, any> {
  const result: Record<string, any> = { case: samples[0]!.case, samples, statistics: {} };
  for (const metric of metrics) {
    const values = samples.map((sample) => sample[metric]).filter((value): value is number => typeof value === "number");
    if (!values.length) continue;
    const statistics = { median: median(values), p90: percentile(values, 0.9), min: Math.min(...values), max: Math.max(...values), spread: Math.max(...values) - Math.min(...values) };
    result.statistics[metric] = statistics;
    result[metric] = metric === "longTasks" || metric === "mountedDomNodes" || metric === "commitsPerEvent" || metric.startsWith("idle") ? statistics.max
      : statistics.median;
  }
  return result;
}

function needsMoreSamples(result: Record<string, any>) {
  const rules = contract[result.case as TranscriptCase];
  return (Object.entries(rules) as [Metric, Rule][]).some(([metric, rule]) => {
    if (!("enforce" in rule) || !["fps", "p95Frame", "worstFrame", "firstPaint"].includes(metric)) return false;
    const stats = result.statistics[metric] as { median: number; spread: number } | undefined;
    return stats !== undefined && stats.spread > Math.abs(stats.median - rule.enforce.budget);
  });
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
    const samples: Record<string, number | string>[] = [];
    const deadline = performance.now() + caseTimeoutMs;
    let round = 0;
    do {
      for (let repetition = 1; repetition <= samplesPerRound; repetition++) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await instrument(page);
      await page.goto(`http://127.0.0.1:4173?stressMessages=${messages}`);
      await page.evaluate(() => performance.mark("stress-start"));
      await page.context().tracing.start({ screenshots: true, snapshots: true });
      const remaining = deadline - performance.now();
      const measured = await Promise.race([
        messages === 100_000
          ? page.evaluate(async ({ messages, seed }) => {
              document.querySelector<HTMLSelectElement>("#mode")!.value = `static:${messages}`;
              document.querySelector<HTMLSelectElement>("#mode")!.dispatchEvent(new Event("change", { bubbles: true }));
              const itemCount = () => Number(document.querySelector('[data-testid="readout"]')?.textContent?.match(/· (\d+) items/)?.[1] ?? 0);
              while (itemCount() < messages) await new Promise(requestAnimationFrame);
              await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              const scroll = document.querySelector<HTMLElement>('[data-part="timeline-scroll"]')!;
              return { case: messages, seed, firstPaint: performance.now() - performance.getEntriesByName("stress-start")[0]!.startTime, mountedDomNodes: scroll.querySelectorAll("*").length };
            }, { messages, seed })
          : page.selectOption("#mode", "stress").then(() => measure(page, messages)),
        Bun.sleep(Math.max(0, remaining)).then(() => ({ case: messages, timeout: `timed out after ${caseTimeoutMs} ms` })),
      ]);
      if ("timeout" in measured) {
        await page.context().tracing.stop({ path: `${artifacts}/stress-${messages}-${repetition}.zip` }).catch(() => {});
        await page.close();
        results.push(check(measured));
        break;
      }
      samples.push(measured);
      const sample = round * samplesPerRound + repetition;
      await page.screenshot({ path: `${artifacts}/stress-${messages}-${sample}.png`, fullPage: false });
      await page.context().tracing.stop({ path: `${artifacts}/stress-${messages}-${sample}.zip` });
      await page.close();
      }
      round++;
    } while (round <= maxExtraRounds && needsMoreSamples(aggregate(samples)));
    if (samples.length) results.push(check(aggregate(samples)));
  }
  const flipMe = results.flatMap((result) => result.resolvedKnownFailures);
  if (flipMe.length) {
    console.error(`FLIP ME SUMMARY: ${flipMe.length} known-fail row(s) reached their target. Flip the row explicitly after the required sequential CI runs.`);
  }
  const report = { commit: (await Bun.$`git rev-parse HEAD`.text()).trim(), browser: browser.version(), cpuThrottle: 4, repetitions, maxExtraRounds, aggregation: "median with median/p90/min/max/spread; deterministic work uses maximum", seed, contract, cases: results, flipMe };
  await Bun.write(`${artifacts}/stress-metrics.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (results.some((result) => result.failures.length)) process.exitCode = 1;
} finally {
  await browser?.close();
  const exited = once(preview, "exit").catch(() => {});
  stop();
  if (preview.exitCode === null && preview.signalCode === null) await exited;
}
