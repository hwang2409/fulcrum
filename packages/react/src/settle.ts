export type ScrollTarget = "end" | number;

export type HostSample = {
  top: number;
  end: number;
  clientHeight: number;
  rectTop: number;
  rectBottom: number;
  engineTop: number;
};

export type ScrollOwner = {
  target: ScrollTarget;
  readBack: HostSample;
};

export type Recovery = {
  basis: HostSample;
  target: number | null;
};

export type DeferredNumericWrite = {
  target: number;
  expectedHostTop: number;
  basis: HostSample;
};

export type SettleState = {
  owner: ScrollOwner | null;
  recovery: Recovery | null;
  pinned: boolean;
  settled: HostSample;
  historyPending: boolean;
  writeBlockedByTouch: boolean;
  deferred: DeferredNumericWrite | null;
};

type SampledKind = "scroll" | "viewport" | "rows" | "siblings" | "commit-layout";

export type SettleEvent =
  | { kind: SampledKind; sample: HostSample }
  | { kind: "commit-append"; sample: null }
  | { kind: "recovery-open"; sample: HostSample; target: number | null }
  | { kind: "recovery-complete"; sample: HostSample; target: ScrollTarget }
  | { kind: "owner-write"; target: ScrollTarget; before: HostSample; sample: HostSample }
  | { kind: "touch-start" }
  | { kind: "touch-end"; sample: HostSample }
  | { kind: "reset" };

export type SettleDecision = {
  report: "user" | "programmatic" | "observe" | null;
  write: ScrollTarget | null;
  recovery: "keep" | "complete" | "cancel";
  next: SettleState;
};

const band = 4;
const changed = (a: number, b: number) => Math.abs(a - b) >= 0.5;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));
const atEnd = (sample: HostSample) => Math.max(0, sample.end - sample.top) <= band;
const impliedClamp = (basis: HostSample, sample: HostSample) =>
  clamp(basis.top - (sample.rectBottom - basis.rectBottom), 0, sample.end);
const withinClamp = (basis: HostSample, sample: HostSample) =>
  Math.abs(sample.top - impliedClamp(basis, sample)) <= band;
const geometryChanged = (a: HostSample, b: HostSample) =>
  changed(a.end, b.end)
  || changed(a.clientHeight, b.clientHeight)
  || changed(a.rectTop, b.rectTop)
  || changed(a.rectBottom, b.rectBottom);

const result = (
  next: SettleState,
  report: SettleDecision["report"],
  write: ScrollTarget | null,
  recovery: SettleDecision["recovery"],
): SettleDecision => ({ report, write, recovery, next });

export function decideSettle(prev: SettleState, event: SettleEvent): SettleDecision {
  if (event.kind === "commit-append") {
    return result(prev, null, null, "keep");
  }

  if (event.kind === "reset") {
    return result({ ...prev, owner: null, recovery: null, deferred: null, writeBlockedByTouch: false }, null, null, "cancel");
  }

  if (event.kind === "touch-start") {
    return result({ ...prev, writeBlockedByTouch: true }, null, null, "keep");
  }

  if (event.kind === "owner-write") {
    const owner = changed(event.before.top, event.sample.top)
      ? { target: event.target, readBack: event.sample }
      : null;
    return result({
      ...prev,
      owner,
      pinned: atEnd(event.sample),
      settled: event.sample,
    }, "programmatic", null, "keep");
  }

  if (event.kind === "recovery-open") {
    return result({
      ...prev,
      recovery: { basis: event.sample, target: event.target },
      settled: event.sample,
    }, "observe", null, "keep");
  }

  if (event.kind === "recovery-complete") {
    const next = { ...prev, recovery: null };
    if (typeof event.target === "number" && prev.writeBlockedByTouch) {
      return result({
        ...next,
        deferred: {
          target: event.target,
          expectedHostTop: event.sample.top,
          basis: event.sample,
        },
      }, "observe", null, "complete");
    }
    return result({ ...next, deferred: null }, "observe", event.target, "complete");
  }

  if (event.kind === "touch-end") {
    const next = { ...prev, writeBlockedByTouch: false };
    if (prev.deferred === null) return result(next, null, null, "keep");
    if (withinClamp({ ...prev.deferred.basis, top: prev.deferred.expectedHostTop }, event.sample)) {
      return result({ ...next, deferred: null }, "observe", prev.deferred.target, "complete");
    }
    return result({
      ...next,
      owner: null,
      recovery: null,
      deferred: null,
      pinned: atEnd(event.sample),
      settled: event.sample,
    }, "user", null, "cancel");
  }

  const sample = event.sample;
  if (prev.recovery !== null) {
    if (withinClamp(prev.recovery.basis, sample)) {
      const write = prev.recovery.target !== null && changed(sample.engineTop, prev.recovery.target)
        ? prev.recovery.target
        : null;
      return result({ ...prev, owner: null }, "observe", write, "keep");
    }
    return result({
      ...prev,
      owner: null,
      recovery: null,
      deferred: null,
      pinned: atEnd(sample),
      settled: sample,
    }, "user", null, "cancel");
  }

  if (prev.deferred !== null && prev.writeBlockedByTouch) {
    return result(prev, "observe", null, "keep");
  }

  const basis = prev.owner?.readBack ?? prev.settled;
  const pinnedGeometry = prev.pinned && geometryChanged(prev.settled, sample);
  if (pinnedGeometry && sample.top > sample.end + band) {
    return result({ ...prev, owner: null }, "observe", "end", "keep");
  }
  if (prev.owner !== null || pinnedGeometry) {
    if (withinClamp(basis, sample)) {
      return result({
        ...prev,
        owner: null,
        pinned: prev.owner === null ? true : prev.pinned,
        settled: prev.pinned && atEnd(sample) ? sample : prev.settled,
      }, "observe", prev.pinned && Math.abs(sample.end - sample.top) >= 0.5 ? "end" : null, "keep");
    }
    return result({
      ...prev,
      owner: null,
      deferred: null,
      pinned: atEnd(sample),
      settled: sample,
    }, "user", null, "cancel");
  }

  return result({
    ...prev,
    owner: null,
    recovery: null,
    deferred: null,
    pinned: atEnd(sample),
    settled: sample,
  }, "user", null, "cancel");
}
