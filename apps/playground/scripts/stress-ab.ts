import { chromium, type Browser, type Page } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { once } from "node:events";
import {
  stressVerdict,
  type StressRatios,
  type StressVerdict,
} from "./stress-ab-verdict";

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
// Known limit: each run compares the candidate with its own base (the PR
// merge-base, or HEAD^ on main), so this gate catches one change that is
// 20% slower or more. Several smaller slowdowns can still add up across PRs.
// The per-run reports expose the long-term trend; add a pinned-baseline trend
// check if drift is ever seen.
const threshold = 1.2;
const maxExtraRounds = 2;
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
      new MutationObserver(() => burn(mode === "render-work-small" ? 10 : 20)).observe(document, {
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
    maxExtraRounds,
    cases: [],
  };
  let failed = false;
  for (const messages of cases) {
    const aa: StressRatios[] = [];
    const rows: {
      pair: number;
      base: Awaited<ReturnType<typeof sample>>;
      candidate: Awaited<ReturnType<typeof sample>>;
      ratios: StressRatios;
    }[] = [];
    const rounds: unknown[] = [];
    let round = 0;
    let aaMedians: StressRatios;
    let aaSpread: StressRatios;
    let medians: StressRatios;
    let verdict: StressVerdict;

    do {
      for (let i = 0; i < pairs; i++) {
        const index = round * pairs + i;
        const aaA = await sample(browser, baseUrl, messages, "aa-a", index);
        const aaB = await sample(browser, baseUrl, messages, "aa-b", index);
        aa.push({
          firstPaint: ratio(aaB.firstPaint, aaA.firstPaint),
          taskDuration: ratio(aaB.taskDuration, aaA.taskDuration),
        });
        const first = await sample(
          browser,
          index % 2 === 0 ? baseUrl : candidateUrl,
          messages,
          index % 2 === 0 ? "base" : "candidate",
          index,
        );
        const second = await sample(
          browser,
          index % 2 === 0 ? candidateUrl : baseUrl,
          messages,
          index % 2 === 0 ? "candidate" : "base",
          index,
        );
        const base = index % 2 === 0 ? first : second;
        const candidate = index % 2 === 0 ? second : first;
        rows.push({
          pair: index + 1,
          base,
          candidate,
          ratios: {
            firstPaint: ratio(candidate.firstPaint, base.firstPaint),
            taskDuration: ratio(candidate.taskDuration, base.taskDuration),
          },
        });
      }

      aaMedians = {
        firstPaint: median(aa.map((x) => x.firstPaint)),
        taskDuration: median(aa.map((x) => x.taskDuration)),
      };
      aaSpread = {
        firstPaint:
          Math.max(...aa.map((x) => x.firstPaint)) -
          Math.min(...aa.map((x) => x.firstPaint)),
        taskDuration:
          Math.max(...aa.map((x) => x.taskDuration)) -
          Math.min(...aa.map((x) => x.taskDuration)),
      };
      medians = {
        firstPaint: median(rows.map((row) => row.ratios.firstPaint)),
        taskDuration: median(rows.map((row) => row.ratios.taskDuration)),
      };
      verdict = stressVerdict(
        medians,
        aaSpread,
        threshold,
        maxExtraRounds - round,
      );
      rounds.push({
        round: round + 1,
        pooledPairs: rows.length,
        aaMedians,
        aaSpread,
        medians,
        verdict,
      });
      console.log(
        JSON.stringify(
          {
            case: messages,
            round: round + 1,
            pooledPairs: rows.length,
            aaMedians,
            aaSpread,
            threshold,
            medians,
            verdict,
          },
          null,
          2,
        ),
      );
      if (verdict.status === "inconclusive")
        console.warn(
          `inconclusive A/B result for ${messages} messages; bounded resample ${round + 1}/${maxExtraRounds}`,
        );
      round++;
    } while (verdict.status === "inconclusive");

    failed ||= verdict.status === "fail";
    if (verdict.reason) console.error(`${verdict.reason}: ${messages} messages`);
    (report.cases as unknown[]).push({
      case: messages,
      aa,
      aaMedians,
      aaSpread,
      threshold,
      pairs: rows,
      medians,
      verdict,
      rounds,
    });
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
