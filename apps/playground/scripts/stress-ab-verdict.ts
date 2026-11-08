export type StressRatios = {
  firstPaint: number;
  taskDuration: number;
};

export type StressVerdict = {
  status: "pass" | "fail" | "inconclusive";
  failures: (keyof StressRatios)[];
  reason?: string;
};

const metrics = ["firstPaint", "taskDuration"] as const;
const inconclusiveReason =
  "inconclusive: runner noise exceeded the detectable effect";

export function stressVerdict(
  medians: StressRatios,
  aaSpread: StressRatios,
  threshold: number,
  resamplesRemaining: number,
): StressVerdict {
  const detectableEffect = threshold - 1;
  const aboveThreshold = metrics.filter(
    (metric) => medians[metric] > threshold,
  );
  const failures = aboveThreshold.filter(
    (metric) =>
      aaSpread[metric] <= detectableEffect ||
      medians[metric] - aaSpread[metric] > threshold,
  );

  if (failures.length > 0) return { status: "fail", failures };
  if (aboveThreshold.length === 0) return { status: "pass", failures: [] };
  if (resamplesRemaining > 0)
    return { status: "inconclusive", failures: [] };
  return {
    status: "fail",
    failures: aboveThreshold,
    reason: inconclusiveReason,
  };
}
