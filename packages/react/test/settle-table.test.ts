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
  lastObserved: basis,
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
  const expectedTop = Math.max(0, Math.min(basis.top - (sample.rectBottom - basis.rectBottom), sample.end));
  const readerMoved = Math.abs(sample.top - expectedTop) > (axes.owner === "open" ? 1 : 4);
  const atEnd = sample.end - sample.top <= 4;
  if (readerMoved) return { report: "user", recovery: "cancel", owner: null, pinned: atEnd, write: null };
  if (axes.recovery === "open") return { report: "observe", recovery: "keep", owner: null, pinned: axes.pinned, write: null };
  if (axes.pinned) return { report: "observe", recovery: "keep", owner: null, pinned: true, write: Math.abs(sample.end - sample.top) >= 0.5 ? "end" : null };
  return { report: "observe", recovery: "keep", owner: null, pinned: atEnd, write: null };
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
        recovery: axes.recovery === "open" ? { target: null } : null,
      });
      const decision = decideSettle(prev, { kind: axes.event, sample });
      const expected = expectedFor(axes, sample);
      expect(decision.next.lastObserved, `${Object.values(axes).join("/")}: observed sample`).toEqual(sample);
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
    const movedDecision = decideSettle(state(), { kind: "owner-write", target: "end", before: basis, sample: moved });
    expect(movedDecision.next.owner).toEqual({ target: "end", readBack: moved });
    expect(movedDecision.next.lastObserved).toEqual(moved);
    expect(decideSettle(state(), { kind: "owner-write", target: "end", before: basis, sample: basis }).next.owner).toBeNull();
  });

  test("an end write that has not landed keeps a pinned reader pinned", () => {
    const before = { ...basis, top: 0, end: 0, engineTop: 0 };
    const readBack = { ...before, end: 621.5 };
    const decision = decideSettle(state({ pinned: true, lastObserved: before }), {
      kind: "owner-write",
      target: "end",
      before,
      sample: readBack,
    });
    expect(decision.next.owner).toBeNull();
    expect(decision.next.pinned).toBeTrue();
    const retry = decideSettle(decision.next, { kind: "viewport", sample: readBack });
    expect(retry.report).toBe("observe");
    expect(retry.write).toBe("end");
  });

  test("an open reconnect survives its empty and first non-empty replay samples", () => {
    const reconnectBasis = { ...basis, top: 20_931, end: 42_017, clientHeight: 643, engineTop: 20_923 };
    const empty = { ...reconnectBasis, top: 0, end: 0, engineTop: 0 };
    const firstRows = { ...empty, end: 1_077 };
    const open = state({ pinned: false, lastObserved: reconnectBasis, recovery: { target: null } });
    const afterEmpty = decideSettle(open, { kind: "scroll", sample: empty });
    const afterRows = decideSettle(afterEmpty.next, { kind: "rows", sample: firstRows });
    expect(afterRows.report).toBe("observe");
    expect(afterRows.recovery).toBe("keep");
    expect(afterRows.next.recovery).not.toBeNull();
  });

  test("a detached numeric owner echo stays detached", () => {
    const readBack = { ...basis, top: 20931, end: 42017, engineTop: 20923 };
    const prev = state({ pinned: false, lastObserved: readBack, owner: { target: 20923, readBack } });
    const echo = decideSettle(prev, { kind: "scroll", sample: readBack });
    expect(echo.next.pinned).toBeFalse();
    expect(echo.next.owner).toBeNull();
    expect(decideSettle(echo.next, { kind: "commit-append", sample: null }).write).toBeNull();
  });

  test("a short page at its physical end keeps open recovery", () => {
    const short = { ...basis, top: 0, end: 0, engineTop: 0 };
    const decision = decideSettle(state({ recovery: { target: null } }), { kind: "scroll", sample: short });
    expect(decision.report).toBe("observe");
    expect(decision.recovery).toBe("keep");
    expect(decision.next.recovery).not.toBeNull();
  });

  test("the webkit reconnect run-2 clamp stays pinned against the last observed geometry", () => {
    const lastObserved = { ...basis, top: 43_348, end: 43_348, clientHeight: 643, rectBottom: 800, engineTop: 43_330 };
    const sample = { ...lastObserved, top: 43_307, clientHeight: 678, rectBottom: 843.6875, engineTop: 43_299 };
    const decision = decideSettle(state({ pinned: true, lastObserved }), { kind: "viewport", sample });
    expect(decision.report).toBe("observe");
    expect(decision.next.pinned).toBeTrue();
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
    const numeric = { target: 20923 };
    const openStates = [
      state({ owner: { target: "end", readBack: basis } }),
      state({ recovery: { target: null } }),
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
