import { describe, expect, test } from "bun:test";
import { calibrateTimingGate } from "./bench-statistics.js";

describe("calibrateTimingGate", () => {
  test("enforces a stable comparison and detects a threshold-sized regression", () => {
    const stable = calibrateTimingGate([0.98, 1.01, 1.02, 0.99, 1, 1.01, 0.99], [1.16, 1.17, 1.18, 1.16, 1.17, 1.18, 1.17]);
    expect(stable.mode).toBe("enforced");
    expect(stable.threshold).toBe(1.15);
    expect(stable.pass).toBe(false);
  });

  test("makes a noisy comparison report-only instead of flaky", () => {
    const noisy = calibrateTimingGate([0.65, 1.88, 0.78, 1.63, 1.05, 1.19, 1.01], [2, 2, 2, 2, 2, 2, 2]);
    expect(noisy.threshold).toBeGreaterThan(1.5);
    expect(noisy.mode).toBe("report-only");
    expect(noisy.pass).toBe(true);
  });
});
