import type { createRunStore } from "./store.js";

/** A child run the viewer holds open. `release` is idempotent; after it, the source may dispose the store. */
export interface RunLease {
  readonly store: ReturnType<typeof createRunStore>;
  release(): void;
}

/**
 * What an app supplies so a sub-agent row can open its child run. Run ids are opaque: a harness adapter maps them to
 * its own sessions, history, and live streams, and returns the same store while a run is held.
 */
export interface RunSource {
  open(runId: string): RunLease | Promise<RunLease>;
  /** Why the run cannot open, shown on its row, or undefined when it can. Must not acquire a store. */
  unavailable?(runId: string): string | undefined;
}
