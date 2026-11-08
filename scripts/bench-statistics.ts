export const median = (values: number[]) => {
  if (values.length === 0) throw new Error("median requires at least one value");
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
};

const MAD_MULTIPLIER = 3;
const MINIMUM_RATIO = 1.15;
const MAXIMUM_USEFUL_RATIO = 1.5;

export function calibrateTimingGate(aaRatios: number[], candidateRatios: number[]) {
  const aaLogs = aaRatios.map(Math.log);
  const aaMedianLog = median(aaLogs);
  const aaMadLog = median(aaLogs.map((value) => Math.abs(value - aaMedianLog)));
  const derivedRatio = Math.exp(aaMedianLog + MAD_MULTIPLIER * aaMadLog);
  const threshold = Math.max(MINIMUM_RATIO, derivedRatio);
  const candidateMedian = Math.exp(median(candidateRatios.map(Math.log)));
  const enforced = threshold <= MAXIMUM_USEFUL_RATIO;

  return {
    aaMedian: Math.exp(aaMedianLog),
    aaMadLog,
    candidateMedian,
    threshold,
    mode: enforced ? "enforced" as const : "report-only" as const,
    pass: !enforced || candidateMedian <= threshold,
    derivation: {
      madMultiplier: MAD_MULTIPLIER,
      minimumRatio: MINIMUM_RATIO,
      maximumUsefulRatio: MAXIMUM_USEFUL_RATIO,
      falseRedModel: "3 MAD is about 2.02 sigma for normal log noise: about 2.2% per pair and 0.0008% for a 7-pair median",
      reason: enforced
        ? "the measured noise supports a useful regression threshold"
        : "the measured noise requires a threshold above the 1.5x useful-sensitivity ceiling",
    },
  };
}
