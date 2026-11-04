import type { RunEvent, RunItem } from "./events.js";
import {
  initialState,
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

export interface StoreOptions {
  /** Called when validated reduction still throws. The store stays readable but refuses dispatches until `resync`. */
  onError?: (error: unknown) => void;
}
export interface StoreDiagnostics {
  readonly ignoredEvents: number;
  readonly sanitizedFields: number;
  readonly desynced: boolean;
  readonly reason?: string;
  readonly resyncError?: string;
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export function createRunStore(scheduler: Scheduler = defaultScheduler, options: StoreOptions = {}) {
  let entities = new Map<string, RunItem>();
  const messageAliases = new Map<string, string>();
  let current: RunState = structuredClone(initialState);
  let pending: RunEvent[] = [];
  const listeners = new Set<Listener>();
  const outlineListeners = new Set<Listener>();
  const itemListeners = new Map<string, Set<Listener>>();
  const diagnosticsListeners = new Set<Listener>();
  let queued = false;
  let running = false;
  let flushing = false;
  let notifying = false;
  let disposed = false;
  let desynced = false;
  let ignoredEvents = 0;
  let sanitizedFields = 0;
  let diagnostics: StoreDiagnostics = { ignoredEvents, sanitizedFields, desynced };
  let stateChanged = false;
  let outlineChanged = false;
  let outlineSnapshot: OutlineSnapshot = { items: current.outline, change: null };
  const changedItems = new Set<string>();
  let edits: OutlineSplice[] = [];
  const setDiagnostics = (next: StoreDiagnostics) => {
    if (diagnostics.ignoredEvents === next.ignoredEvents && diagnostics.sanitizedFields === next.sanitizedFields && diagnostics.desynced === next.desynced && diagnostics.reason === next.reason && diagnostics.resyncError === next.resyncError) return;
    diagnostics = next;
    diagnosticsListeners.forEach((listener) => listener());
  };
  const refuseDesynced = () => { if (desynced) throw new Error("store is desynced"); };

  const flush = () => {
    if (pending.length === 0 || disposed || desynced || flushing || notifying) return false;
    flushing = true;
    const events = pending;
    pending = [];
    const beforeOutline = current.outline;
    let next: RunState;
    try {
      next = reduceAllWithEntities(current, events, {
        get: (id) => entities.get(id),
        set: (item) => { entities.set(item.id, item); changedItems.add(item.id); },
        delete: (id) => { entities.delete(id); changedItems.add(id); },
        splice: (edit) => edits.push(edit),
        getMessageAlias: (key) => messageAliases.get(key),
        setMessageAlias: (key, id) => { messageAliases.set(key, id); },
      }, () => { ignoredEvents++; }, (count) => { sanitizedFields += count; });
    } catch (error) {
      desynced = true;
      pending = [];
      edits = [];
      changedItems.clear();
      flushing = false;
      setDiagnostics({ ignoredEvents, sanitizedFields, desynced: true, reason: errorMessage(error) });
      options.onError?.(error);
      return false;
    }
    if (disposed) {
      entities.clear();
      messageAliases.clear();
      edits = [];
      changedItems.clear();
      flushing = false;
      return false;
    }
    current = next;
    stateChanged = true;
    if (current.outline !== beforeOutline) {
      // One change per notification: flushes before it (a read forces one) extend it, so subscribers see one edit list.
      const prior = outlineChanged ? outlineSnapshot.change : { from: beforeOutline, splices: [] };
      outlineSnapshot = { items: current.outline, change: prior && { from: prior.from, splices: mergeSplices(prior.splices, edits) } };
      outlineChanged = true;
    }
    edits = [];
    flushing = false;
    setDiagnostics({ ignoredEvents, sanitizedFields, desynced: false });
    return true;
  };
  const notify = () => {
    if (!stateChanged || desynced) return;
    stateChanged = false;
    notifying = true;
    try {
      listeners.forEach((listener) => listener());
      if (outlineChanged) outlineListeners.forEach((listener) => listener());
      outlineChanged = false;
      for (const id of changedItems) itemListeners.get(id)?.forEach((listener) => listener());
      changedItems.clear();
    } finally {
      notifying = false;
    }
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
      if (!notifying) flush();
      return current;
    },
    getItem(id: string) {
      if (!notifying) flush();
      return entities.get(id);
    },
    getOutline(): readonly OutlineItem[] {
      if (!notifying) flush();
      return current.outline;
    },
    getOutlineSnapshot(): OutlineSnapshot {
      if (!notifying) flush();
      return outlineSnapshot;
    },
    hasMessageDelivery(deliveryId: string) {
      if (!notifying) flush();
      return messageAliases.has(`delivery:${deliveryId}`);
    },
    getDiagnostics(): StoreDiagnostics { return diagnostics; },
    subscribeDiagnostics(listener: Listener) {
      diagnosticsListeners.add(listener);
      return () => diagnosticsListeners.delete(listener);
    },
    resyncFailed(error: unknown) {
      if (!desynced || disposed) return;
      setDiagnostics({ ...diagnostics, resyncError: errorMessage(error) });
    },
    resync(events: readonly RunEvent[]) {
      if (disposed) throw new Error("store is disposed");
      pending = [];
      entities.clear();
      messageAliases.clear();
      current = structuredClone(initialState);
      outlineSnapshot = { items: current.outline, change: null };
      changedItems.clear();
      edits = [];
      stateChanged = false;
      outlineChanged = false;
      desynced = false;
      pending.push(...events);
      flush();
      if (!desynced) setDiagnostics({ ignoredEvents, sanitizedFields, desynced: false });
      notify();
    },
    subscribe,
    subscribeOutline(listener: Listener) {
      outlineListeners.add(listener);
      return () => outlineListeners.delete(listener);
    },
    dispatch(event: RunEvent) {
      if (disposed) throw new Error("store is disposed");
      refuseDesynced();
      pending.push(event);
      if (!queued) {
        queued = true;
        scheduler(() => {
          queued = false;
          if (running) return;
          running = true;
          try {
            do {
              flush();
              notify();
            } while (pending.length > 0 && !disposed && !desynced);
          } finally {
            running = false;
          }
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
      diagnosticsListeners.clear();
      changedItems.clear();
      edits = [];
      desynced = false;
      diagnostics = { ignoredEvents, sanitizedFields, desynced: false };
      stateChanged = false;
      outlineChanged = false;
    },
  };
}
