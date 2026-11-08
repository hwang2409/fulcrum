import { describe, expect, test } from "bun:test";
import { stressVerdict, type StressRatios } from "./stress-ab-verdict";

const threshold = 1.2;
const quiet = { firstPaint: 0.1, taskDuration: 0.12 };
const noisy = { firstPaint: 0.42, taskDuration: 0.431 };

describe("stressVerdict", () => {
  const cases: {
    name: string;
    medians: StressRatios;
    aaSpread: StressRatios;
    resamplesRemaining: number;
    status: "pass" | "fail" | "inconclusive";
    reason?: string;
  }[] = [
    {
      name: "treats the PR #93 borderline result as inconclusive",
      medians: { firstPaint: 1.2215, taskDuration: 1.2244 },
      aaSpread: noisy,
      resamplesRemaining: 2,
      status: "inconclusive",
    },
    {
      name: "passes no effect on a quiet runner",
      medians: { firstPaint: 1.02, taskDuration: 0.99 },
      aaSpread: quiet,
      resamplesRemaining: 2,
      status: "pass",
    },
    {
      name: "fails a real regression on a quiet runner",
      medians: { firstPaint: 1.22, taskDuration: 1.21 },
      aaSpread: quiet,
      resamplesRemaining: 2,
      status: "fail",
    },
    {
      name: "passes a no-op on a noisy runner without resampling",
      medians: { firstPaint: 1.01, taskDuration: 0.99 },
      aaSpread: noisy,
      resamplesRemaining: 2,
      status: "pass",
    },
    {
      name: "fails a huge regression even on a noisy runner",
      medians: { firstPaint: 2, taskDuration: 1.95 },
      aaSpread: noisy,
      resamplesRemaining: 2,
      status: "fail",
    },
    {
      name: "never passes a real 1.3x regression on a noisy runner",
      medians: { firstPaint: 1.3, taskDuration: 1.3 },
      aaSpread: noisy,
      resamplesRemaining: 0,
      status: "fail",
      reason: "inconclusive: runner noise exceeded the detectable effect",
    },
    {
      name: "fails a still-inconclusive result after the resample bound",
      medians: { firstPaint: 1.2215, taskDuration: 1.2244 },
      aaSpread: noisy,
      resamplesRemaining: 0,
      status: "fail",
      reason: "inconclusive: runner noise exceeded the detectable effect",
    },
  ];

  for (const row of cases) {
    test(row.name, () => {
      const result = stressVerdict(
        row.medians,
        row.aaSpread,
        threshold,
        row.resamplesRemaining,
      );
      expect(result.status).toBe(row.status);
      if (row.reason) expect(result.reason).toBe(row.reason);
    });
  }
});
