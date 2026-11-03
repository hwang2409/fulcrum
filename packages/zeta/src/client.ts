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
  const store = createRunStore(scheduler);
  let evictionCount = 0;
  const evict = (id: string) => {
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
  const createSession = (session: string) => {
    const value = createRunStore(scheduler);
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
  const buffers = new Map<string, RunEvent[]>();
  /**
   * Opens `session` on a fresh store: the cached store is dropped, live events for the session wait while `load`
   * runs, then the loaded history and the waiting events dispatch in that order. Without a server cursor, a message
   * that commits while `load` runs can appear in both the history and the live events.
   */
  const replay = async (session: string, load: () => Promise<RunEvent[]>): Promise<SessionLease> => {
    if (buffers.has(session)) throw new Error(`session ${session} is already replaying`);
    evict(session);
    const waiting: RunEvent[] = [];
    buffers.set(session, waiting);
    let history: RunEvent[];
    try {
      history = await load();
    } finally {
      if (buffers.get(session) === waiting) buffers.delete(session);
    }
    const lease = forSession(session);
    for (const event of history) lease.store.dispatch(event);
    for (const event of waiting) lease.store.dispatch(event);
    return lease;
  };
  const stampIntent = (event: RunEvent): RunEvent => {
    if (event.type !== "user_message") return event;
    const deliveryIds = negotiatedFeatures.includes("user_message_event") && negotiatedFeatures.includes("delivery_id") && negotiatedFeatures.includes("user_message_delivery_id");
    const owner = deliveryIds
      ? event.delivery_id === undefined ? undefined : [...pending.values()].find((request) => request.deliveryId === event.delivery_id)
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
  transport.onMessage((text) => {
    if (text.length > maxFrame || (text.length > maxFrame / 3 && encoder.encode(text).byteLength > maxFrame)) { store.dispatch(adapterError(`frame exceeds ${maxFrame} bytes`)); return; }
    let value: unknown;
    try { value = JSON.parse(text); } catch { store.dispatch(adapterError("frame is not valid JSON")); return; }
    if (!value || typeof value !== "object") { store.dispatch(adapterError("frame must be an object")); return; }
    const message = value as TransportMessage;
    if (message.method === "event") {
      if (!message.params || typeof message.params !== "object") { store.dispatch(adapterError("event params are invalid")); return; }
      const events = fromZetaEvent(message.params).map(stampIntent);
      const session = typeof message.params.session_id === "string" ? message.params.session_id : undefined;
      const waiting = session === undefined ? undefined : buffers.get(session);
      if (waiting) { waiting.push(...events); return; }
      const sessionStore = eventStore(session);
      for (const event of events) sessionStore.dispatch(event);
      return;
    }
    if (message.id === null && message.error) { const error = Object.assign(new Error(message.error.message), message.error); pending.forEach((_, id) => settle(id, (request) => request.reject(error))); return; }
    if (typeof message.id !== "number") return;
    const request = pending.get(message.id); if (!request) return;
    settle(message.id, (item) => message.error ? item.reject(Object.assign(new Error(message.error.message), message.error)) : item.resolve(message.result));
  });
  const closeListeners = new Set<(error: unknown) => void>();
  let closed = false;
  const rejectPending = (code?: number) => { const error = closeError?.(handshaken, code) ?? new Error("transport closed"); pending.forEach((_, id) => settle(id, (request) => request.reject(error))); return error; };
  transport.onClose?.((code) => {
    const error = rejectPending(code);
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
  return { store, stores, forSession, replay, request, hello, onClose, get features() { return negotiatedFeatures; }, get protocolVersion() { return negotiatedProtocol; }, get evictionCount() { return evictionCount; }, evictSession: evict, close: () => { rejectPending(); transport.close(); } };
}
export type ZetaClient = ReturnType<typeof createClient>;
export function connect(transport: Transport, scheduler?: Scheduler) { return createClient(transport, scheduler); }
export type { RunState };
