import { initialState, reduce, type RunState } from "./reducer.js";
import type { RunEvent } from "./events.js";
export type Scheduler = (callback: () => void) => void;
const defaultScheduler: Scheduler = callback => typeof requestAnimationFrame === "function" ? requestAnimationFrame(callback) : queueMicrotask(callback);
export function createRunStore(state: RunState = initialState, scheduler: Scheduler = defaultScheduler) { let current = state; const listeners = new Set<() => void>(); let queued = false; return { getState: () => current, subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); }, dispatch(event: RunEvent) { current = reduce(current, event); if (!queued) { queued = true; scheduler(() => { queued = false; listeners.forEach(listener => listener()); }); } return current; } }; }
