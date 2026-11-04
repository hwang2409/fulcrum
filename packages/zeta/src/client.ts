import { createRunStore, type RunEvent, type Scheduler, type RunState } from "@fulcrum/core";
import { fromZetaEvent } from "./adapter.js";
import type { HelloResult, RpcError, TransportMessage } from "./wire.js";
import type { Transport } from "./transport.js";

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * The user intent this request carries out (`send`, `steer`). On old servers, the first matching `user_message`
   * echo receives this intent (see `RunEvent`). New servers match echoes by their negotiated delivery ID instead.
   */
  intent?: string;
}
/** maxSessions limits only event-created stores; held view stores can exceed it. */
export interface ClientOptions { maxPendingRequests?: number; maxFrameSize?: number; maxSessions?: number }
export type SessionStore = ReturnType<typeof createRunStore>;
export interface SessionLease {
  readonly store: SessionStore;
  /** Releases this lease once. The store remains cached until later LRU churn. */
  release(): void;
}
const adapterError = (message: string) => ({ type: "error" as const, error: { code: "adapter_invalid_frame", message } });
const encoder = new TextEncoder();
const RESYNC_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;

export function createClient(transport: Transport, scheduler?: Scheduler, closeError?: (handshaken: boolean, code?: number) => unknown, options: ClientOptions = {}) {
  let nextId = 1;
  let handshaken = false;
  let negotiatedProtocol = "1.0";
  let negotiatedFeatures: string[] = [];
  const maxPending = options.maxPendingRequests ?? 1000;
  const maxFrame = options.maxFrameSize ?? 1024 * 1024;
  const maxSessions = options.maxSessions ?? 100;
  type Pending = { resolve: (value: unknown) => void; reject: (reason: unknown) => void; timer?: ReturnType<typeof setTimeout>; intent?: string; text?: unknown; deliveryId?: string };
  const pending = new Map<number, Pending>();
  const stores = new Map<string, SessionStore>();
  const holders = new Map<string, number>();
  const replaying = new Set<string>();
  const quarantined = new Set<string>();
  const quarantineRevisions = new Map<string, number>();
  const replayLoads = new Map<string, (signal: AbortSignal) => Promise<RunEvent[]>>();
  const activeLoads = new Map<string, AbortController>();
  type Recovery = { canceled: boolean; controller?: AbortController; timer?: ReturnType<typeof setTimeout>; wake?: () => void };
  const recoveries = new Map<string, Recovery>();
  const cancelRecovery = (session: string) => {
    const recovery = recoveries.get(session);
    if (!recovery) return;
    recovery.canceled = true;
    recovery.controller?.abort();
    if (recovery.timer) clearTimeout(recovery.timer);
    recovery.wake?.();
    recoveries.delete(session);
  };
  const cancelLoad = (session: string) => {
    activeLoads.get(session)?.abort();
    activeLoads.delete(session);
  };
  const cancelLoads = () => {
    for (const session of recoveries.keys()) cancelRecovery(session);
    for (const session of activeLoads.keys()) cancelLoad(session);
  };
  const store = createRunStore(scheduler);
  let evictionCount = 0;
  const evict = (id: string) => {
    cancelRecovery(id);
    cancelLoad(id);
    replaying.delete(id);
    quarantined.delete(id);
    quarantineRevisions.delete(id);
    replayLoads.delete(id);
    const value = stores.get(id);
    if (!value) return false;
    stores.delete(id);
    holders.delete(id);
    value.dispose();
    evictionCount++;
    return true;
  };
  const touch = (session: string) => {
    const value = stores.get(session);
    if (!value) return;
    stores.delete(session); stores.set(session, value);
  };
  const waitForRecovery = (recovery: Recovery, delay: number) => new Promise<void>((resolve) => {
    recovery.wake = resolve;
    recovery.timer = setTimeout(resolve, delay);
  });
  const failRecovery = (session: string, target: SessionStore, recovery: Recovery, failure: unknown) => {
    if (recovery.canceled) return;
    if (stores.get(session) === target) target.resyncFailed(failure);
    throw failure;
  };
  const resyncSession = async (session: string, target: SessionStore) => {
    const load = replayLoads.get(session);
    if (!load) return;
    cancelRecovery(session);
    const recovery: Recovery = { canceled: false };
    recoveries.set(session, recovery);
    quarantined.add(session);
    let failure: unknown;
    try {
      for (const delay of [0, ...RESYNC_BACKOFF_MS]) {
        if (delay) {
          await waitForRecovery(recovery, delay);
          recovery.wake = undefined;
          recovery.timer = undefined;
        }
        if (recovery.canceled) return;
        try {
          const controller = new AbortController();
          recovery.controller = controller;
          const history = await load(controller.signal);
          recovery.controller = undefined;
          if (recovery.canceled || stores.get(session) !== target) return;
          target.resync(history);
          quarantined.delete(session);
          return;
        } catch (error) {
          if (recovery.canceled) return;
          recovery.controller = undefined;
          failure = error;
        }
      }
      failRecovery(session, target, recovery, failure);
    } finally {
      recovery.controller?.abort();
      if (recoveries.get(session) === recovery) recoveries.delete(session);
    }
  };
  const createSession = (session: string) => {
    let value!: SessionStore;
    value = createRunStore(scheduler, { onError: () => { void resyncSession(session, value).catch(() => {}); } });
    stores.set(session, value);
    holders.set(session, 0);
    return value;
  };
  const trimUnheld = () => {
    let unheld = 0;
    for (const id of stores.keys()) if ((holders.get(id) ?? 0) === 0) unheld++;
    while (unheld >= maxSessions) {
      let victim: string | undefined;
      for (const id of stores.keys()) {
        if ((holders.get(id) ?? 0) === 0) { victim = id; break; }
      }
      if (victim === undefined) break;
      evict(victim);
      unheld--;
    }
  };
  const eventStore = (session?: string) => {
    if (!session) return store;
    const existing = stores.get(session);
    if (existing) { touch(session); return existing; }
    trimUnheld();
    return createSession(session);
  };
  const forSession = (session?: string): SessionLease => {
    if (!session) return { store, release() {} };
    const value = stores.get(session) ?? createSession(session);
    holders.set(session, (holders.get(session) ?? 0) + 1);
    touch(session);
    let released = false;
    return {
      store: value,
      release() {
        if (released) return;
        released = true;
        const count = holders.get(session);
        if (stores.get(session) === value && count !== undefined)
          holders.set(session, Math.max(0, count - 1));
      },
    };
  };
  /** Opens `session` on a fresh store. Until `session_replay_seq` ships, overlapping live events are ambiguous and dropped. */
  const replay = async (session: string, load: (signal: AbortSignal) => Promise<RunEvent[]>, keepQuarantined = false): Promise<SessionLease> => {
    if (replaying.has(session)) throw new Error(`session ${session} is already replaying`);
    evict(session);
    replayLoads.set(session, load);
    replaying.add(session);
    quarantined.add(session);
    quarantineRevisions.set(session, 0);
    const controller = new AbortController();
    activeLoads.set(session, controller);
    try {
      const history = await load(controller.signal);
      if (controller.signal.aborted) throw Object.assign(new Error("request aborted"), { name: "AbortError" });
      if (!keepQuarantined) activeLoads.delete(session);
      const value = createSession(session);
      holders.set(session, 1);
      let released = false;
      const lease = { store: value, release() { if (released) return; released = true; const count = holders.get(session); if (stores.get(session) === value && count !== undefined) holders.set(session, Math.max(0, count - 1)); } };
      for (const event of history) lease.store.dispatch(event);
      if (!keepQuarantined) {
        quarantined.delete(session);
        quarantineRevisions.delete(session);
      }
      return lease;
    } catch (error) {
      replayLoads.delete(session);
      quarantined.delete(session);
      quarantineRevisions.delete(session);
      throw error;
    } finally {
      if (!quarantined.has(session) && activeLoads.get(session) === controller) activeLoads.delete(session);
      replaying.delete(session);
    }
  };
  const replayRevision = (session: string) => quarantineRevisions.get(session) ?? 0;
  /** Opens live routing only if no event arrived after `revision` was captured. */
  const finishReplay = (session: string, revision: number) => {
    if (!quarantined.has(session) || replayRevision(session) !== revision) return false;
    quarantined.delete(session);
    quarantineRevisions.delete(session);
    activeLoads.delete(session);
    return true;
  };
  const stampIntent = (event: RunEvent): RunEvent => {
    if (event.type !== "user_message") return event;
    const deliveryIds = negotiatedFeatures.includes("user_message_event") && negotiatedFeatures.includes("delivery_id") && negotiatedFeatures.includes("user_message_delivery_id");
    if (deliveryIds && event.delivery_id === undefined) return event;
    const owner = deliveryIds
      ? [...pending.values()].find((request) => request.deliveryId === event.delivery_id)
      : [...pending.values()].find((request) => request.intent !== undefined && request.text === event.text);
    if (!owner) return event;
    const intent = owner.intent;
    owner.intent = undefined;
    return { ...event, ...(intent === undefined ? {} : { intent }) };
  };
  const settle = (id: number, callback: (request: Pending) => void) => {
    const request = pending.get(id); if (!request) return;
    pending.delete(id); if (request.timer) clearTimeout(request.timer); callback(request);
  };
  const handleEvent = (message: TransportMessage) => {
    if (!message.params || typeof message.params !== "object") return store.dispatch(adapterError("event params are invalid"));
    const session = typeof message.params.session_id === "string" ? message.params.session_id : undefined;
    if (session !== undefined && quarantined.has(session)) {
      quarantineRevisions.set(session, (quarantineRevisions.get(session) ?? 0) + 1);
      return;
    }
    const sessionStore = eventStore(session);
    for (const event of fromZetaEvent(message.params).map(stampIntent)) sessionStore.dispatch(event);
  };
  const handleReply = (message: TransportMessage) => {
    if (message.id === null && message.error) {
      const error = Object.assign(new Error(message.error.message), message.error);
      pending.forEach((_, id) => settle(id, (request) => request.reject(error)));
      return;
    }
    if (typeof message.id !== "number" || !pending.has(message.id)) return;
    settle(message.id, (item) => message.error ? item.reject(Object.assign(new Error(message.error.message), message.error)) : item.resolve(message.result));
  };
  transport.onMessage((text) => {
    if (text.length > maxFrame || (text.length > maxFrame / 3 && encoder.encode(text).byteLength > maxFrame)) return store.dispatch(adapterError(`frame exceeds ${maxFrame} bytes`));
    let value: unknown;
    try { value = JSON.parse(text); } catch { return store.dispatch(adapterError("frame is not valid JSON")); }
    if (!value || typeof value !== "object") return store.dispatch(adapterError("frame must be an object"));
    const message = value as TransportMessage;
    if (message.method === "event") handleEvent(message);
    else handleReply(message);
  });
  const closeListeners = new Set<(error: unknown) => void>();
  let closed = false;
  const rejectPending = (code?: number) => { const error = closeError?.(handshaken, code) ?? new Error("transport closed"); pending.forEach((_, id) => settle(id, (request) => request.reject(error))); return error; };
  transport.onClose?.((code) => {
    const error = rejectPending(code);
    cancelLoads();
    if (closed) return;
    closed = true;
    closeListeners.forEach((listener) => listener(error));
  });
  /** Calls `listener` once when the transport closes, with the same error that rejected pending requests. */
  const onClose = (listener: (error: unknown) => void) => { closeListeners.add(listener); return () => { closeListeners.delete(listener); }; };
  const request = (method: string, params: Record<string, unknown> = {}, requestOptions: RequestOptions = {}) => {
    if (!handshaken && method !== "hello") return Promise.reject(new Error("hello required"));
    if (pending.size >= maxPending) return Promise.reject(Object.assign(new Error("too many pending requests"), { code: "pending_limit" }));
    if (requestOptions.signal?.aborted) return Promise.reject(Object.assign(new Error("request aborted"), { name: "AbortError" }));
    return new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      const abort = () => settle(id, (item) => item.reject(Object.assign(new Error("request aborted"), { name: "AbortError" })));
      const item: Pending = { resolve, reject, intent: requestOptions.intent, text: requestOptions.intent === undefined ? undefined : params.text, deliveryId: typeof params.delivery_id === "string" ? params.delivery_id : undefined };
      pending.set(id, item);
      if (requestOptions.signal) requestOptions.signal.addEventListener("abort", abort, { once: true });
      if (requestOptions.timeoutMs !== undefined) item.timer = setTimeout(() => settle(id, (entry) => entry.reject(new Error("request timed out"))), requestOptions.timeoutMs);
      try { transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); }
      catch (error) { settle(id, (entry) => entry.reject(error)); }
    });
  };
  const hello = (requestedFeatures?: string[]): Promise<HelloResult> => {
    const send = () => request("hello", { protocol_version: "1.2", client_version: "1.2", ...(requestedFeatures ? { features: requestedFeatures } : {}) }) as Promise<HelloResult>;
    return (transport.ready ? transport.ready.then(send) : send()).then((result) => {
      handshaken = true;
      negotiatedProtocol = typeof result.protocol_version === "string" ? result.protocol_version : "1.0";
      const features = result.capabilities?.features;
      negotiatedFeatures = negotiatedProtocol !== "1.0" && Array.isArray(features) && features.every((feature): feature is string => typeof feature === "string") ? features : [];
      return result;
    });
  };
  const retrySession = (session: string) => {
    const target = stores.get(session);
    return target ? resyncSession(session, target) : Promise.reject(new Error(`session ${session} is not open`));
  };
  return { store, stores, forSession, replay, replayRevision, finishReplay, retrySession, request, hello, onClose, get features() { return negotiatedFeatures; }, get protocolVersion() { return negotiatedProtocol; }, get evictionCount() { return evictionCount; }, evictSession: evict, close: () => { cancelLoads(); rejectPending(); transport.close(); } };
}
export type ZetaClient = ReturnType<typeof createClient>;
export function connect(transport: Transport, scheduler?: Scheduler) { return createClient(transport, scheduler); }
export type { RunState };
