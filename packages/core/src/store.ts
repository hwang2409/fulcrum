import type { RunEvent, RunItem } from "./events.js";
import {
  initialState,
  reduceAllWithEntities,
  type OutlineItem,
  type RunState,
} from "./reducer.js";

export type Scheduler = (callback: () => void) => void;
type Listener = () => void;
type Cell = { version: number; item?: RunItem; previous?: Cell };

const defaultScheduler: Scheduler = (callback) =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback)
    : queueMicrotask(callback);

function snapshot(
  state: RunState,
  version: number,
  cells: Map<string, Cell>,
): RunState {
  let materialized: Record<string, RunItem> | undefined;
  Object.defineProperty(state, "itemsById", {
    enumerable: true,
    get() {
      if (materialized) return materialized;
      materialized = {};
      for (const { id } of state.outline) {
        let cell = cells.get(id);
        while (cell && cell.version > version) cell = cell.previous;
        if (cell?.item) materialized[id] = cell.item;
      }
      return materialized;
    },
  });
  return state;
}

export function createRunStore(
  state: RunState = initialState,
  scheduler: Scheduler = defaultScheduler,
) {
  let entities = new Map(Object.entries(state.itemsById));
  let cells = new Map<string, Cell>();
  for (const [id, item] of entities) cells.set(id, { version: 0, item });
  let current = snapshot(
    {
      ...state,
      outline:
        state.outline ??
        state.items.map((id) => ({ id, kind: state.itemsById[id].type })),
    },
    0,
    cells,
  );
  let version = 0;
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
    const changed = new Set<string>();
    const beforeOutline = current.outline;
    const next = reduceAllWithEntities(current, events, {
      get: (id) => entities.get(id),
      set: (item) => {
        entities.set(item.id, item);
        changed.add(item.id);
      },
      delete: (id) => {
        entities.delete(id);
        changed.add(id);
      },
    });
    version += 1;
    for (const id of changed) {
      cells.set(id, {
        version,
        item: entities.get(id),
        previous: cells.get(id),
      });
    }
    current = snapshot(next, version, cells);
    stateChanged = true;
    outlineChanged ||= next.outline !== beforeOutline;
    for (const id of changed) changedItems.add(id);
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
      if (
        typeof idOrListener === "string" &&
        set.size === 0
      )
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
      listeners.clear();
      outlineListeners.clear();
      itemListeners.clear();
      changedItems.clear();
      stateChanged = false;
      outlineChanged = false;
      entities.clear();
      entities = new Map();
      cells = new Map();
      current = snapshot(structuredClone(initialState), 0, cells);
    },
  };
}
