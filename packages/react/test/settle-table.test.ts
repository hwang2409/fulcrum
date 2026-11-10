import { describe, expect, test } from "bun:test";
import {
  decideSettle,
  type HostSample,
  type SettleEvent,
  type SettleState,
} from "../src/settle.js";

const owners = ["closed", "open"] as const;
const recoveries = ["closed", "open"] as const;
const pinnedStates = [false, true] as const;
const sampledEvents = ["scroll", "viewport", "rows", "siblings", "commit-layout"] as const;
const geometries = ["none", "client-height", "host-top", "host-bottom", "top-and-bottom", "content-end", "sibling-resize"] as const;
const readerPositions = ["at-clamp", "clamp-plus-4", "clamp-plus-4.01", "physical-end"] as const;

type Axes = {
  owner: (typeof owners)[number];
  recovery: (typeof recoveries)[number];
  pinned: boolean;
  event: (typeof sampledEvents)[number];
  geometry: (typeof geometries)[number];
  reader: (typeof readerPositions)[number];
};

const basis: HostSample = { top: 100, end: 300, clientHeight: 600, rectTop: 0, rectBottom: 600, engineTop: 92 };
const state = (overrides: Partial<SettleState> = {}): SettleState => ({
  owner: null,
  recovery: null,
  pinned: false,
  settled: basis,
  historyPending: false,
  writeBlockedByTouch: false,
  deferred: null,
  ...overrides,
});

const sampleFor = ({ geometry, reader }: Axes): HostSample => {
  const sample = { ...basis };
  if (geometry === "client-height") sample.clientHeight += 41;
  if (geometry === "host-top") sample.rectTop += 20;
  if (geometry === "host-bottom") sample.rectBottom += 20;
  if (geometry === "top-and-bottom") { sample.rectTop += 41; sample.rectBottom += 41; }
  if (geometry === "content-end" || geometry === "sibling-resize") sample.end += 80;
  const clamp = Math.max(0, Math.min(basis.top - (sample.rectBottom - basis.rectBottom), sample.end));
  sample.top = reader === "at-clamp" ? clamp
    : reader === "clamp-plus-4" ? clamp + 4
      : reader === "clamp-plus-4.01" ? clamp + 4.01
        : sample.end;
  sample.engineTop = sample.top - 8;
  return sample;
};

const expectedFor = (axes: Axes, sample: HostSample) => {
  const expectedClamp = Math.max(0, Math.min(basis.top - (sample.rectBottom - basis.rectBottom), sample.end));
  const within = Math.abs(sample.top - expectedClamp) <= 4;
  const atEnd = sample.end - sample.top <= 4;
  if (axes.recovery === "open") return within
    ? { report: "observe", recovery: "keep", owner: null, pinned: axes.pinned }
    : { report: "user", recovery: "cancel", owner: null, pinned: atEnd };
  if (axes.owner === "open" || (axes.pinned && axes.geometry !== "none")) return within
    ? { report: "observe", recovery: "keep", owner: null, pinned: axes.owner === "open" ? axes.pinned : true, write: axes.pinned && Math.abs(sample.end - sample.top) >= 0.5 ? "end" : null }
    : { report: "user", recovery: "cancel", owner: null, pinned: atEnd, write: null };
  return { report: "user", recovery: "cancel", owner: null, pinned: atEnd, write: null };
};

describe("decideSettle", () => {
  test("classifies the generated settle product through one rule table", () => {
    const cases = owners.flatMap((owner) => recoveries.flatMap((recovery) => pinnedStates.flatMap((pinned) =>
      sampledEvents.flatMap((event) => geometries.flatMap((geometry) => readerPositions.map((reader) =>
        ({ owner, recovery, pinned, event, geometry, reader })))))));
    expect(cases).toHaveLength(1120);
    expect(new Set(cases.map((row) => Object.values(row).join("/"))).size).toBe(1120);

    for (const axes of cases) {
      const sample = sampleFor(axes);
      const prev = state({
        pinned: axes.pinned,
        owner: axes.owner === "open" ? { target: 20923, readBack: basis } : null,
        recovery: axes.recovery === "open" ? { basis, target: null } : null,
      });
      const decision = decideSettle(prev, { kind: axes.event, sample });
      const expected = expectedFor(axes, sample);
      expect({
        report: decision.report,
        write: decision.write,
        recovery: decision.recovery,
        owner: decision.next.owner,
        pinned: decision.next.pinned,
      }, Object.values(axes).join("/")).toEqual({ write: null, ...expected });
    }
  });

  test("keeps a detached pure append free of sampling and writes", () => {
    const prev = state();
    expect(decideSettle(prev, { kind: "commit-append", sample: null })).toEqual({
      report: null,
      write: null,
      recovery: "keep",
      next: prev,
    });
  });

  test("an owner exists only when its write moved the host", () => {
    const moved = { ...basis, top: 120, engineTop: 112 };
    expect(decideSettle(state(), { kind: "owner-write", target: "end", before: basis, sample: moved }).next.owner).toEqual({ target: "end", readBack: moved });
    expect(decideSettle(state(), { kind: "owner-write", target: "end", before: basis, sample: basis }).next.owner).toBeNull();
  });

  test("a detached numeric owner echo stays detached", () => {
    const readBack = { ...basis, top: 20931, end: 42017, engineTop: 20923 };
    const prev = state({ pinned: false, settled: readBack, owner: { target: 20923, readBack } });
    const echo = decideSettle(prev, { kind: "scroll", sample: readBack });
    expect(echo.next.pinned).toBeFalse();
    expect(echo.next.owner).toBeNull();
    expect(decideSettle(echo.next, { kind: "commit-append", sample: null }).write).toBeNull();
  });

  test("a short page at its physical end keeps open recovery", () => {
    const short = { ...basis, top: 0, end: 0, engineTop: 0 };
    const decision = decideSettle(state({ recovery: { basis, target: null } }), { kind: "scroll", sample: short });
    expect(decision.report).toBe("observe");
    expect(decision.recovery).toBe("keep");
    expect(decision.next.recovery).not.toBeNull();
  });

  test("the exact WebKit 41 px clamp stays in the open transaction", () => {
    const now = { ...basis, top: 59, rectTop: 41, rectBottom: 641, engineTop: 51 };
    const decision = decideSettle(state({ pinned: true, owner: { target: "end", readBack: basis } }), { kind: "viewport", sample: now });
    expect(decision.report).toBe("observe");
    expect(decision.write).toBe("end");
  });

  test("a deferred numeric correction applies, cancels, and resets", () => {
    const complete = decideSettle(state({ writeBlockedByTouch: true }), { kind: "recovery-complete", sample: basis, target: 92 });
    expect(complete.write).toBeNull();
    expect(complete.next.deferred?.target).toBe(92);
    expect(decideSettle(complete.next, { kind: "touch-end", sample: basis }).write).toBe(92);
    const moved = { ...basis, top: 120, engineTop: 112 };
    const canceled = decideSettle(complete.next, { kind: "touch-end", sample: moved });
    expect(canceled.report).toBe("user");
    expect(canceled.next.deferred).toBeNull();
    expect(decideSettle(complete.next, { kind: "reset" }).next.deferred).toBeNull();
  });

  test("every open state has a callback-independent terminal transition", () => {
    const numeric = { target: 20923, expectedHostTop: 20931, basis: { ...basis, top: 20931, end: 42017 } };
    const openStates = [
      state({ owner: { target: "end", readBack: basis } }),
      state({ recovery: { basis, target: null } }),
      state({ deferred: numeric, writeBlockedByTouch: true }),
    ];
    const terminalEvents: SettleEvent[] = [
      { kind: "reset" },
      { kind: "recovery-complete", sample: basis, target: 100 },
      { kind: "touch-end", sample: { ...basis, top: 300, engineTop: 292 } },
    ];
    for (const [index, open] of openStates.entries()) {
      const next = decideSettle(open, terminalEvents[index]!).next;
      expect(next.owner, `owner ${index}`).toBeNull();
      expect(next.recovery, `recovery ${index}`).toBeNull();
      expect(next.deferred, `deferred ${index}`).toBeNull();
    }
  });
});
