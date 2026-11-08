import { describe, expect, test } from "bun:test";
import { recordViewerTimingFailures, type ViewerSample } from "./viewer-verdict";

// Recorded CI medians. A false failure logs only the failing append median, so its open wall is the highest
// recorded no-op open median (31.7 ms, run 42492081348). Task medians are judged only through their paired ratios.
const maxNoOpOpenMs = 31.7;
const sample = (openMs: number, appendMs: number): ViewerSample => ({ openMs, openTaskMs: 0, appendMs, appendTaskMs: 0 });
const paired = (openMs: number, openTaskMs: number, appendMs: number, appendTaskMs: number): ViewerSample => ({ openMs, openTaskMs, appendMs, appendTaskMs });

describe("recordViewerTimingFailures", () => {
  const cases: { name: string; candidate: ViewerSample; ratios: ViewerSample; fails: RegExp[] }[] = [
    { name: "42396969943 a1 @ 390 false failure", candidate: sample(maxNoOpOpenMs, 66.8), ratios: paired(1.01, 1.01, 0.98, 1.01), fails: [] },
    { name: "42396969943 a1 @ 1440 false failure", candidate: sample(maxNoOpOpenMs, 68.1), ratios: paired(0.97, 0.97, 0.98, 0.99), fails: [] },
    { name: "42472956579 @ 390 false failure", candidate: sample(maxNoOpOpenMs, 65.3), ratios: paired(1.04, 1.03, 1.01, 0.98), fails: [] },
    { name: "42472956579 @ 1440 false failure", candidate: sample(maxNoOpOpenMs, 68.5), ratios: paired(1.01, 1.06, 1.01, 1.07), fails: [] },
    { name: "42494975568 a1 @ 390 false failure", candidate: sample(maxNoOpOpenMs, 64.6), ratios: paired(0.98, 0.96, 0.97, 0.95), fails: [] },
    { name: "42494975568 a1 @ 1440 false failure", candidate: sample(maxNoOpOpenMs, 65.7), ratios: paired(1.04, 1.02, 1.00, 1.01), fails: [] },
    { name: "42492135444 a1 @ 1440 highest no-op pass", candidate: sample(28.5, 58.3), ratios: paired(1.02, 1.01, 1.01, 0.99), fails: [] },
    { name: "head-only regression fails by the paired ratio", candidate: sample(25, 50), ratios: paired(1, 1, 1.6, 1.6), fails: [/append ratio 1\.60x is over 1\.4x/, /append task ratio 1\.60x/] },
    { name: "common slowdown at 2x the highest no-op median fails by the ceiling", candidate: sample(maxNoOpOpenMs, 116.6), ratios: paired(1, 1, 1, 1), fails: [/append ratio 1\.00x .*116\.6 ms median reached the 86 ms ceiling/] },
    { name: "common open slowdown above the ceiling fails by the ceiling", candidate: sample(90, 50), ratios: paired(1, 1, 1, 1), fails: [/90\.0 ms wall median reached the 86 ms ceiling/] },
  ];
  for (const { name, candidate, ratios, fails } of cases) {
    test(name, () => {
      const failures: string[] = [];
      recordViewerTimingFailures({ candidate, baseline: candidate, pairedRatios: ratios, budget: 1.4, label: "paired base/head" }, 390, failures);
      expect(failures).toHaveLength(fails.length);
      fails.forEach((pattern, index) => expect(failures[index]).toMatch(pattern));
    });
  }
});
