// Host code runs only through call() (listeners, onError), sink() (the error report), and errorMessage() (a thrown
// value's text), plus the "outside" rows of the README table: scheduler(job), and reading host-given events (inside a
// reduction's try, or the argument copy at the top of resync and prepend). See packages/core/README.md, "Notification
// contract"; a new host call gets a table row and a test. Every site is marked "host code" so one grep finds them all.
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
/**
 * `change` is null when there is nothing to edit from: the first snapshot, after `resync`, and after `dispose`. A null
 * change means "take `items` whole"; a resync is a discontinuity, never an edit of what a view held.
 */
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

const structurallyEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(right, key)
      && structurallyEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
};

const outlineSuffixLength = (older: readonly OutlineItem[], newer: readonly OutlineItem[]) => {
  if (newer.length < older.length) return -1;
  const offset = newer.length - older.length;
  return older.every((item, index) => item.id === newer[offset + index]?.id) ? offset : -1;
};
// push(...source) passes every element as a call argument and throws RangeError for large arrays.
const append = <T>(target: T[], source: readonly T[]) => {
  for (const item of source) target.push(item);
};
// The one owner of whether a resync notifies outline subscribers: always when a change is pending (a read may have
// flushed it before its frame ran), else only when the replay's rows differ from the outline subscribers hold. Outline
// ids carry their kind, so ids decide. What it publishes is a replacement (`change: null`).
const resyncOutlineChange = (prior: readonly OutlineItem[], pending: boolean, next: readonly OutlineItem[]) =>
  pending || prior.length !== next.length || prior.some((item, index) => item.id !== next[index]?.id);
export function createRunStore(scheduler: Scheduler = defaultScheduler, options: StoreOptions = {}) {
  // host code: read once here, so a getter on `options` cannot run (or throw) during a later flush.
  const onError = options.onError;
  let entities = new Map<string, RunItem>();
  let messageAliases = new Map<string, string>();
  let current: RunState = structuredClone(initialState);
  let pending: RunEvent[] = [];
  let acceptedLog: RunEvent[] = [];
  let historyOpen = false;
  let pendingOlderPages: RunEvent[][] = [];
  const listeners = new Set<Listener>();
  const outlineListeners = new Set<Listener>();
  const itemListeners = new Map<string, Set<Listener>>();
  const diagnosticsListeners = new Set<Listener>();
  let queued = false;
  let running = false;
  let flushing = false;
  let notifying = false;
  let flushDeferred = false;
  let failure: { error: unknown } | undefined;
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
  // The host's error report. A sink that throws (a fail-on-console test setup, a mocked reportError) is host code too:
  // its own throw is dropped, since there is nowhere left to report it, so it cannot cut delivery short.
  const sink = (error: unknown) => {
    try {
      if (typeof reportError === "function") reportError(error);
      else console.error(error);
    } catch {}
  };
  // host code: a thrown or host-given value's text runs its `message` getter, toString, or Proxy traps. Callers set
  // the desync state before calling it, and an unreadable value becomes a fixed reason, so it never throws.
  const errorMessage = (error: unknown): string => {
    try {
      const message: unknown = error instanceof Error ? error.message : error;
      return typeof message === "string" ? message : String(message);
    } catch {
      return "unreadable error";
    }
  };
  // The one delivery owner for every listener and host callback: the rules live in packages/core/README.md, section
  // "Notification contract"; keep them in sync.
  // host code: every listener and onError call goes through here.
  const call = (listener: Listener) => {
    try {
      listener();
    } catch (error) {
      // The first error is rethrown after delivery; later ones go to the sink so none vanish.
      if (!failure) failure = { error };
      else sink(error);
    }
  };
  // Rethrows the first listener error once delivery is over: never inside a pass (it would cut a listener short) and
  // never mid-entry (it would skip the entry's own bookkeeping), so every entry calls it last. Reads never call it.
  const report = () => {
    if (!failure || notifying || running) return;
    const { error } = failure;
    failure = undefined;
    throw error;
  };
  const setDiagnostics = (next: StoreDiagnostics) => {
    if (diagnostics.ignoredEvents === next.ignoredEvents && diagnostics.sanitizedFields === next.sanitizedFields && diagnostics.desynced === next.desynced && diagnostics.reason === next.reason && diagnostics.resyncError === next.resyncError) return;
    diagnostics = next;
    diagnosticsListeners.forEach(call);
  };
  const refuseDesynced = () => { if (desynced) throw new Error("store is desynced"); };

  const flush = () => {
    if (pending.length === 0 || disposed || desynced || flushing || notifying) return false;
    flushing = true;
    const events = pending;
    pending = [];
    const beforeOutline = current.outline;
    let next: RunState;
    const accepted = historyOpen ? [] as RunEvent[] : undefined;
    // host code: getters and proxies on events run inside this try; a throw is a reduction failure.
    try {
      next = reduceAllWithEntities(current, events, {
        get: (id) => entities.get(id),
        set: (item) => { entities.set(item.id, item); changedItems.add(item.id); },
        delete: (id) => { entities.delete(id); changedItems.add(id); },
        splice: (edit) => edits.push(edit),
        getMessageAlias: (key) => messageAliases.get(key),
        setMessageAlias: (key, id) => { messageAliases.set(key, id); },
      }, () => { ignoredEvents++; }, (count) => { sanitizedFields += count; }, accepted && ((event) => accepted.push(event)));
    } catch (error) {
      desynced = true;
      pending = [];
      edits = [];
      changedItems.clear();
      flushing = false;
      setDiagnostics({ ignoredEvents, sanitizedFields, desynced: true, reason: errorMessage(error) });
      if (onError) call(() => onError(error));
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
    if (accepted) append(acceptedLog, accepted);
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
  const flushPrepend = () => {
    if (pendingOlderPages.length === 0 || disposed || desynced) return false;
    const pages = pendingOlderPages;
    pendingOlderPages = [];
    const older: RunEvent[] = [];
    for (let index = pages.length - 1; index >= 0; index--) append(older, pages[index]!);
    const beforeOutline = current.outline;
    const nextEntities = new Map<string, RunItem>();
    const nextAliases = new Map<string, string>();
    const nextLog: RunEvent[] = [];
    const changed: string[] = [];
    let next: RunState;
    // host code: getters and proxies on events run inside this try, and so does the identity check, which reads item
    // fields that came from events; a throw is a reduction failure.
    try {
      next = reduceAllWithEntities(structuredClone(initialState), [...older, ...acceptedLog], {
        get: (id) => nextEntities.get(id),
        set: (item) => nextEntities.set(item.id, item),
        delete: (id) => nextEntities.delete(id),
        splice() {},
        getMessageAlias: (key) => nextAliases.get(key),
        setMessageAlias: (key, id) => nextAliases.set(key, id),
      }, () => { ignoredEvents++; }, (count) => { sanitizedFields += count; }, (event) => nextLog.push(event));
      for (const [id, item] of nextEntities) {
        const prior = entities.get(id);
        if (prior && structurallyEqual(prior, item)) nextEntities.set(id, prior);
        else changed.push(id);
      }
    } catch (error) {
      desynced = true;
      setDiagnostics({ ignoredEvents, sanitizedFields, desynced: true, reason: errorMessage(error) });
      if (onError) call(() => onError(error));
      return false;
    }
    for (const id of changed) changedItems.add(id);
    for (const id of entities.keys()) if (!nextEntities.has(id)) changedItems.add(id);
    const prefix = outlineSuffixLength(beforeOutline, next.outline);
    if (prefix >= 0) next.outline = [...next.outline.slice(0, prefix), ...beforeOutline];
    const splice = prefix >= 0
      ? { index: 0, deleteCount: 0, items: next.outline.slice(0, prefix) }
      : { index: 0, deleteCount: beforeOutline.length, items: next.outline };
    current = next;
    entities = nextEntities;
    messageAliases = nextAliases;
    acceptedLog = nextLog;
    stateChanged = true;
    if (splice.deleteCount > 0 || splice.items.length > 0) {
      outlineSnapshot = { items: current.outline, change: { from: beforeOutline, splices: [splice] } };
      outlineChanged = true;
    }
    setDiagnostics({ ignoredEvents, sanitizedFields, desynced: false });
    return true;
  };
  const notify = () => {
    if (!stateChanged || desynced || notifying) return;
    stateChanged = false;
    const outline = outlineChanged;
    outlineChanged = false;
    const items = [...changedItems];
    changedItems.clear();
    notifying = true;
    // call() catches listener errors; the finally covers what it cannot, like a stack overflow pushing its frame.
    try {
      listeners.forEach(call);
      if (outline) outlineListeners.forEach(call);
      for (const id of items) itemListeners.get(id)?.forEach(call);
    } finally {
      notifying = false;
    }
    if (stateChanged || flushDeferred) flushDeferred = false, flush(), flushPrepend(), notify();
  };

  const job = () => {
    queued = false;
    if (running) return;
    // A job run during a pass (a synchronous scheduler) cannot flush yet: the pass's tail does it.
    if (notifying) return void (flushDeferred = true);
    running = true;
    try {
      do {
        flush();
        flushPrepend();
        notify();
      } while ((pending.length > 0 || pendingOlderPages.length > 0) && !disposed && !desynced);
    } finally {
      running = false;
    }
    report();
  };
  const scheduleFlush = () => {
    if (queued) return;
    queued = true;
    try {
      scheduler(job); // host code: outside; its throw reaches the caller (README rule 9)
    } catch (error) {
      // The host refused the job: nothing is queued, so the next dispatch must schedule again.
      queued = false;
      throw error;
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
      if (!notifying) flush(), flushPrepend();
      return current;
    },
    getItem(id: string) {
      if (!notifying) flush(), flushPrepend();
      return entities.get(id);
    },
    getOutline(): readonly OutlineItem[] {
      if (!notifying) flush(), flushPrepend();
      return current.outline;
    },
    getOutlineSnapshot(): OutlineSnapshot {
      if (!notifying) flush(), flushPrepend();
      return outlineSnapshot;
    },
    hasMessageDelivery(deliveryId: string) {
      if (!notifying) flush(), flushPrepend();
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
      report();
    },
    /**
     * Replaces all state with `events`. Outline subscribers run only if they would miss something (a pending change or
     * different rows), and then read `change: null`: take `items` whole. Every prior item's keyed listener runs. Called
     * from a listener, it is delivered right after the running notification, never nested in it.
     */
    resync(events: readonly RunEvent[]) {
      if (disposed) throw new Error("store is disposed");
      // host code: iterating the argument; a throwing iterator reaches the caller before any state change.
      const replay = [...events];
      const prior = current.outline;
      const pendingOutline = outlineChanged;
      // Pending keyed notifications stay; every prior row is replaced (or removed), so its listener runs too.
      entities.forEach((_, id) => changedItems.add(id));
      pending = replay;
      pendingOlderPages = [];
      entities.clear();
      messageAliases.clear();
      current = structuredClone(initialState);
      outlineSnapshot = { items: current.outline, change: null };
      edits = [];
      stateChanged = false;
      outlineChanged = false;
      desynced = false;
      acceptedLog = [];
      // Inside a notification the flush waits for notify's next pass, so the rows are not known yet: notify then.
      const flushed = flush();
      stateChanged = true;
      outlineChanged = (!flushed && notifying) || resyncOutlineChange(prior, pendingOutline, current.outline);
      outlineSnapshot = { items: current.outline, change: null };
      if (!desynced) setDiagnostics({ ignoredEvents, sanitizedFields, desynced: false });
      notify();
      report();
    },
    /** Starts retaining accepted events for a backward-history walk. Call before publishing its newest page. */
    beginHistory() {
      if (disposed) throw new Error("store is disposed");
      refuseDesynced();
      if (historyOpen) throw new Error("history is already open");
      flush();
      notify();
      acceptedLog = [];
      historyOpen = true;
      report();
    },
    /** Finishes the history walk and releases its accepted-event log. `prepend` is invalid after this call. */
    endHistory() {
      if (disposed) return;
      if (!historyOpen) return;
      flush();
      flushPrepend();
      notify();
      acceptedLog = [];
      historyOpen = false;
      report();
    },
    /**
     * Re-reduces `older` followed by every accepted event since `beginHistory()` from empty, so the result exactly
     * matches chronological reduction and accepted live events win naturally. Rejection publishes nothing and visibly
     * desyncs the store. Cost is O(older + applied log) per prepend, at most once per page; pages queued in one frame
     * share one reduction. Calling after `endHistory()` is a programmer error.
     */
    prepend(events: readonly RunEvent[]) {
      if (disposed) throw new Error("store is disposed");
      refuseDesynced();
      if (!historyOpen) throw new Error("prepend requires an open history window");
      // host code: iterating the argument; a throwing iterator reaches the caller before any state change.
      const page = [...events];
      flush();
      notify();
      pendingOlderPages.push(page);
      scheduleFlush();
      report();
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
      scheduleFlush();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pending = [];
      pendingOlderPages = [];
      acceptedLog = [];
      historyOpen = false;
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
      // Inside a scheduler job or a listener pass, the kept error stays and that entry rethrows it. Anywhere else (a
      // read flushed it, or a diagnostics listener of an entry outside a job) it goes to the sink once and no entry
      // rethrows it: nothing may rethrow after dispose.
      if (failure && !notifying && !running) sink(failure.error), failure = undefined;
      desynced = false;
      diagnostics = { ignoredEvents, sanitizedFields, desynced: false };
      stateChanged = false;
      outlineChanged = false;
    },
  };
}
