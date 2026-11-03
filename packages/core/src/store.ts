import type { RunEvent, RunItem } from "./events.js";
import {
  initialState,
  reduceAllWithEntities,
  type OutlineItem,
  type RunState,
} from "./reducer.js";

export type Scheduler = (callback: () => void) => void;
type Listener = () => void;
export type OutlineChange = { readonly type: "append" | "prepend"; readonly count: number };
export type OutlineSnapshot = { readonly items: readonly OutlineItem[]; readonly change: OutlineChange | null };

const defaultScheduler: Scheduler = (callback) =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback)
    : queueMicrotask(callback);

// An append keeps every old entry in place (the reducer reuses entry objects); a delete, a reset, or a fold that moves
// a row is a rewrite, which views must take as a full change.
const isAppend = (before: readonly OutlineItem[], after: readonly OutlineItem[]) => {
  if (after.length < before.length) return false;
  for (let index = 0; index < before.length; index++) if (before[index] !== after[index]) return false;
  return true;
};

export function createRunStore(scheduler: Scheduler = defaultScheduler) {
  let entities = new Map<string, RunItem>();
  let current: RunState = structuredClone(initialState);
  let pending: RunEvent[] = [];
  const listeners = new Set<Listener>();
  const outlineListeners = new Set<Listener>();
  const itemListeners = new Map<string, Set<Listener>>();
  let queued = false;
  let disposed = false;
  let stateChanged = false;
  let outlineChanged = false;
  let outlineSnapshot: OutlineSnapshot = { items: current.outline, change: null };
  const changedItems = new Set<string>();

  const flush = () => {
    if (pending.length === 0 || disposed) return false;
    const events = pending;
    pending = [];
    const beforeOutline = current.outline;
    current = reduceAllWithEntities(current, events, {
      get: (id) => entities.get(id),
      set: (item) => {
        entities.set(item.id, item);
        changedItems.add(item.id);
      },
      delete: (id) => {
        entities.delete(id);
        changedItems.add(id);
      },
    });
    stateChanged = true;
    if (current.outline !== beforeOutline) {
      const appended = isAppend(beforeOutline, current.outline);
      const priorChange = outlineChanged ? outlineSnapshot.change : { type: "append" as const, count: 0 };
      outlineSnapshot = {
        items: current.outline,
        change: appended && priorChange?.type === "append"
          ? { type: "append", count: priorChange.count + current.outline.length - beforeOutline.length }
          : null,
      };
      outlineChanged = true;
    }
    return true;
  };
  const notify = () => {
    if (!stateChanged) return;
    stateChanged = false;
    listeners.forEach((listener) => listener());
    if (outlineChanged) outlineListeners.forEach((listener) => listener());
    outlineChanged = false;
    for (const id of changedItems)
      itemListeners.get(id)?.forEach((listener) => listener());
    changedItems.clear();
  };

  function subscribe(listener: Listener): () => void;
  function subscribe(id: string, listener: Listener): () => void;
  function subscribe(idOrListener: string | Listener, keyed?: Listener) {
    const set =
      typeof idOrListener === "string"
        ? (itemListeners.get(idOrListener) ??
          itemListeners.set(idOrListener, new Set()).get(idOrListener)!)
        : listeners;
    const listener = typeof idOrListener === "string" ? keyed! : idOrListener;
    set.add(listener);
    return () => {
      set.delete(listener);
      if (typeof idOrListener === "string" && set.size === 0)
        itemListeners.delete(idOrListener);
    };
  }

  return {
    getState() {
      flush();
      return current;
    },
    getItem(id: string) {
      flush();
      return entities.get(id);
    },
    getOutline(): readonly OutlineItem[] {
      flush();
      return current.outline;
    },
    getOutlineSnapshot(): OutlineSnapshot {
      flush();
      return outlineSnapshot;
    },
    subscribe,
    subscribeOutline(listener: Listener) {
      outlineListeners.add(listener);
      return () => outlineListeners.delete(listener);
    },
    dispatch(event: RunEvent) {
      if (disposed) throw new Error("store is disposed");
      pending.push(event);
      if (!queued) {
        queued = true;
        scheduler(() => {
          queued = false;
          flush();
          notify();
        });
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pending = [];
      current = structuredClone(initialState);
      outlineSnapshot = { items: current.outline, change: null };
      entities = new Map();
      listeners.clear();
      outlineListeners.clear();
      itemListeners.clear();
      changedItems.clear();
      stateChanged = false;
      outlineChanged = false;
    },
  };
}
