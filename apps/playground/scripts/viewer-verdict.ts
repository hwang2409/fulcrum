export type ViewerTiming = { openMs: number; appendMs: number; openSamples: number[]; appendSamples: number[] };
export type ViewerSample = { openMs: number; openTaskMs: number; appendMs: number; appendTaskMs: number };
export type Calibration = { median: number; samples: number[] };
export type ViewerCheck = { candidate: ViewerSample | ViewerTiming; baseline: ViewerSample | Pick<ViewerTiming, "openMs" | "appendMs">; calibration: Calibration; pairedRatios?: ViewerSample; budget: number; label: string };
type CalibratedBudget = { openMs: number; appendMs: number };

// The paired base/head ratios own head-only regressions. The calibrated ceiling owns slowness that head and base share
// (paired ratio ~1.0x): candidate median over the median of same-run fixed-DOM work (1,000 rows, 1024 px wide) under the
// same CPU throttle. It replaces a raw wall ceiling that failed slow runners at paired 0.97-1.01x (64 ms, then #109's
// 86 ms stopgap). Budget = the highest settled no-op CI ratio (PR #97, runs listed there) x the paired 1.4x margin.
// Within one runner the ratio moves under 1.1x; across runner classes it moved up to 1.32x (open @ 1440: 0.62-0.82x).
export const viewerRatioBudget = 1.4;
const calibratedMargin = viewerRatioBudget;
const withMargin = (noOpMax: Record<number, CalibratedBudget>) => Object.fromEntries(Object.entries(noOpMax).map(([width, max]) =>
  [width, { openMs: max.openMs * calibratedMargin, appendMs: max.appendMs * calibratedMargin }])) as Record<number, CalibratedBudget>;
// 4x throttle, read fixture, per width and operation.
export const pairedCalibratedBudgets = withMargin({ 390: { openMs: 0.71, appendMs: 1.35 }, 1440: { openMs: 0.82, appendMs: 1.31 } });
// Unthrottled single, lines, and read fixtures. Read append is bimodal (it lands in the same or the next frame:
// 1.26x or up to 2.96x), at any width, so append shares one budget across widths.
export const unthrottledCalibratedBudgets = withMargin({ 390: { openMs: 0.92, appendMs: 2.96 }, 1440: { openMs: 0.86, appendMs: 2.96 } });

export const ratio = (candidate: number, baseline: number) => candidate / Math.max(baseline, 0.001);

export function recordCalibratedFailure(failures: string[], name: string, candidate: number, calibration: Calibration, budget: number) {
  const normalized = ratio(candidate, calibration.median);
  if (normalized > budget) failures.push(`${name}: calibrated ceiling, candidate ${candidate.toFixed(1)} ms / calibration ${calibration.median.toFixed(1)} ms = ${normalized.toFixed(2)}x is over ${budget.toFixed(2)}x`);
}

const checkRatio = (check: ViewerCheck, field: "openMs" | "appendMs") => check.pairedRatios?.[field] ?? ratio(check.candidate[field], check.baseline[field]);

export function recordViewerTimingFailures(check: ViewerCheck, width: number, failures: string[]) {
  const openRatio = check.pairedRatios?.openTaskMs ?? checkRatio(check, "openMs");
  if (openRatio > check.budget) failures.push(`viewer read @ ${width}: open ${check.pairedRatios ? "task " : ""}ratio ${openRatio.toFixed(2)}x is over ${check.budget}x ${check.label}`);
  if (checkRatio(check, "appendMs") > check.budget) failures.push(`viewer read @ ${width}: append ratio ${checkRatio(check, "appendMs").toFixed(2)}x is over ${check.budget}x ${check.label}`);
  if (check.pairedRatios && check.pairedRatios.appendTaskMs > check.budget) failures.push(`viewer read @ ${width}: append task ratio ${check.pairedRatios.appendTaskMs.toFixed(2)}x is over ${check.budget}x ${check.label}`);
  for (const field of ["openMs", "appendMs"] as const)
    recordCalibratedFailure(failures, `viewer read @ ${width} ${field === "openMs" ? "open" : "append"} (4x throttle)`, check.candidate[field], check.calibration, pairedCalibratedBudgets[width]![field]);
}
