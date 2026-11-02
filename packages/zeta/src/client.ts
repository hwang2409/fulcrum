import { createRunStore, type Scheduler, type RunState } from "@fulcrum/core";
import { fromZetaEvent } from "./adapter.js";
import type { HelloResult, RpcError, TransportMessage } from "./wire.js";
import type { Transport } from "./transport.js";

export interface RequestOptions { signal?: AbortSignal; timeoutMs?: number }
export interface ClientOptions { maxPendingRequests?: number; maxFrameSize?: number; maxSessions?: number }
const adapterError = (message: string) => ({ type: "error" as const, error: { code: "adapter_invalid_frame", message } });
const encoder = new TextEncoder();

export function createClient(transport: Transport, scheduler?: Scheduler, closeError?: (handshaken: boolean, code?: number) => unknown, options: ClientOptions = {}) {
  let nextId = 1;
  let handshaken = false;
  let negotiatedFeatures: string[] = [];
  const maxPending = options.maxPendingRequests ?? 1000;
  const maxFrame = options.maxFrameSize ?? 1024 * 1024;
  const maxSessions = options.maxSessions ?? 100;
  type Pending = { resolve: (value: unknown) => void; reject: (reason: unknown) => void; timer?: ReturnType<typeof setTimeout> };
  const pending = new Map<number, Pending>();
  const stores = new Map<string, ReturnType<typeof createRunStore>>();
  const store = createRunStore(scheduler);
  let evictionCount = 0;
  const evict = (id: string) => {
    const value = stores.get(id);
    if (!value) return false;
    stores.delete(id);
    value.dispose();
    evictionCount++;
    return true;
  };
  const touch = (session: string) => {
    const value = stores.get(session);
    if (!value) return;
    stores.delete(session); stores.set(session, value);
  };
  const forSession = (session?: string) => {
    if (!session) return store;
    let value = stores.get(session);
    if (!value) {
      while (stores.size >= maxSessions) {
        const victim = stores.keys().next().value;
        if (victim === undefined) break;
        evict(victim);
      }
      value = createRunStore(scheduler); stores.set(session, value);
    } else touch(session);
    return value;
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
      const events = fromZetaEvent(message.params);
      const session = typeof message.params.session_id === "string" ? message.params.session_id : undefined;
      for (const event of events) forSession(session).dispatch(event);
      return;
    }
    if (message.id === null && message.error) { const error = Object.assign(new Error(message.error.message), message.error); pending.forEach((_, id) => settle(id, (request) => request.reject(error))); return; }
    if (typeof message.id !== "number") return;
    const request = pending.get(message.id); if (!request) return;
    settle(message.id, (item) => message.error ? item.reject(Object.assign(new Error(message.error.message), message.error)) : item.resolve(message.result));
  });
  const rejectPending = (code?: number) => { const error = closeError?.(handshaken, code) ?? new Error("transport closed"); pending.forEach((_, id) => settle(id, (request) => request.reject(error))); };
  transport.onClose?.(rejectPending);
  const request = (method: string, params: Record<string, unknown> = {}, requestOptions: RequestOptions = {}) => {
    if (!handshaken && method !== "hello") return Promise.reject(new Error("hello required"));
    if (pending.size >= maxPending) return Promise.reject(Object.assign(new Error("too many pending requests"), { code: "pending_limit" }));
    if (requestOptions.signal?.aborted) return Promise.reject(Object.assign(new Error("request aborted"), { name: "AbortError" }));
    return new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      const abort = () => settle(id, (item) => item.reject(Object.assign(new Error("request aborted"), { name: "AbortError" })));
      const item: Pending = { resolve, reject };
      pending.set(id, item);
      if (requestOptions.signal) requestOptions.signal.addEventListener("abort", abort, { once: true });
      if (requestOptions.timeoutMs !== undefined) item.timer = setTimeout(() => settle(id, (entry) => entry.reject(new Error("request timed out"))), requestOptions.timeoutMs);
      try { transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); }
      catch (error) { settle(id, (entry) => entry.reject(error)); }
    });
  };
  const hello = (requestedFeatures?: string[]): Promise<HelloResult> => {
    const send = () => request("hello", { protocol_version: "1.0", client_version: "1.2", ...(requestedFeatures ? { features: requestedFeatures } : {}) }) as Promise<HelloResult>;
    return (transport.ready ? transport.ready.then(send) : send()).then((result) => { handshaken = true; negotiatedFeatures = result.capabilities?.features ?? []; return result; });
  };
  return { store, stores, forSession, request, hello, get features() { return negotiatedFeatures; }, get evictionCount() { return evictionCount; }, evictSession: evict, close: () => { rejectPending(); transport.close(); } };
}
export function connect(transport: Transport, scheduler?: Scheduler) { return createClient(transport, scheduler); }
export type { RunState };
