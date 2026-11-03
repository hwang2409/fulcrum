import type { RunEvent, RunItem } from "./events.js";
import {
  initialState,
  createEntityDraft,
  reduceAllWithEntities,
  type OutlineItem,
  type OutlineSplice,
  type RunState,
} from "./reducer.js";

export type Scheduler = (callback: () => void) => void;
type Listener = () => void;
export type { OutlineSplice };
/**
 * How `items` came from `from`: apply `splices` to `from` in order. A view that holds exactly `from` applies them and
 * keeps every other row; any other view (it missed a snapshot) takes `items` whole.
 */
export type OutlineChange = { readonly from: readonly OutlineItem[]; readonly splices: readonly OutlineSplice[] };
/** `change` is null when there is nothing to edit from: the first snapshot and after `dispose`. */
export type OutlineSnapshot = { readonly items: readonly OutlineItem[]; readonly change: OutlineChange | null };

const defaultScheduler: Scheduler = (callback) =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback)
    : queueMicrotask(callback);

type OpenSplice = { index: number; deleteCount: number; items: OutlineItem[] };
// Adds `edits` after `base` without changing base's splices (a published snapshot holds them): inserts that continue
// the last insert join it, and a delete of rows the last splice inserted takes them back out (a row appended and
// folded in one frame is no edit at all).
const mergeSplices = (base: readonly OutlineSplice[], edits: readonly OutlineSplice[]): readonly OutlineSplice[] => {
  const merged: OutlineSplice[] = base.slice();
  let open: OpenSplice | undefined;
  const reopen = (last: OutlineSplice) => {
    if (last === open) return open;
    open = { index: last.index, deleteCount: last.deleteCount, items: last.items.slice() };
    merged[merged.length - 1] = open;
    return open;
  };
  for (const edit of edits) {
    const last = merged.at(-1);
    const end = last ? last.index + last.items.length : -1;
    if (last && edit.deleteCount === 0 && edit.index === end) {
      const target = reopen(last);
      for (const item of edit.items) target.items.push(item);
    } else if (last && edit.items.length === 0 && edit.deleteCount > 0 && edit.index >= last.index && edit.index + edit.deleteCount <= end) {
      const target = reopen(last);
      target.items.splice(edit.index - target.index, edit.deleteCount);
      if (target.items.length === 0 && target.deleteCount === 0) merged.pop(), open = undefined;
    } else {
      open = { index: edit.index, deleteCount: edit.deleteCount, items: edit.items.slice() };
      merged.push(open);
    }
  }
  return merged;
};

export function createRunStore(scheduler: Scheduler = defaultScheduler) {
  let entities = new Map<string, RunItem>();
  const messageAliases = new Map<string, string>();
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
    const transaction = createEntityDraft(entities, messageAliases);
    const next = reduceAllWithEntities(current, events, transaction.draft);
    transaction.commit();
    for (const id of transaction.changed) changedItems.add(id);
    current = next;
    stateChanged = true;
    if (current.outline !== beforeOutline) {
      // One change per notification: flushes before it (a read forces one) extend it, so subscribers see one edit list.
      const prior = outlineChanged ? outlineSnapshot.change : { from: beforeOutline, splices: [] };
      outlineSnapshot = { items: current.outline, change: prior && { from: prior.from, splices: mergeSplices(prior.splices, transaction.edits) } };
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
    hasMessageDelivery(deliveryId: string) {
      flush();
      return messageAliases.has(`delivery:${deliveryId}`);
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
      messageAliases.clear();
      listeners.clear();
      outlineListeners.clear();
      itemListeners.clear();
      changedItems.clear();
      stateChanged = false;
      outlineChanged = false;
    },
  };
}
