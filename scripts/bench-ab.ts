import { runWorkload, type WorkloadResult } from "./bench-workload.js";

const baseRoot = process.env.BENCH_BASE_ROOT;
const candidateRoot = process.env.BENCH_CANDIDATE_ROOT ?? new URL("..", import.meta.url).pathname;
if (!baseRoot) throw new Error("BENCH_BASE_ROOT is required");
const pairs = 7;
const aaWarning = 1.1;
const maximumThreshold = 1.2;
const headroom = 0.05;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const ratio = (candidate: WorkloadResult, base: WorkloadResult) => candidate.stream.large / Math.max(base.stream.large, 0.001);
const aa: number[] = [];
const rawPairs: { order: string; base: WorkloadResult; candidate: WorkloadResult; ratio: number }[] = [];
for (let i = 0; i < pairs; i++) {
  const aaFirst = await runWorkload(baseRoot);
  const aaSecond = await runWorkload(baseRoot);
  aa.push(ratio(aaSecond, aaFirst));
  const baseFirst = i % 2 === 0;
  const firstRoot = baseFirst ? baseRoot : candidateRoot;
  const secondRoot = baseFirst ? candidateRoot : baseRoot;
  const first = await runWorkload(firstRoot, firstRoot === candidateRoot && process.env.BENCH_INJECT === "25");
  const second = await runWorkload(secondRoot, secondRoot === candidateRoot && process.env.BENCH_INJECT === "25");
  const base = baseFirst ? first : second;
  const candidate = baseFirst ? second : first;
  rawPairs.push({ order: baseFirst ? "base-candidate" : "candidate-base", base, candidate, ratio: ratio(candidate, base) });
}
const aaMedian = median(aa);
const candidateMedian = median(rawPairs.map((pair) => pair.ratio));
const threshold = Math.min(maximumThreshold, Math.max(aaWarning, aaMedian + headroom));
const report = {
  rawPairs,
  medians: { aa: aaMedian, candidateBase: candidateMedian },
  aaNoise: aa,
  environment: { bun: Bun.version, os: process.platform, runner: process.env.GITHUB_ACTIONS ? "github-actions" : "local", throttle: "none" },
  thresholdDerivation: { aaWarning, measuredAaMedian: aaMedian, headroom, threshold, maximumThreshold },
  gate: aaMedian <= aaWarning ? { mode: "enforced", pass: candidateMedian <= threshold } : { mode: "report-only", pass: true, reason: "A/A median exceeded 1.10" },
};
console.log(JSON.stringify(report, null, 2));
if (report.gate.mode === "enforced" && !report.gate.pass) {
  console.error(`paired performance ratio failed: ${candidateMedian.toFixed(3)} > ${threshold.toFixed(3)}`);
  process.exit(1);
}
