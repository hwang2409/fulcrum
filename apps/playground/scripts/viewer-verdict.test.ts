import { describe, expect, test } from "bun:test";
import * as verdict from "./viewer-verdict"; // a namespace import, so the table also runs against older verdict modules
import type { ViewerSample } from "./viewer-verdict";

const { recordViewerTimingFailures } = verdict;

// A settled no-op CI run (42492135444 a2 @ 1440, 4x throttle): candidate open 26.8 ms, append 55.8 ms, open task
// 34.9 ms, append task 74.9 ms; fixed-DOM calibration 42.9 ms; paired ratios ~1.0x.
const noOp = { openMs: 26.8, openTaskMs: 34.9, appendMs: 55.8, appendTaskMs: 74.9, calibration: 42.9 };
const sample = (openMs: number, appendMs: number): ViewerSample => ({ openMs, openTaskMs: 0, appendMs, appendTaskMs: 0 });
const paired = (openMs: number, openTaskMs: number, appendMs: number, appendTaskMs: number): ViewerSample => ({ openMs, openTaskMs, appendMs, appendTaskMs });
const even = paired(1, 1, 1, 1);
// A runner `factor` times slower slows the viewer and the fixed work alike; the false failures did not log calibration.
const slowRunner = (factor: number) => ({ candidate: sample(noOp.openMs * factor, noOp.appendMs * factor), calibration: noOp.calibration * factor });

describe("recordViewerTimingFailures", () => {
  const cases: { name: string; width?: number; candidate: ViewerSample; calibration: number; ratios?: ViewerSample; fails: RegExp[] }[] = [
    // Shared runner slowdowns: head and base slow together, so nothing fails. The raw 64 ms and 86 ms ceilings failed these.
    { name: "42396969943 a1 @ 1440 false failure passes", ...slowRunner(68.1 / noOp.appendMs), ratios: paired(0.97, 0.97, 0.98, 0.99), fails: [] },
    { name: "42472956579 @ 1440 false failure passes", ...slowRunner(68.5 / noOp.appendMs), ratios: paired(1.01, 1.06, 1.01, 1.07), fails: [] },
    { name: "42494975568 a1 @ 1440 false failure passes", ...slowRunner(65.7 / noOp.appendMs), ratios: paired(1.04, 1.02, 1.00, 1.01), fails: [] },
    { name: "a runner 1.6x slower passes", ...slowRunner(1.6), ratios: even, fails: [] },
    { name: "a fast runner's no-op run passes (42492135444 a5 @ 1440)", candidate: sample(22.8, 31.3), calibration: 27.9, ratios: paired(1.03, 1.06, 1.00, 1.00), fails: [] },
    // The append CPU proof leaves the open untouched: its 390 open (0.79x, fast runner) is the highest no-op open. Its
    // candidate append was the mutation, so the row uses that run's base append (31.0 ms).
    { name: "42510070983 @ 390 no-op open 0.79x passes", width: 390, candidate: sample(21.5, 31.0), calibration: 27.2, ratios: paired(1.10, 1.14, 1, 1), fails: [] },
    { name: "settled no-op run passes", candidate: sample(noOp.openMs, noOp.appendMs), calibration: noOp.calibration, ratios: paired(1.00, 0.98, 0.97, 0.97), fails: [] },
    // Head-only regressions belong to the paired ratios, not to the calibrated ceiling.
    { name: "head-only regression fails the paired ratio only", candidate: sample(noOp.openMs, 60), calibration: noOp.calibration, ratios: paired(1, 1, 1.6, 1.6), fails: [/append ratio 1\.60x is over 1\.4x/, /append task ratio 1\.60x is over 1\.4x/] },
    // TIMING_GATE_SLOWDOWN_MS=25 adds 25 ms of candidate-only work to the open and to each append.
    { name: "+25 ms candidate-only work fails the paired ratios", candidate: sample(noOp.openMs + 25, noOp.appendMs + 25), calibration: noOp.calibration,
      ratios: paired((noOp.openMs + 25) / noOp.openMs, (noOp.openTaskMs + 25) / noOp.openTaskMs, (noOp.appendMs + 25) / noOp.appendMs, (noOp.appendTaskMs + 25) / noOp.appendTaskMs),
      fails: [/open task ratio 1\.72x/, /append ratio 1\.45x/, /open \(4x throttle\): calibrated ceiling/, /append \(4x throttle\): calibrated ceiling/] },
    // Common regressions: head and base are equally slow (paired 1.0x) on a normal runner. Only the calibrated ceiling sees them.
    { name: "common append regression of 1.5x fails the calibrated ceiling", candidate: sample(noOp.openMs, noOp.appendMs * 1.5), calibration: noOp.calibration, ratios: even, fails: [/append \(4x throttle\): calibrated ceiling, candidate 83\.7 ms \/ calibration 42\.9 ms = 1\.95x is over 1\.83x/] },
    // This runner's open ratio (0.62x) sits below the highest no-op open ratio (0.82x), so its open needs 2x to cross.
    { name: "common open regression of 2x fails the calibrated ceiling", candidate: sample(noOp.openMs * 2, noOp.appendMs), calibration: noOp.calibration, ratios: even, fails: [/open \(4x throttle\): calibrated ceiling, candidate 53\.6 ms \/ calibration 42\.9 ms = 1\.25x is over 1\.15x/] },
    // The +40 ms common proof (42509899837 @ 390): the lowest recorded open mutation for the 390 open limit.
    { name: "42509899837 @ 390 common +40 ms open 1.71x fails", width: 390, candidate: sample(71.5, 97.0), calibration: 41.7, ratios: paired(0.99, 1.00, 1.00, 1.02),
      fails: [/@ 390 open \(4x throttle\): calibrated ceiling, candidate 71\.5 ms \/ calibration 41\.7 ms = 1\.71x is over 1\.11x/, /@ 390 append \(4x throttle\): calibrated ceiling, candidate 97\.0 ms \/ calibration 41\.7 ms = 2\.33x is over 1\.89x/] },
    // A local run without a base has no paired ratios: only the calibrated ceiling judges it.
    { name: "a run without a base is judged by the calibrated ceiling only", candidate: sample(noOp.openMs, noOp.appendMs * 1.5), calibration: noOp.calibration, fails: [/append \(4x throttle\): calibrated ceiling/] },
  ];
  for (const { name, width = 1440, candidate, calibration, ratios, fails } of cases) {
    test(name, () => {
      const failures: string[] = [];
      recordViewerTimingFailures({ candidate, calibration: { median: calibration, samples: [calibration] }, pairedRatios: ratios }, width, failures);
      expect(failures).toHaveLength(fails.length);
      fails.forEach((pattern, index) => expect(failures[index]).toMatch(pattern));
    });
  }
});

describe("recordUnthrottledViewerFailures", () => {
  // 42492135444 a4 @ 390, unthrottled: single open 7.5 / append 5.9 ms over 8.8 ms; read open 7.4 / append 24.9 ms over 8.4 ms.
  const judge = (fixture: string, openMs: number, appendMs: number, calibration: number, width = 390) => {
    const failures: string[] = [];
    verdict.recordUnthrottledViewerFailures({ fixture, width, openMs, appendMs, calibration: { median: calibration, samples: [calibration] } }, failures);
    return failures;
  };
  test("no-op single and read pass, read append in the next frame included", () => {
    expect(judge("single", 7.5, 5.9, 8.8)).toEqual([]);
    expect(judge("read", 7.4, 24.9, 8.4)).toEqual([]);
  });
  test("the highest recorded no-op values pass", () => {
    expect(judge("single", 5.8, 3.2, 5.6)).toEqual([]); // 42509897759: open 1.04x on a fast runner (its slowdown touches only read)
    expect(judge("lines", 3.4, 5.4, 7.4)).toEqual([]); // 42507931601: append 0.73x
  });
  test("the lowest recorded mutations fail", () => {
    expect(judge("read", 31.6, 36.4, 8.4)).toEqual(["viewer read @ 390 open: calibrated ceiling, candidate 31.6 ms / calibration 8.4 ms = 3.76x is over 1.46x"]); // 42507931601, +25 ms
    expect(judge("lines", 4.0, 43.5, 10.1, 1440)).toEqual(["viewer lines @ 1440 append: calibrated ceiling, candidate 43.5 ms / calibration 10.1 ms = 4.31x is over 1.02x"]); // 42513755996, append CPU work
  });
  test("a 2x common regression fails on a mid runner", () => {
    expect(judge("single", 7.5, 5.9 * 2, 8.8)).toEqual(["viewer single @ 390 append: calibrated ceiling, candidate 11.8 ms / calibration 8.8 ms = 1.34x is over 1.02x"]);
    expect(judge("read", 7.4 * 2, 12.6, 8.4)).toEqual(["viewer read @ 390 open: calibrated ceiling, candidate 14.8 ms / calibration 8.4 ms = 1.76x is over 1.46x"]);
  });
});
