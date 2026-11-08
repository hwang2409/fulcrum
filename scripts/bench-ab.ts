import { calibrateTimingGate } from "./bench-statistics.js";
import { runWorkload, type WorkloadResult } from "./bench-workload.js";

const baseRoot = process.env.BENCH_BASE_ROOT;
const candidateRoot = process.env.BENCH_CANDIDATE_ROOT ?? new URL("..", import.meta.url).pathname;
if (!baseRoot) throw new Error("BENCH_BASE_ROOT is required");
const pairs = 7;
const injected = process.env.BENCH_INJECT === "25";
const timing = (result: WorkloadResult) => result.timedCpu;
const ratio = (candidate: WorkloadResult, base: WorkloadResult) => timing(candidate) / Math.max(timing(base), 0.001);
const aaRatios: number[] = [];
const rawPairs: { order: string; base: WorkloadResult; candidate: WorkloadResult; ratio: number }[] = [];

for (let i = 0; i < pairs; i++) {
  const aaFirst = await runWorkload(baseRoot);
  const aaSecond = await runWorkload(baseRoot);
  aaRatios.push(i % 2 === 0 ? ratio(aaSecond, aaFirst) : ratio(aaFirst, aaSecond));

  const baseFirst = i % 2 === 0;
  const firstRoot = baseFirst ? baseRoot : candidateRoot;
  const secondRoot = baseFirst ? candidateRoot : baseRoot;
  const first = await runWorkload(firstRoot, injected && !baseFirst);
  const second = await runWorkload(secondRoot, injected && baseFirst);
  const base = baseFirst ? first : second;
  const candidate = baseFirst ? second : first;
  rawPairs.push({ order: baseFirst ? "base-candidate" : "candidate-base", base, candidate, ratio: ratio(candidate, base) });
}

const calibration = calibrateTimingGate(aaRatios, rawPairs.map(({ ratio }) => ratio));
const report = {
  rawPairs,
  aaRatios,
  calibration,
  injection: injected ? { requestedSlowdownPercent: 25, method: "add 25% of each unmodified sample's process CPU" } : null,
  environment: { bun: Bun.version, os: process.platform, runner: process.env.GITHUB_ACTIONS ? "github-actions" : "local", timing: "process CPU", throttle: "none" },
};
console.log(JSON.stringify(report, null, 2));
if (!calibration.pass) {
  console.error(`paired performance ratio failed: ${calibration.candidateMedian.toFixed(3)} > ${calibration.threshold.toFixed(3)}`);
  process.exit(1);
}
