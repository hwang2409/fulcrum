import type { RunEvent, RunItem } from "./events.js";
import {
  initialState,
  reduceAllWithEntities,
  type OutlineItem,
  type RunState,
} from "./reducer.js";

export type Scheduler = (callback: () => void) => void;
type Listener = () => void;

const defaultScheduler: Scheduler = (callback) =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback)
    : queueMicrotask(callback);

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
    outlineChanged ||= current.outline !== beforeOutline;
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
      entities = new Map();
      listeners.forEach((listener) => listener());
      outlineListeners.forEach((listener) => listener());
      itemListeners.forEach((keyedListeners) =>
        keyedListeners.forEach((listener) => listener()),
      );
      listeners.clear();
      outlineListeners.clear();
      itemListeners.clear();
      changedItems.clear();
      stateChanged = false;
      outlineChanged = false;
    },
  };
}
