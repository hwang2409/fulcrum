export type ViewerTiming = { openMs: number; appendMs: number; openSamples: number[]; appendSamples: number[] };
export type ViewerSample = { openMs: number; openTaskMs: number; appendMs: number; appendTaskMs: number };
export type ViewerCheck = { candidate: ViewerSample | ViewerTiming; baseline: ViewerSample | Pick<ViewerTiming, "openMs" | "appendMs">; pairedRatios?: ViewerSample; budget: number; label: string };

// Absolute wall ceiling for one viewer open or append median; the paired ratios own head-only regressions.
// Recorded no-op CI medians: open 23.1-31.7 ms, append 43.6-58.3 ms; false failures of the old 64 ms ceiling
// (paired 0.97-1.01x) reached 68.5 ms. Ceiling = 68.5 ms x 1.25 = 85.6, rounded to 86: false failures ran up to
// 1.17x the highest no-op pass (68.5 / 58.3), so 1.25 leaves room for one more slower runner of that size.
// Stopgap until PR #97 replaces this constant with a same-run calibrated ceiling.
export const viewerCeilingMs = 86;

export const ratio = (candidate: number, baseline: number) => candidate / Math.max(baseline, 0.001);

const checkRatio = (check: ViewerCheck, field: "openMs" | "appendMs") => check.pairedRatios?.[field] ?? ratio(check.candidate[field], check.baseline[field]);
const checkFails = (check: ViewerCheck, field: "openMs" | "appendMs") => checkRatio(check, field) > check.budget || check.candidate[field] >= viewerCeilingMs;
const taskCheckFails = (check: ViewerCheck) => "appendTaskMs" in check.candidate && !!check.pairedRatios && check.pairedRatios.appendTaskMs > check.budget;
const openCheckFails = (check: ViewerCheck) => check.pairedRatios && "openTaskMs" in check.candidate
  ? check.pairedRatios.openTaskMs > check.budget || check.candidate.openMs >= viewerCeilingMs
  : checkFails(check, "openMs");

export function recordViewerTimingFailures(check: ViewerCheck, width: number, failures: string[]) {
  if (openCheckFails(check)) failures.push(`viewer read @ ${width}: open task ratio ${check.pairedRatios?.openTaskMs.toFixed(2) ?? checkRatio(check, "openMs").toFixed(2)}x is over ${check.budget}x ${check.label}, or the ${check.candidate.openMs.toFixed(1)} ms wall median reached the ${viewerCeilingMs} ms ceiling`);
  if (checkFails(check, "appendMs")) failures.push(`viewer read @ ${width}: append ratio ${checkRatio(check, "appendMs").toFixed(2)}x is over ${check.budget}x ${check.label}, or the ${check.candidate.appendMs.toFixed(1)} ms median reached the ${viewerCeilingMs} ms ceiling`);
  if (taskCheckFails(check)) failures.push(`viewer read @ ${width}: append task ratio ${check.pairedRatios!.appendTaskMs.toFixed(2)}x is over ${check.budget}x ${check.label}`);
}
