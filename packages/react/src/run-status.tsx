import type { RunEndOutcome } from "@fulcrum/core";
import { useCallback, useSyncExternalStore } from "react";
import { useRun, useRunStore } from "./hooks.js";

export type RunStatusValue = "idle" | "running" | "approval" | "unknown";

/** The run's status: a run blocked on an approval waits for the user; an ended run whose end was not seen is `unknown`. */
export function useRunStatus(): RunStatusValue {
  const store = useRunStore();
  const [agent, endOutcome, toolApprovals] = useRun(
    useCallback((state: ReturnType<typeof store.getState>) => [state.agent, state.endOutcome, state.toolApprovals] as const, []),
    (left, right) => left[0] === right[0] && left[1] === right[1] && left[2] === right[2],
  );
  // getSnapshot runs only when this hook renders or an approval item notifies, so the scan stays off the global publication path.
  const waiting = useSyncExternalStore(
    useCallback((listener) => {
      const unsubscribe = Object.values(toolApprovals).map((id) => store.subscribe(id, listener));
      return () => unsubscribe.forEach((remove) => remove());
    }, [store, toolApprovals]),
    () => Object.values(toolApprovals).some((id) => {
      const item = store.getItem(id);
      return item?.type === "approval" && !item.ended;
    }),
  );
  if (agent !== "running") return endOutcome === "unknown" ? "unknown" : "idle";
  return waiting ? "approval" : "running";
}

/** A compact run header status derived from generic run state. */
export function RunStatus({ className }: { className?: string }) {
  const status = useRunStatus();
  const text = status === "approval" ? "waiting for approval" : status === "unknown" ? "outcome unknown" : status;
  return <span className={className} data-part="run-status" data-status={status}>{text}</span>;
}

const endText: Record<RunEndOutcome, string> = {
  completed: "run completed",
  cancelled: "run stopped",
  failed: "run failed",
  disconnected: "run stopped: client disconnected",
  unknown: "? outcome unknown",
};

/**
 * A compact marker for how the run ended, shown only when the host reported an outcome (`run_end.outcome`) and until
 * the next run starts. An unknown outcome has its own screen-reader text, without the "?".
 */
export function RunEndMarker({ className }: { className?: string }) {
  const outcome = useRun((state) => state.endOutcome);
  if (!outcome) return null;
  return (
    <div className={className} data-part="run-end-marker" data-outcome={outcome} role="status" aria-label={outcome === "unknown" ? "run ended while disconnected; outcome unknown" : undefined}>
      {outcome === "unknown" ? <span aria-hidden="true">{endText.unknown}</span> : endText[outcome]}
    </div>
  );
}
