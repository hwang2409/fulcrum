export const median = (values: number[]) => {
  if (values.length === 0) throw new Error("median requires at least one value");
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
};

export function summarizeTimingReport(aaRatios: number[], candidateRatios: number[]) {
  return {
    aaMedian: median(aaRatios),
    candidateMedian: median(candidateRatios),
    mode: "report-only" as const,
    derivation: {
      pairCount: aaRatios.length,
      enforcement: "none",
      reason: "report-only: 7 pairs cannot bound false-red on shared runners",
    },
  };
}
