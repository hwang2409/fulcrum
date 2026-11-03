import type { createRunStore } from "./store.js";

/** A child run the viewer holds open. `release` is idempotent; after it, the source may dispose the store. */
export interface RunLease {
  readonly store: ReturnType<typeof createRunStore>;
  release(): void;
}

export interface RunOpenOptions {
  /**
   * Aborts when the viewer no longer wants this open: the user moved on, or the view unmounted. Stop pending work and
   * reject. A lease that still arrives after the abort is released at once, and a rejection after it is never shown.
   */
  readonly signal: AbortSignal;
}

/**
 * What an app supplies so a sub-agent row can open its child run. Run ids are opaque: a harness adapter maps them to
 * its own sessions, history, and live streams, and returns the same store while a run is held.
 */
export interface RunSource {
  open(runId: string, options: RunOpenOptions): RunLease | Promise<RunLease>;
  /** Why the run cannot open, shown on its row, or undefined when it can. Must not acquire a store. */
  unavailable?(runId: string): string | undefined;
}
