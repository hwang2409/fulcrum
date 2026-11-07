import { useCallback } from "react";
import { useRun, useRunStore } from "./hooks.js";

export type RunStatusValue = "idle" | "running" | "approval" | "unknown";

/** The run's status: a run blocked on an approval waits for the user; an ended run whose end was not seen is `unknown`. */
export function useRunStatus(): RunStatusValue {
  const store = useRunStore();
  return useRun(useCallback((state: ReturnType<typeof store.getState>) => {
    if (state.agent !== "running") return state.endOutcome === "unknown" ? "unknown" : "idle";
    const waiting = Object.values(state.toolApprovals).some((id) => {
      const item = store.getItem(id);
      return item?.type === "approval" && !item.ended;
    });
    return waiting ? "approval" : "running";
  }, [store]));
}

/** A compact run header status derived from generic run state. */
export function RunStatus({ className }: { className?: string }) {
  const status = useRunStatus();
  const text = status === "approval" ? "waiting for approval" : status === "unknown" ? "outcome unknown" : status;
  return <span className={className} data-part="run-status" data-status={status}>{text}</span>;
}

/** A compact transcript terminator shown only when transport loss made the run outcome unknowable. */
export function RunEndMarker({ className }: { className?: string }) {
  const unknown = useRun((state) => state.endOutcome === "unknown");
  return unknown ? (
    <div className={className} data-part="run-end-marker" data-outcome="unknown" role="status" aria-label="run ended while disconnected; outcome unknown">
      <span aria-hidden="true">? outcome unknown</span>
    </div>
  ) : null;
}
