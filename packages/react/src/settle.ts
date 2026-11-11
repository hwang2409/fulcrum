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
  target: number | null;
};

export type DeferredNumericWrite = {
  target: number;
};

export type SettleState = {
  owner: ScrollOwner | null;
  recovery: Recovery | null;
  pinned: boolean;
  lastObserved: HostSample;
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
  | { kind: "follow" }
  | { kind: "detach" }
  | { kind: "reset" };

export type SettleDecision = {
  report: "user" | "programmatic" | "observe" | null;
  write: ScrollTarget | null;
  recovery: "keep" | "complete" | "cancel";
  next: SettleState;
};

const band = 4;
const collisionBand = 1;
const changed = (a: number, b: number) => Math.abs(a - b) >= 0.5;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));
const atEnd = (sample: HostSample) => Math.max(0, sample.end - sample.top) <= band;
const impliedTop = (lastObserved: HostSample, sample: HostSample) =>
  clamp(lastObserved.top - (sample.rectBottom - lastObserved.rectBottom), 0, sample.end);

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

  if (event.kind === "follow") {
    return result({ ...prev, owner: null, pinned: true }, null, null, "keep");
  }

  if (event.kind === "detach") {
    return result({ ...prev, owner: null, recovery: null, pinned: false }, "programmatic", null, "cancel");
  }

  if (event.kind === "owner-write") {
    const owner = changed(event.before.top, event.sample.top)
      ? { target: event.target, readBack: event.sample }
      : null;
    return result({
      ...prev,
      owner,
      pinned: prev.pinned,
      lastObserved: event.sample,
    }, "programmatic", null, "keep");
  }

  if (event.kind === "recovery-open") {
    return result({
      ...prev,
      recovery: { target: event.target },
      lastObserved: event.sample,
    }, "observe", null, "keep");
  }

  if (event.kind === "recovery-complete") {
    const next = { ...prev, recovery: null, lastObserved: event.sample };
    if (typeof event.target === "number" && prev.writeBlockedByTouch) {
      return result({
        ...next,
        deferred: { target: event.target },
      }, "observe", null, "complete");
    }
    return result({ ...next, deferred: null }, "observe", event.target, "complete");
  }

  if (event.kind === "touch-end") {
    const next = { ...prev, writeBlockedByTouch: false, lastObserved: event.sample };
    if (prev.deferred === null) return result(next, null, null, "keep");
    const expected = impliedTop(prev.lastObserved, event.sample);
    if (Math.abs(event.sample.top - expected) <= collisionBand) {
      return result({ ...next, deferred: null }, "observe", prev.deferred.target, "complete");
    }
    return result({
      ...next,
      owner: null,
      recovery: null,
      deferred: null,
      pinned: atEnd(event.sample),
    }, "user", null, "cancel");
  }

  const sample = event.sample;
  const expected = impliedTop(prev.owner?.readBack ?? prev.lastObserved, sample);
  const readerMoved = prev.pinned
    ? sample.top < expected - band
    : Math.abs(sample.top - expected) > (prev.owner !== null ? collisionBand : band);
  const observed = { ...prev, lastObserved: sample };

  if (prev.deferred !== null && prev.writeBlockedByTouch) {
    return result(observed, "observe", null, "keep");
  }

  if (readerMoved) {
    return result({
      ...observed,
      owner: null,
      recovery: null,
      deferred: null,
      pinned: atEnd(sample),
    }, "user", null, "cancel");
  }

  if (prev.recovery !== null) {
    const write = prev.recovery.target !== null && changed(sample.engineTop, prev.recovery.target)
      ? prev.recovery.target
      : null;
    return result({ ...observed, owner: null }, "observe", write, "keep");
  }

  if (prev.pinned) {
    return result({ ...observed, owner: null, pinned: true }, "observe", changed(sample.top, sample.end) ? "end" : null, "keep");
  }

  return result({ ...observed, owner: null, pinned: atEnd(sample) }, "observe", null, "keep");
}
