export type ViewerTiming = { openMs: number; appendMs: number; openSamples: number[]; appendSamples: number[] };
export type ViewerSample = { openMs: number; openTaskMs: number; appendMs: number; appendTaskMs: number };
export type Calibration = { median: number; samples: number[] };
// pairedRatios is absent only in a local run without a base; then the calibrated ceiling alone decides.
export type ViewerCheck = { candidate: ViewerSample | ViewerTiming; calibration: Calibration; pairedRatios?: ViewerSample };
type CalibratedBudget = { openMs: number; appendMs: number };

// The paired base/head ratios own head-only regressions. The calibrated ceiling owns slowness that head and base share
// (paired ratio ~1.0x): candidate median over the median of same-run fixed-DOM work (1,000 rows, 1024 px wide) under the
// same CPU throttle. It replaces a raw wall ceiling that failed slow runners at paired 0.97-1.01x (64 ms, then #109's
// 86 ms stopgap). Budget = the highest recorded no-op CI ratio (samples below) x the paired 1.4x margin.
// Within one runner the ratio moves under 1.1x. Across the three runner classes on record it moves up to 1.6x (4x-throttle
// open: 0.51x on a ~50 ms-calibration runner to 0.82x on a ~28 ms one). The safe direction: a slower runner lowers the
// ratio, so it cannot cause a false failure, but there a common open slowdown needs 2.0-2.2x to cross (open budgets
// 1.11/1.15 over 0.51/0.58x); a faster runner moves open toward its budget.
export const viewerRatioBudget = 1.4;
const calibratedMargin = viewerRatioBudget;
const withMargin = (noOpMax: Record<number, CalibratedBudget>) => Object.fromEntries(Object.entries(noOpMax).map(([width, max]) =>
  [width, { openMs: max.openMs * calibratedMargin, appendMs: max.appendMs * calibratedMargin }])) as Record<number, CalibratedBudget>;
// 4x throttle, read fixture, per width and operation. Samples: no-op runs 42492135444 a1-a5, 42492081348, and the head
// run 42523133025, plus the
// opens of the append CPU proofs 42513755996 and 42510070983 (they touch only appends). Maxima: open 0.79x @ 390
// (42510070983, fast runner), 0.82x @ 1440 (42492135444 a5, 42510070983); append 1.35x @ 390, 1.31x @ 1440. A head-only
// slowdown is owned by the paired ratios (+25 ms candidate: open task 1.70x and up); this ceiling owns common slowdowns
// (+40 ms on head and base: open 1.70x and up, append 2.24x and up).
export const pairedCalibratedBudgets = withMargin({ 390: { openMs: 0.79, appendMs: 1.35 }, 1440: { openMs: 0.82, appendMs: 1.31 } });
// Unthrottled single, lines, and read opens, and single and lines appends. Samples: no-op runs 42492135444 a1-a5 and the
// head run 42523133025, plus every proof run cell its mutation does not touch (TIMING_GATE_SLOWDOWN_MS adds work only to
// the read fixture; the +40 ms common proofs slow only the A/B pairs; the append CPU proofs touch only appends):
// 42507931601 and 42509897759 single/lines, 42507933006 and 42509899837 all, 42513755996 and 42510070983 opens.
// Maxima: open 1.04x @ 390 (single, 42509897759, fast runner), 0.91x @ 1440 (single, 42509897759 and 42510070983);
// append 0.73x at both widths (42507931601). Lowest recorded mutations: open 3.76x (read, 42507931601), append 4.31x
// (lines @ 1440, 42513755996). Read append is not judged here: it is bimodal unthrottled (12-13 ms in the same frame or
// ~25 ms in the next), and the 4x-throttled read checks above (paired append ratio, calibrated ceiling) measure the same
// append with 4x the CPU cost.
const unthrottledCalibratedBudgets = withMargin({ 390: { openMs: 1.04, appendMs: 0.73 }, 1440: { openMs: 0.91, appendMs: 0.73 } });

export const ratio = (candidate: number, baseline: number) => candidate / Math.max(baseline, 0.001);
export const median = (values: number[]) => [...values].sort((left, right) => left - right)[values.length >> 1]!;

function recordCalibratedFailure(failures: string[], name: string, candidate: number, calibration: Calibration, budget: number) {
  const normalized = ratio(candidate, calibration.median);
  if (normalized > budget) failures.push(`${name}: calibrated ceiling, candidate ${candidate.toFixed(1)} ms / calibration ${calibration.median.toFixed(1)} ms = ${normalized.toFixed(2)}x is over ${budget.toFixed(2)}x`);
}

export function recordUnthrottledViewerFailures(measured: { fixture: string; width: number; openMs: number; appendMs: number; calibration: Calibration }, failures: string[]) {
  for (const field of ["openMs", "appendMs"] as const) if (field === "openMs" || measured.fixture !== "read")
    recordCalibratedFailure(failures, `viewer ${measured.fixture} @ ${measured.width} ${field === "openMs" ? "open" : "append"}`, measured[field], measured.calibration, unthrottledCalibratedBudgets[measured.width]![field]);
}

export function recordViewerTimingFailures(check: ViewerCheck, width: number, failures: string[]) {
  const paired = check.pairedRatios;
  if (paired) for (const [field, name] of [["openTaskMs", "open task"], ["appendMs", "append"], ["appendTaskMs", "append task"]] as const)
    if (paired[field] > viewerRatioBudget) failures.push(`viewer read @ ${width}: ${name} ratio ${paired[field].toFixed(2)}x is over ${viewerRatioBudget}x paired base/head`);
  for (const field of ["openMs", "appendMs"] as const)
    recordCalibratedFailure(failures, `viewer read @ ${width} ${field === "openMs" ? "open" : "append"} (4x throttle)`, check.candidate[field], check.calibration, pairedCalibratedBudgets[width]![field]);
}

// One side of an append scaling pair: the first append after open (4x throttle, one 65,535-character line).
export type ScalingSide = { appendTaskMs: number; appendPushes: number; segmentPushes: number };
// The same append at 16k and at 128k lines, measured back to back in alternating order.
export type ScalingPair = { small: ScalingSide; large: ScalingSide };
export type ScalingCheck = { pairs: ScalingPair[]; mountedRows: number };

// Append scaling owns O(n)-per-append viewer work (layout.ts contract (c)). Correct virtualized work is O(visible), so
// the 128k/16k append task ratio stays near 1x. Each pair's ratio cancels the runner drift that two medians taken apart
// did not (the old ratio of medians ran 0.77-2.27x on no-op runs and overlapped the regression). Budget = the highest
// no-op median over 21 pairs x the shared 1.4x margin. No-op: 20 CI jobs on 4 runner classes (runs 42536743002 and
// 42537804733), 0.887-0.991x. Contract-size O(n) mutation (55 ms per append at 128k, 6.9 ms at 16k): 10 jobs (runs
// 42536755137 and 42537806722), 1.905-2.417x, so the lowest sits 1.37x over the budget.
export const viewerScalingTaskBudget = 0.991 * viewerRatioBudget;
// Canaries: Array.push and pushed `text-*` segments per append. Rebuilding segments or visiting every row raises them.
const segmentPushBudget = 1.4;
const pushBudget = 1.8;
const mountedRowsBudget = 200;

export function recordViewerScalingFailures({ pairs, mountedRows }: ScalingCheck, failures: string[]) {
  const pairRatios = (field: (side: ScalingSide) => number) => pairs.map(({ small, large }) => ratio(field(large), field(small)));
  const taskRatios = pairRatios((side) => side.appendTaskMs);
  const summary = { taskRatio: median(taskRatios), taskRatios, segmentPushRatio: median(pairRatios((side) => side.segmentPushes + 1)), pushRatio: median(pairRatios((side) => side.appendPushes)) };
  const name = "viewer append scaling";
  if (summary.taskRatio > viewerScalingTaskBudget) failures.push(`${name}: median paired 128k/16k task ratio ${summary.taskRatio.toFixed(3)}x is over ${viewerScalingTaskBudget.toFixed(3)}x (pairs ${taskRatios.map((value) => value.toFixed(3)).join(", ")})`);
  if (summary.segmentPushRatio > segmentPushBudget) failures.push(`${name}: canary 128k/16k segment-push ratio ${summary.segmentPushRatio.toFixed(3)}x is over ${segmentPushBudget.toFixed(3)}x`);
  if (summary.pushRatio > pushBudget) failures.push(`${name}: canary 128k/16k all-push ratio ${summary.pushRatio.toFixed(3)}x is over ${pushBudget.toFixed(3)}x`);
  if (mountedRows > mountedRowsBudget) failures.push(`${name}: 1m mounted rows ${mountedRows} is over ${mountedRowsBudget}`);
  return summary;
}
