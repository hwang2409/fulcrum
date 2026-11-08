import type { RunSource } from "@fulcrum/core";
import type { createRunStore } from "@fulcrum/core";

export type DemoSourceFailure = { runId: string; error: string };
type Store = ReturnType<typeof createRunStore>;

export const sourceFor = (runs: Record<string, Store>, failure?: DemoSourceFailure): RunSource => ({
  open: (runId) => {
    if (failure?.runId === runId) throw new Error(failure.error);
    return { store: runs[runId]!, release() {} };
  },
  unavailable: (runId) => failure?.runId === runId ? undefined : runs[runId] ? undefined : "started before child runs were recorded",
});
