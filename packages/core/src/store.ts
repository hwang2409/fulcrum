import type { RunEvent, RunItem } from "./events.js";
import {
  composeBefore,
  initialState,
  RECEIPT_LIMIT,
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

type CompositionTracker = {
  readonly messageContinuations: Map<string, boolean>;
  readonly approvalRequests: Set<string>;
  readonly approvalEnds: Map<string, Extract<RunEvent, { type: "approval_end" }>>;
  activeMessageId?: string;
  endsPriorMessage: boolean;
  agentTouched: boolean;
  turnTouched: boolean;
  readonly toolTouched: Set<string>;
  endsPriorTools: boolean;
};
const compositionTracker = (): CompositionTracker => ({
  messageContinuations: new Map(),
  approvalRequests: new Set(),
  approvalEnds: new Map(),
  endsPriorMessage: false,
  agentTouched: false,
  turnTouched: false,
  toolTouched: new Set(),
  endsPriorTools: false,
});
const trackComposition = (tracker: CompositionTracker, event: RunEvent) => {
  if (event === null || typeof event !== "object") return;
  switch (event.type) {
    case "message_delta":
    case "message_block": {
      tracker.endsPriorMessage = true;
      if (!event.message_id) break;
      const id = `message:${event.message_id}`;
      if (tracker.activeMessageId !== event.message_id) tracker.messageContinuations.set(id, true);
      tracker.activeMessageId = event.message_id;
      break;
    }
    case "message_commit":
      tracker.endsPriorMessage = true;
      if (event.message_id) tracker.messageContinuations.set(`message:${event.message_id}`, false);
      tracker.activeMessageId = undefined;
      break;
    case "message_reset":
      tracker.endsPriorMessage = true;
      if (tracker.activeMessageId) tracker.messageContinuations.delete(`message:${tracker.activeMessageId}`);
      tracker.activeMessageId = undefined;
      break;
    case "retry":
      tracker.endsPriorMessage = true;
      tracker.activeMessageId = undefined;
      break;
    case "turn_end":
      tracker.turnTouched = true;
      tracker.endsPriorMessage = true;
      tracker.activeMessageId = undefined;
      break;
    case "run_end":
      tracker.agentTouched = true;
      tracker.turnTouched = true;
      tracker.endsPriorMessage = true;
      tracker.endsPriorTools = true;
      tracker.activeMessageId = undefined;
      break;
    case "approval_request":
      tracker.approvalRequests.add(event.request_id);
      tracker.approvalEnds.delete(event.request_id);
      break;
    case "approval_end":
      if (!tracker.approvalRequests.has(event.request_id)) tracker.approvalEnds.set(event.request_id, event);
      break;
    case "run_start":
      tracker.agentTouched = true;
      break;
    case "turn_start":
      tracker.turnTouched = true;
      break;
    case "tool_start": case "tool_input": case "tool_output": case "tool_end":
      if (event.tool_call && typeof event.tool_call.id === "string") tracker.toolTouched.add(event.tool_call.id);
      break;
    case "error":
      tracker.agentTouched = true;
      tracker.turnTouched = true;
      tracker.endsPriorMessage = true;
      tracker.endsPriorTools = true;
      break;
    case "message_start": case "usage": case "user_message": case "notification": case "unknown": case "sub_agent":
      break;
    default: event satisfies never;
  }
};
const trackPageComposition = (events: readonly RunEvent[]) => {
  const tracker = compositionTracker();
  for (const event of events) trackComposition(tracker, event);
  return tracker;
};

export function createRunStore(scheduler: Scheduler = defaultScheduler, options: StoreOptions = {}) {
  let entities = new Map<string, RunItem>();
  const messageAliases = new Map<string, string>();
  let current: RunState = structuredClone(initialState);
  let pending: RunEvent[] = [];
  let composition = compositionTracker();
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
      composition = trackPageComposition(events);
      pending.push(...events);
      flush();
      if (!desynced) setDiagnostics({ ignoredEvents, sanitizedFields, desynced: false });
      notify();
    },
    /**
     * Reduces one older page, composes entities that cross the live-copy seam, then emits one index-0 splice.
     * An indeterminate composition desyncs before publication. Cost is O(page) plus one O(n) outline pointer copy.
     */
    prepend(events: readonly RunEvent[]) {
      if (disposed) throw new Error("store is disposed");
      refuseDesynced();
      flush();
      notify();
      const olderEntities = new Map<string, RunItem>();
      const olderAliases = new Map<string, string>();
      const olderComposition = trackPageComposition(events);
      let older = { ...structuredClone(initialState), nextId: current.nextId };
      const updates = new Map<string, RunItem>();
      try {
        older = reduceAllWithEntities(older, events.slice(), {
          get: (id) => olderEntities.get(id),
          set: (item) => olderEntities.set(item.id, item),
          delete: (id) => olderEntities.delete(id),
          splice() {},
          getMessageAlias: (key) => olderAliases.get(key),
          setMessageAlias: (key, id) => olderAliases.set(key, id),
        }, () => { ignoredEvents++; }, (count) => { sanitizedFields += count; });
        for (const [id, olderItem] of olderEntities) {
          const currentItem = entities.get(id);
          if (currentItem) updates.set(id, composeBefore(olderItem, currentItem, composition.messageContinuations.get(id) === true));
          else if (olderItem.type === "approval") {
            const ended = composition.approvalEnds.get(olderItem.id.slice("approval:".length));
            updates.set(id, ended ? { ...olderItem, ended } : olderItem);
          } else if (olderItem.type === "message" && composition.endsPriorMessage && olderItem.active) updates.set(id, { ...olderItem, active: false });
          else updates.set(id, olderItem);
        }
      } catch (error) {
        desynced = true;
        setDiagnostics({ ignoredEvents, sanitizedFields, desynced: true, reason: errorMessage(error) });
        options.onError?.(error);
        return;
      }
      const inserted = older.outline.filter(({ id }) => !entities.has(id));
      const insertedIds = new Set(inserted.map(({ id }) => id));
      const reusedGeneratedIds = older.outline.reduce((count, { id, kind }) =>
        count + (entities.has(id) && (kind === "message" || kind === "error" || kind === "notification" || kind === "unknown" || (kind === "user" && /^user:\\d+$/.test(id))) ? 1 : 0), 0);
      for (const [id, item] of updates) {
        entities.set(id, item);
        changedItems.add(id);
      }
      for (const [key, id] of olderAliases) if (!messageAliases.has(key) && (entities.has(id) || updates.has(id))) messageAliases.set(key, id);
      composition.endsPriorMessage ||= olderComposition.endsPriorMessage;
      composition.agentTouched ||= olderComposition.agentTouched;
      composition.turnTouched ||= olderComposition.turnTouched;
      composition.endsPriorTools ||= olderComposition.endsPriorTools;
      for (const toolId of olderComposition.toolTouched) composition.toolTouched.add(toolId);
      for (const [id, continued] of olderComposition.messageContinuations) {
        if (insertedIds.has(id) || composition.messageContinuations.get(id) === true) composition.messageContinuations.set(id, continued);
      }
      for (const requestId of olderComposition.approvalRequests) {
        composition.approvalRequests.add(requestId);
        composition.approvalEnds.delete(requestId);
      }
      for (const [requestId, end] of olderComposition.approvalEnds) if (!composition.approvalRequests.has(requestId)) composition.approvalEnds.set(requestId, end);
      const before = current.outline;
      const nextId = older.nextId - reusedGeneratedIds;
      const toolApprovals = { ...older.toolApprovals, ...current.toolApprovals };
      for (const [toolId, approvalId] of Object.entries(toolApprovals)) if (!entities.has(approvalId)) delete toolApprovals[toolId];
      const usage = { ...older.usage };
      for (const [key, amount] of Object.entries(current.usage)) usage[key] = (usage[key] ?? 0) + amount;
      const activeToolIds = composition.endsPriorTools ? { ...current.activeToolIds } : { ...older.activeToolIds, ...current.activeToolIds };
      for (const toolId of composition.toolTouched) if (!current.activeToolIds[toolId]) delete activeToolIds[toolId];
      const receiptOrder = [...new Set([...older.receiptOrder, ...current.receiptOrder])].slice(-RECEIPT_LIMIT);
      const receipts = Object.fromEntries(receiptOrder.map((id) => [id, true]));
      const composedState = {
        ...current,
        agent: composition.agentTouched ? current.agent : older.agent,
        turn: composition.turnTouched ? current.turn : older.turn,
        turns: [...older.turns, ...current.turns],
        usage,
        receipts,
        receiptOrder,
        activeMessageId: composition.endsPriorMessage ? current.activeMessageId : current.activeMessageId ?? older.activeMessageId,
        activeToolIds,
        nextId,
        toolApprovals,
      };
      current = inserted.length === 0
        ? composedState
        : { ...composedState, outline: [...inserted, ...before] };
      if (inserted.length > 0) {
        outlineSnapshot = { items: current.outline, change: { from: before, splices: [{ index: 0, deleteCount: 0, items: inserted }] } };
        outlineChanged = true;
      }
      stateChanged = updates.size > 0;
      setDiagnostics({ ignoredEvents, sanitizedFields, desynced: false });
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
      trackComposition(composition, event);
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
      composition = compositionTracker();
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
