import { describe, expect, test } from "bun:test";
import * as verdict from "./viewer-verdict"; // a namespace import, so the table also runs against older verdict modules
import type { ScalingCheck, ScalingSide, ViewerSample } from "./viewer-verdict";

const { recordViewerTimingFailures, median } = verdict;

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
  // The append ceiling guards +10 ms per append (about 2x); min hides regressions on only some appends; #127's
  // compare/copy counter owns the O(n)-per-append class; the A/B median catches regressions on most appends.
  // The object also carries the medians, so the table runs against the older median verdict too.
  const judge = (fixture: string, openMs: number, appendSamples: number[], calibrationSamples: number[], width = 390) => {
    const failures: string[] = [];
    verdict.recordUnthrottledViewerFailures({ fixture, width, openMs, appendSamples, appendMs: median(appendSamples), calibration: { median: median(calibrationSamples), samples: calibrationSamples } }, failures);
    return failures;
  };
  test("no-op single and read pass, read append in the next frame included", () => {
    // 42492135444 a4 @ 390: single open 7.5 / append 5.9 ms over 8.8 ms; read open 7.4 / append 24.9 ms over 8.4 ms.
    expect(judge("single", 7.5, [5.9], [8.8])).toEqual([]);
    expect(judge("read", 7.4, [24.9], [8.4])).toEqual([]);
  });
  test("the highest recorded no-op opens pass", () => {
    expect(judge("single", 5.8, [3.2], [5.6])).toEqual([]); // 42509897759: open 1.04x on a fast runner (its slowdown touches only read)
    expect(judge("single", 5.8, [3.3], [6.4], 1440)).toEqual([]); // 42509897759: open 0.91x @ 1440, the 1440 open maximum
  });
  // #118 (check 42531346403 a1): three appends in the page's 2x state made the median 1.25x and failed a no-op PR.
  test("the #118 slow-state replay passes", () => {
    expect(judge("lines", 3.9, [6.8, 6.5, 13.2, 13.0, 12.9], [10.1, 10.0, 10.3, 11.4, 11.6])).toEqual([]);
  });
  // The highest no-change sets of runs 42543048265 and 42543855004; 1.45x slower crosses the 1.4x budget.
  test("the highest no-change sample sets pass, and 1.45x of them fails", () => {
    const highest = [{ width: 390, append: [6.2, 5.2, 5.7, 5.3, 5.3], calibration: [8.2, 8.1, 7.9, 8.2, 10.2] }, { width: 1440, append: [6.6, 5.5, 5.5, 5.4, 5.1], calibration: [8.6, 8.0, 8.4, 10.0, 10.0] }];
    for (const { width, append, calibration } of highest) {
      expect(judge("single", 5, append, calibration, width)).toEqual([]);
      expect(judge("single", 5, append.map((ms) => ms * 1.45), calibration, width)).toHaveLength(1);
    }
  });
  test("the lowest +10 ms per append sample sets fail", () => {
    expect(judge("single", 5, [17.4, 16.3, 16.2, 16.2, 16.1], [10.9, 10.6, 10.5, 10.6, 13.1])).toEqual(["viewer single @ 390 append: calibrated ceiling, fastest append 16.100 ms / fastest calibration 10.500 ms = 1.533x is over 0.921x"]); // 42543048265
    expect(judge("lines", 4, [16.8, 15.5, 15.6, 16.1, 16.0], [17.9, 18.6, 19.4, 12.2, 11.9], 1440)).toEqual(["viewer lines @ 1440 append: calibrated ceiling, fastest append 15.500 ms / fastest calibration 11.900 ms = 1.303x is over 0.893x"]); // 42543048265
  });
  test("the lowest recorded open mutations and an append CPU proof fail", () => {
    expect(judge("read", 31.6, [36.4], [8.4])).toEqual(["viewer read @ 390 open: calibrated ceiling, candidate 31.6 ms / calibration 8.4 ms = 3.76x is over 1.46x"]); // 42507931601, +25 ms
    expect(judge("read", 32.0, [36.7], [8.5], 1440)).toEqual(["viewer read @ 1440 open: calibrated ceiling, candidate 32.0 ms / calibration 8.5 ms = 3.76x is over 1.27x"]); // 42507931601, +25 ms
    expect(judge("lines", 4.0, [43.5], [10.1], 1440)).toEqual(["viewer lines @ 1440 append: calibrated ceiling, fastest append 43.500 ms / fastest calibration 10.100 ms = 4.307x is over 0.893x"]); // 42513755996, append CPU work
  });
  test("a 2x common open regression fails on a mid runner", () => {
    expect(judge("read", 7.4 * 2, [12.6], [8.4])).toEqual(["viewer read @ 390 open: calibrated ceiling, candidate 14.8 ms / calibration 8.4 ms = 1.76x is over 1.46x"]);
  });
});

describe("recordViewerScalingFailures", () => {
  // Push counts per append are illustrative no-op values; the task times are real CI pairs.
  const side = (appendTaskMs: number, segmentPushes = 42, appendPushes = 50): ScalingSide => ({ appendTaskMs, appendPushes, segmentPushes });
  const pairs = (small: number[], large: number[]) => small.map((ms, index) => ({ small: side(ms), large: side(large[index]!) }));
  // Optional call: on a verdict module without the paired probe, every row still reaches its behavior assertion.
  const judge = (check: ScalingCheck) => {
    const failures: string[] = [];
    const summary = verdict.recordViewerScalingFailures?.(check, failures);
    return { failures, taskRatio: summary?.taskRatio.toFixed(3) };
  };
  // The highest no-op median (42537804733, probe 5, AMD EPYC 7763): 21 pairs, one 180 ms outlier the median ignores.
  const highestNoOp = pairs(
    [38.66, 42.75, 39.97, 65.02, 39.91, 30.95, 32.10, 70.18, 39.71, 43.18, 45.96, 32.02, 40.37, 44.44, 37.03, 36.48, 50.52, 54.08, 39.00, 52.19, 38.90],
    [39.89, 50.16, 38.96, 44.09, 37.90, 35.65, 33.45, 38.75, 39.34, 43.42, 34.04, 41.95, 35.11, 38.06, 43.98, 44.41, 35.02, 29.49, 44.03, 43.05, 180.04]);
  // The lowest contract-size O(n) mutation (42536755137, probe 5, AMD EPYC 9V74): 55 ms per append at 128k lines.
  const lowestMutation = pairs(
    [55.91, 47.29, 47.10, 65.11, 59.45, 48.89, 48.52, 51.46, 50.99, 50.59, 60.19, 55.11, 51.19, 65.98, 45.11, 81.12, 49.35, 52.60, 49.55, 75.43, 52.87],
    [101.94, 108.50, 97.61, 115.73, 89.98, 102.83, 98.55, 96.14, 97.12, 108.20, 96.29, 221.27, 92.72, 98.05, 101.51, 115.81, 97.28, 101.59, 98.37, 101.47, 93.72]);

  test("the highest no-op pair set passes", () => {
    expect(judge({ pairs: highestNoOp, mountedRows: 1 })).toEqual({ failures: [], taskRatio: "0.991" });
  });
  test("the lowest O(n) mutation fails with its ratio, budget, and pairs", () => {
    const { failures, taskRatio } = judge({ pairs: lowestMutation, mountedRows: 1 });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toStartWith("viewer append scaling: median paired 128k/16k task ratio 1.905x is over 1.387x (pairs 1.823, 2.294, ");
    expect(taskRatio).toBe("1.905");
  });
  test("the budget itself passes and 0.001 over it fails", () => {
    expect(judge({ pairs: pairs([1], [1.387]), mountedRows: 1 }).failures).toEqual([]);
    expect(judge({ pairs: pairs([1], [1.388]), mountedRows: 1 }).failures).toEqual(["viewer append scaling: median paired 128k/16k task ratio 1.388x is over 1.387x (pairs 1.388)"]);
  });
  test("the canaries and the mounted-row limit keep their meaning", () => {
    const even = [40, 40, 40];
    const canaries = (large: ScalingSide) => judge({ pairs: even.map((ms) => ({ small: side(ms), large })), mountedRows: 201 }).failures;
    expect(canaries(side(40, 60, 91))).toEqual([
      "viewer append scaling: canary 128k/16k segment-push ratio 1.419x is over 1.400x",
      "viewer append scaling: canary 128k/16k all-push ratio 1.820x is over 1.800x",
      "viewer append scaling: 1m mounted rows 201 is over 200",
    ]);
    expect(judge({ pairs: pairs(even, even), mountedRows: 200 })).toEqual({ failures: [], taskRatio: "1.000" });
  });
});
