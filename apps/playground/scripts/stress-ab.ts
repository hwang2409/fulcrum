import { chromium, type Browser, type Page } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { once } from "node:events";

const baseUrl = process.env.STRESS_BASE_URL;
const candidateUrl = process.env.STRESS_CANDIDATE_URL;
const inject = process.env.STRESS_INJECT;
const baseRoot = process.env.STRESS_BASE_ROOT;
const candidateRoot =
  process.env.STRESS_CANDIDATE_ROOT ?? new URL("..", import.meta.url).pathname;
if (!baseUrl || !candidateUrl || !baseRoot)
  throw new Error(
    "STRESS_BASE_ROOT, STRESS_BASE_URL, and STRESS_CANDIDATE_URL are required",
  );
const cases = [200, 5_000] as const;
const pairs = 7;
const calibrationRuns = 7;
const threshold = 1.2;
const aaWarningThreshold = 1.1;
const viewport = { width: 1440, height: 900 };
const artifacts = new URL("../stress-artifacts/", import.meta.url).pathname;
const browserArgs = ["x", "vite", "preview", "--host", "127.0.0.1"];
const servers: ChildProcess[] = [];
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const busy = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {}
};

function server(root: string, port: number) {
  const child = spawn("bun", [...browserArgs, "--port", String(port)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(child);
  return child;
}
async function waitFor(url: string, child: ChildProcess) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    if (child.exitCode !== null) throw new Error(`preview exited for ${url}`);
    await Bun.sleep(100);
  }
  throw new Error(`preview did not start: ${url}`);
}
async function injection(page: Page, url: string) {
  if (!inject || url !== candidateUrl) return;
  await page.addInitScript((mode) => {
    const burn = (ms: number) => {
      const end = performance.now() + ms;
      while (performance.now() < end) {}
    };
    if (mode === "frame-work" || mode === "row-subscription") {
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) =>
        raf((time) => {
          burn(5);
          callback(time);
        });
    }
    if (mode === "render-work" || mode === "render-work-small") {
      // Pure render work: add CPU without changing rows, commits, or DOM output.
      new MutationObserver(() => burn(mode === "render-work-small" ? 5 : 20)).observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    }
  }, inject);
}
async function sample(
  browser: Browser,
  url: string,
  messages: number,
  label: string,
  index: number,
) {
  const page = await browser.newPage({ viewport });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await injection(page, url);
  await page.goto(`${url}?stressMessages=${messages}`);
  await page.evaluate(() => performance.mark("stress-start"));
  const before =
    (await cdp.send("Performance.getMetrics")).metrics.find(
      (metric) => metric.name === "TaskDuration",
    )?.value ?? 0;
  await page.selectOption("#mode", "stress");
  const result = await page.evaluate(
    async ({ messages }) => {
      const started =
        performance.getEntriesByName("stress-start")[0]?.startTime ??
        performance.now();
      const itemCount = () =>
        Number(
          document
            .querySelector('[data-testid="readout"]')
            ?.textContent?.match(/· (\d+) items/)?.[1] ?? 0,
        );
      while (itemCount() < messages) await new Promise(requestAnimationFrame);
      const firstPaint = performance.now() - started;
      return { firstPaint };
    },
    { messages },
  );
  const after =
    (await cdp.send("Performance.getMetrics")).metrics.find(
      (metric) => metric.name === "TaskDuration",
    )?.value ?? before;
  const measured = {
    case: messages,
    firstPaint: result.firstPaint,
    taskDuration: (after - before) * 1_000,
  };
  await page.close();
  await Bun.write(
    `${artifacts}/stress-ab-${messages}-${label}-${index}.json`,
    JSON.stringify(measured, null, 2),
  );
  return measured;
}
function ratio(candidate: number, base: number) {
  return candidate / Math.max(base, 0.001);
}

let browser: Browser | undefined;
try {
  await mkdir(artifacts, { recursive: true });
  const base = server(baseRoot, 4174);
  const candidate = server(candidateRoot, 4173);
  await Promise.all([
    waitFor(`${baseUrl}/`, base),
    waitFor(`${candidateUrl}/`, candidate),
  ]);
  browser = await chromium.launch();
  const report: Record<string, unknown> = {
    baseUrl,
    candidateUrl,
    inject: inject ?? null,
    cpuThrottle: 4,
    viewport,
    pairs,
    calibrationRuns,
    cases: [],
  };
  let failed = false;
  for (const messages of cases) {
    const aa: { firstPaint: number; taskDuration: number }[] = [];
    const rows: unknown[] = [];
    for (let i = 0; i < pairs; i++) {
      const aaA = await sample(browser, baseUrl, messages, "aa-a", i);
      const aaB = await sample(browser, baseUrl, messages, "aa-b", i);
      aa.push({
        firstPaint: ratio(aaB.firstPaint, aaA.firstPaint),
        taskDuration: ratio(aaB.taskDuration, aaA.taskDuration),
      });
      const first = await sample(
        browser,
        i % 2 === 0 ? baseUrl : candidateUrl,
        messages,
        i % 2 === 0 ? "base" : "candidate",
        i,
      );
      const second = await sample(
        browser,
        i % 2 === 0 ? candidateUrl : baseUrl,
        messages,
        i % 2 === 0 ? "candidate" : "base",
        i,
      );
      const base = i % 2 === 0 ? first : second;
      const candidate = i % 2 === 0 ? second : first;
      rows.push({
        pair: i + 1,
        base,
        candidate,
        ratios: {
          firstPaint: ratio(candidate.firstPaint, base.firstPaint),
          taskDuration: ratio(candidate.taskDuration, base.taskDuration),
        },
      });
    }
    const aaMedians = {
      firstPaint: median(aa.map((x) => x.firstPaint)),
      taskDuration: median(aa.map((x) => x.taskDuration)),
    };
    const aaSpread = {
      firstPaint: Math.max(...aa.map((x) => x.firstPaint)) - Math.min(...aa.map((x) => x.firstPaint)),
      taskDuration: Math.max(...aa.map((x) => x.taskDuration)) - Math.min(...aa.map((x) => x.taskDuration)),
    };
    const ratios = rows.map((row) => (row as any).ratios);
    const medians = {
      firstPaint: median(ratios.map((x: any) => x.firstPaint)),
      taskDuration: median(ratios.map((x: any) => x.taskDuration)),
    };
    const failures = ["firstPaint", "taskDuration"].filter(
      (metric) => medians[metric as keyof typeof medians] > threshold,
    );
    failed ||= failures.length > 0;
    (report.cases as unknown[]).push({
      case: messages,
      aa,
      aaMedians,
      aaSpread,
      aaWarning: ["firstPaint", "taskDuration"].filter(
        (metric) => aaMedians[metric as keyof typeof aaMedians] > aaWarningThreshold,
      ),
      threshold,
      pairs: rows,
      medians,
      failures,
    });
    if (Object.keys(aaMedians).some((metric) => aaMedians[metric as keyof typeof aaMedians] > aaWarningThreshold))
      console.warn(`A/A noise warning for ${messages} messages: ${JSON.stringify(aaMedians)}`);
    console.log(JSON.stringify({ case: messages, aaMedians, aaSpread, threshold, medians, failures }, null, 2));
  }
  await Bun.write(
    `${artifacts}/stress-ab-report.json`,
    JSON.stringify(report, null, 2),
  );
  if (failed) process.exitCode = 1;
} finally {
  await browser?.close();
  for (const child of servers) child.kill("SIGTERM");
  await Promise.all(
    servers.map((child) => once(child, "exit").catch(() => {})),
  );
}
