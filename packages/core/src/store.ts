import type { RunEvent } from "./events.js";
import { initialState, reduceAll, type RunState } from "./reducer.js";

export type Scheduler = (callback: () => void) => void;
const defaultScheduler: Scheduler = (callback) =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback)
    : queueMicrotask(callback);

export function createRunStore(
  state: RunState = initialState,
  scheduler: Scheduler = defaultScheduler,
) {
  let current = state;
  let pending: RunEvent[] = [];
  const listeners = new Set<() => void>();
  let queued = false;
  const flush = () => {
    if (pending.length === 0) return;
    current = reduceAll(current, pending);
    pending = [];
  };

  return {
    getState() {
      flush();
      return current;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch(event: RunEvent) {
      pending.push(event);
      if (!queued) {
        queued = true;
        scheduler(() => {
          queued = false;
          flush();
          listeners.forEach((listener) => listener());
        });
      }
    },
  };
}
