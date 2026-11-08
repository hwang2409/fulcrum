export type ViewerTiming = { openMs: number; appendMs: number; openSamples: number[]; appendSamples: number[] };
export type ViewerSample = { openMs: number; openTaskMs: number; appendMs: number; appendTaskMs: number };
export type ViewerCheck = { candidate: ViewerSample | ViewerTiming; baseline: ViewerSample | Pick<ViewerTiming, "openMs" | "appendMs">; pairedRatios?: ViewerSample; budget: number; label: string };

export const viewerCeilingMs = 64;

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
