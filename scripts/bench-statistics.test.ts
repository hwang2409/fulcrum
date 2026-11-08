import { describe, expect, test } from "bun:test";
import { summarizeTimingReport } from "./bench-statistics.js";

describe("summarizeTimingReport", () => {
  test("keeps the seven-pair comparison report-only", () => {
    const report = summarizeTimingReport(
      [0.823, 1.018, 0.983, 0.955, 0.993, 0.967, 0.975],
      [1.16, 1.17, 1.18, 1.16, 1.17, 1.18, 1.17],
    );

    expect(report).toEqual({
      aaMedian: 0.975,
      candidateMedian: 1.17,
      mode: "report-only",
      derivation: {
        pairCount: 7,
        enforcement: "none",
        reason: "report-only: 7 pairs cannot bound false-red on shared runners",
      },
    });
  });
});
