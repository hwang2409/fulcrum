import { createRunStore, type RunEvent, type Scheduler, type RunState } from "@fulcrum/core";
import { fromZetaEvent } from "./adapter.js";
import { createDeliveryIdentity } from "./delivery-identity.js";
import type { HelloResult, RpcError, TransportMessage } from "./wire.js";
import type { Transport } from "./transport.js";
import {
  HostCommandError,
  isHostBindingRequired,
  redactHostCommandFailure,
  validateHostCommands,
  type HostCommandSupplier,
} from "./host-commands.js";

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
export interface ClientOptions {
  maxPendingRequests?: number;
  maxFrameSize?: number;
  maxSessions?: number;
  /** Enables Zeta session host commands and supplies a fresh binding for each session attachment. */
  hostCommands?: HostCommandSupplier | null;
}
export type SessionStore = ReturnType<typeof createRunStore>;
export interface SessionLease {
  readonly store: SessionStore;
  /** Releases this lease once. The store remains cached until later LRU churn. */
  release(): void;
}
const adapterError = (message: string) => ({ type: "error" as const, error: { code: "adapter_invalid_frame", message } });
const encoder = new TextEncoder();
const RESYNC_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;
export const MAX_CONTENT_BYTES = 32 * 1024 * 1024;
export type ContentReadErrorKind = "not_available" | "not_negotiated" | "invalid_request" | "invalid_response" | "too_large";
export class ContentReadError extends Error {
  readonly name = "ContentReadError";
  constructor(readonly kind: ContentReadErrorKind, message: string) { super(message); }
}

type ContentChunk = { handle: string; media_type: string; title?: string; size: number; offset: number; data: string; next_offset: number; eof: boolean };
const contentChunk = (value: unknown): ContentChunk => {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (typeof row.handle !== "string" || typeof row.media_type !== "string" ||
      typeof row.size !== "number" || !Number.isSafeInteger(row.size) || row.size < 0 ||
      typeof row.offset !== "number" || !Number.isSafeInteger(row.offset) || row.offset < 0 ||
      typeof row.next_offset !== "number" || !Number.isSafeInteger(row.next_offset) || row.next_offset < row.offset ||
      typeof row.data !== "string" || typeof row.eof !== "boolean" ||
      (row.title !== undefined && typeof row.title !== "string"))
    throw new ContentReadError("invalid_response", "content_read returned an invalid response");
  return row as ContentChunk;
};
const decodeBase64 = (value: string) => {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    throw new ContentReadError("invalid_response", "content_read returned invalid base64");
  }
};
type ContentAssembly = { offset: number; size?: number; mediaType?: string; title?: string; chunks: Uint8Array<ArrayBuffer>[] };
const validatedChunk = (value: unknown, handle: string, state: ContentAssembly, cap: number) => {
  const chunk = contentChunk(value);
  if (chunk.handle !== handle || chunk.offset !== state.offset ||
      (state.size !== undefined && chunk.size !== state.size) ||
      (state.mediaType !== undefined && chunk.media_type !== state.mediaType) ||
      (state.size !== undefined && chunk.title !== state.title))
    throw new ContentReadError("invalid_response", "content_read response changed between chunks");
  state.size ??= chunk.size;
  state.mediaType ??= chunk.media_type;
  state.title ??= chunk.title;
  if (state.size > cap) throw new ContentReadError("too_large", `content is larger than ${cap} bytes`);
  const bytes = decodeBase64(chunk.data);
  if (bytes.byteLength !== chunk.next_offset - state.offset || chunk.next_offset > state.size || state.offset + bytes.byteLength > cap)
    throw new ContentReadError("invalid_response", "content_read returned inconsistent offsets");
  return { chunk, bytes };
};
const contentReadError = (error: unknown): never => {
  if (error instanceof ContentReadError || (error as { name?: unknown }).name === "AbortError") throw error;
  const rpc = error as { code?: unknown; data?: { code?: unknown } };
  if (rpc.code === -32012 || rpc.data?.code === "content_not_found") throw new ContentReadError("not_available", "content is no longer available");
  if (rpc.code === -32601) throw new ContentReadError("not_negotiated", "content_read was not negotiated");
  if (rpc.code === -32602 || rpc.data?.code === "invalid_content_read") throw new ContentReadError("invalid_request", "content_read request was invalid");
  throw error;
};
const finishContent = (chunk: ContentChunk, state: ContentAssembly) => {
  if (chunk.next_offset !== state.size) throw new ContentReadError("invalid_response", "content_read ended before its declared size");
  return new Blob(state.chunks, { type: state.mediaType });
};
const advanceContent = (chunk: ContentChunk, state: ContentAssembly) => {
  if (chunk.next_offset <= state.offset) throw new ContentReadError("invalid_response", "content_read did not advance");
  state.offset = chunk.next_offset;
};
async function readContentChunks(handle: string, cap: number, read: (offset: number) => Promise<unknown>) {
  const state: ContentAssembly = { offset: 0, chunks: [] };
  while (true) {
    const { chunk, bytes } = validatedChunk(await read(state.offset), handle, state, cap);
    state.chunks.push(bytes);
    if (chunk.eof) return finishContent(chunk, state);
    advanceContent(chunk, state);
  }
}

export type CloseReason = { kind: "output_overflow"; message: string; role: "controller" | "observer" };

export function createClient(transport: Transport, scheduler?: Scheduler, closeError?: (handshaken: boolean, code?: number, reason?: CloseReason) => unknown, options: ClientOptions = {}) {
  let nextId = 1;
  let handshaken = false;
  let negotiatedProtocol = "1.0";
  let negotiatedFeatures: string[] = [];
  let warnedHostCommandsUnavailable = false;
  const maxPending = options.maxPendingRequests ?? 1000;
  const maxFrame = options.maxFrameSize ?? 1024 * 1024;
  const maxSessions = options.maxSessions ?? 100;
  type Pending = { resolve: (value: unknown) => void; reject: (reason: unknown) => void; timer?: ReturnType<typeof setTimeout> };
  const pending = new Map<number, Pending>();
  const deliveryIdentity = createDeliveryIdentity(maxPending);
  const stores = new Map<string, SessionStore>();
  const holders = new Map<string, number>();
  const replaying = new Set<string>();
  const quarantined = new Set<string>();
  // The last served turn each session started (feature `served_turn_end`), so a host can look up its recorded end.
  const servedTurns = new Map<string, string>();
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
    deliveryIdentity.evictSession(id);
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
    value = createRunStore(scheduler, { runId: session, onError: () => { void resyncSession(session, value).catch(() => {}); } });
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
  const canMatchDeliveryId = () => negotiatedFeatures.includes("delivery_id") && negotiatedFeatures.includes("user_message_event") && negotiatedFeatures.includes("user_message_delivery_id");
  const canSendImagesDeliveryId = () => negotiatedFeatures.includes("delivery_id") && negotiatedFeatures.includes("send_images_delivery_id");
  const stampIntent = (event: RunEvent, sessionId?: string): RunEvent => {
    if (event.type !== "user_message") return event;
    const identity = deliveryIdentity.match({
      sessionId,
      text: event.text,
      deliveryId: event.delivery_id,
      hasAttachments: event.attachments !== undefined && event.attachments.length > 0,
      canMatchDeliveryId: canMatchDeliveryId(),
    });
    if (identity?.deliveryId !== undefined) return { ...event, delivery_id: identity.deliveryId };
    if (identity?.intent !== undefined) return { ...event, intent: identity.intent };
    return event;
  };
  const settle = (id: number, callback: (request: Pending) => void) => {
    const request = pending.get(id); if (!request) return;
    pending.delete(id); if (request.timer) clearTimeout(request.timer);
    deliveryIdentity.settle(id);
    callback(request);
  };
  const handleEvent = (message: TransportMessage) => {
    if (!message.params || typeof message.params !== "object") return store.dispatch(adapterError("event params are invalid"));
    const session = typeof message.params.session_id === "string" ? message.params.session_id : undefined;
    if (session !== undefined && quarantined.has(session)) {
      quarantineRevisions.set(session, (quarantineRevisions.get(session) ?? 0) + 1);
      return;
    }
    const turnId = message.params.event === "turn_start" ? (message.params.data as { turn_id?: unknown } | undefined)?.turn_id : undefined;
    if (session !== undefined && typeof turnId === "string") servedTurns.set(session, turnId);
    const sessionStore = eventStore(session);
    for (const event of fromZetaEvent(message.params).map((item) => stampIntent(item, session))) sessionStore.dispatch(event);
  };
  const handleReply = (message: TransportMessage) => {
    if (message.id === null && message.error) {
      if (message.error.code === -32011) {
        const role = message.error.message.includes("observer") ? "observer" : "controller";
        closeReason = { kind: "output_overflow", message: message.error.message, role };
      }
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
  const closeWaiters = new Set<(error: unknown) => void>();
  const attachmentGates = new Map<string, Promise<unknown>>();
  const closeAbort = new AbortController();
  let closed = false;
  let closedError: unknown;
  let closeReason: CloseReason | undefined;
  const closeClient = (code?: number) => {
    if (closed) return;
    const error = closeError?.(handshaken, code, closeReason) ?? new Error("transport closed");
    closed = true;
    closedError = error;
    deliveryIdentity.close();
    pending.forEach((_, id) => settle(id, (request) => request.reject(error)));
    closeAbort.abort(error);
    closeWaiters.forEach((reject) => reject(error));
    closeWaiters.clear();
    attachmentGates.clear();
    cancelLoads();
    closeListeners.forEach((listener) => listener(error));
  };
  transport.onClose?.((code) => { closeClient(code); });
  /** Calls `listener` once when the transport closes, with the same error that rejected pending requests. */
  const onClose = (listener: (error: unknown) => void) => { closeListeners.add(listener); return () => { closeListeners.delete(listener); }; };
  const rawRequest = (method: string, params: Record<string, unknown> = {}, requestOptions: RequestOptions = {}) => {
    if (closed) return Promise.reject(closedError);
    if (!handshaken && method !== "hello") return Promise.reject(new Error("hello required"));
    if (pending.size >= maxPending) return Promise.reject(Object.assign(new Error("too many pending requests"), { code: "pending_limit" }));
    if (requestOptions.signal?.aborted) return Promise.reject(Object.assign(new Error("request aborted"), { name: "AbortError" }));
    return new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      const abort = () => settle(id, (item) => item.reject(Object.assign(new Error("request aborted"), { name: "AbortError" })));
      const item: Pending = { resolve, reject };
      pending.set(id, item);
      deliveryIdentity.track(id, {
        method,
        sessionId: typeof params.session_id === "string" ? params.session_id : undefined,
        intent: requestOptions.intent,
        text: params.text,
        deliveryId: typeof params.delivery_id === "string" ? params.delivery_id : undefined,
      });
      if (requestOptions.signal) requestOptions.signal.addEventListener("abort", abort, { once: true });
      if (requestOptions.timeoutMs !== undefined) item.timer = setTimeout(() => settle(id, (entry) => entry.reject(new Error("request timed out"))), requestOptions.timeoutMs);
      try { transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); }
      catch (error) { settle(id, (entry) => entry.reject(error)); }
    });
  };
  const hostCommandsEnabled = () => options.hostCommands !== undefined && options.hostCommands !== null && negotiatedFeatures.includes("session_host_commands");
  const retryDelay = (delay: number, ...signals: AbortSignal[]) => new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listeners = signals.map((signal) => [signal, () => abort(signal)] as const);
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      listeners.forEach(([signal, listener]) => signal.removeEventListener("abort", listener));
    };
    const abort = (signal: AbortSignal) => {
      cleanup();
      reject(signal.reason ?? Object.assign(new Error("request aborted"), { name: "AbortError" }));
    };
    const alreadyAborted = signals.find((signal) => signal.aborted);
    if (alreadyAborted) return abort(alreadyAborted);
    timer = setTimeout(() => { cleanup(); resolve(); }, delay);
    listeners.forEach(([signal, listener]) => signal.addEventListener("abort", listener, { once: true }));
  });
  const retryBusy = async (request: () => Promise<unknown>, requestOptions: RequestOptions) => {
    for (const delay of [0, 250, 500, 1_000]) {
      if (delay) await retryDelay(delay, ...(requestOptions.signal ? [requestOptions.signal] : []), closeAbort.signal);
      try { return await request(); }
      catch (error) {
        if ((error as { code?: unknown })?.code !== -32004 || delay === 1_000) throw error;
      }
    }
  };
  const performAttachWithRetry = (method: "new_session" | "resume", params: Record<string, unknown>, requestOptions: RequestOptions) =>
    retryBusy(() => performAttach(method, params, requestOptions), requestOptions);
  const performAttach = async (method: "new_session" | "resume", params: Record<string, unknown>, requestOptions: RequestOptions) => {
    const sessionId = method === "resume" && typeof params.session_id === "string" ? params.session_id : null;
    if (closed) throw closedError;
    let supply: Promise<unknown>;
    try {
      supply = Promise.resolve(options.hostCommands!(sessionId)).catch(() => {
        throw new HostCommandError("host_command_supplier_failed", "host command supplier failed");
      });
    } catch {
      supply = Promise.reject(new HostCommandError("host_command_supplier_failed", "host command supplier failed"));
    }
    let rejectClosed!: (error: unknown) => void;
    const closeWait = new Promise<never>((_, reject) => {
      rejectClosed = reject;
      closeWaiters.add(reject);
    });
    const supplied = await Promise.race([supply, closeWait]).finally(() => closeWaiters.delete(rejectClosed));
    if (closed) throw closedError;
    const commands = validateHostCommands(supplied);
    try {
      return await rawRequest(method, { ...params, host_commands: commands }, requestOptions);
    } catch (error) {
      throw redactHostCommandFailure("host_command_request_failed", error);
    }
  };
  const attach = (method: "new_session" | "resume", params: Record<string, unknown>, requestOptions: RequestOptions) => {
    const sessionId = method === "resume" && typeof params.session_id === "string" ? params.session_id : null;
    if (sessionId === null) return performAttachWithRetry(method, params, requestOptions);
    const previous = attachmentGates.get(sessionId);
    const operation = previous?.catch(() => {}).then(() => performAttachWithRetry(method, params, requestOptions))
      ?? performAttachWithRetry(method, params, requestOptions);
    const gate = operation;
    attachmentGates.set(sessionId, gate);
    const clear = () => {
      if (attachmentGates.get(sessionId) === gate) {
        attachmentGates.delete(sessionId);
      }
    };
    gate.then(clear, clear);
    return gate;
  };
  const recoverHostBinding = async (method: string, params: Record<string, unknown>, requestOptions: RequestOptions, error: unknown) => {
    const sessionId = typeof params.session_id === "string" ? params.session_id : null;
    if (!sessionId || typeof params.delivery_id !== "string") throw redactHostCommandFailure("host_binding_recovery_failed", error);
    try {
      await (attachmentGates.get(sessionId) ?? attach("resume", { session_id: sessionId }, requestOptions));
    } catch (recoveryError) {
      if (recoveryError === closedError || recoveryError instanceof HostCommandError) throw recoveryError;
      throw redactHostCommandFailure("host_binding_recovery_failed", recoveryError);
    }
    try {
      return await rawRequest(method, params, requestOptions);
    } catch (retryError) {
      throw redactHostCommandFailure("host_binding_retry_failed", retryError);
    }
  };
  const request = (method: string, params: Record<string, unknown> = {}, requestOptions: RequestOptions = {}) => {
    if (method === "send_images" && typeof params.delivery_id === "string" && !canSendImagesDeliveryId()) {
      params = { ...params };
      delete params.delivery_id;
    }
    if (method === "new_session" || method === "resume") {
      if (hostCommandsEnabled()) return attach(method, params, requestOptions);
      return retryBusy(() => rawRequest(method, params, requestOptions), requestOptions);
    }
    const gate = ["send", "send_images", "steer"].includes(method) ? attachmentGates.get(params.session_id as string) : undefined;
    const result = gate ? gate.then(() => rawRequest(method, params, requestOptions)) : rawRequest(method, params, requestOptions);
    if (!hostCommandsEnabled() || (method !== "send" && method !== "send_images")) return result;
    return result.catch((error) => isHostBindingRequired(error) ? recoverHostBinding(method, params, requestOptions, error) : Promise.reject(error));
  };
  const hello = (requestedFeatures?: string[], role: "controller" | "observer" = "controller"): Promise<HelloResult> => {
    const requested = new Set(requestedFeatures ?? []);
    const features = [...new Set([...(requestedFeatures ?? []), ...(requested.has("delivery_id") ? ["send_images_delivery_id"] : []), ...(options.hostCommands ? ["session_host_commands"] : []), "served_turn_end"])];
    const send = () => request("hello", { protocol_version: "1.2", client_version: "1.2", role, ...(features ? { features } : {}) }) as Promise<HelloResult>;
    return (transport.ready ? transport.ready.then(send) : send()).then((result) => {
      handshaken = true;
      negotiatedProtocol = typeof result.protocol_version === "string" ? result.protocol_version : "1.0";
      const features = result.capabilities?.features;
      negotiatedFeatures = negotiatedProtocol !== "1.0" && Array.isArray(features) && features.every((feature): feature is string => typeof feature === "string") ? features : [];
      if (options.hostCommands && !negotiatedFeatures.includes("session_host_commands") && !warnedHostCommandsUnavailable) {
        warnedHostCommandsUnavailable = true;
        console.warn("session_host_commands was requested but is not offered; host commands are disabled");
      }
      return result;
    });
  };
  const retrySession = (session: string) => {
    const target = stores.get(session);
    return target ? resyncSession(session, target) : Promise.reject(new Error(`session ${session} is not open`));
  };
  const readContent = async (handle: string, options: { signal?: AbortSignal; maxBytes?: number } = {}) => {
    const cap = Math.min(options.maxBytes ?? MAX_CONTENT_BYTES, MAX_CONTENT_BYTES);
    if (!Number.isSafeInteger(cap) || cap < 0) throw new ContentReadError("too_large", "content size limit is invalid");
    try {
      return await readContentChunks(handle, cap, (offset) => request("content_read", { handle, offset }, { signal: options.signal }));
    } catch (error) { return contentReadError(error); }
  };
  return { store, stores, forSession, servedTurn: (sessionId: string) => servedTurns.get(sessionId), replay, replayRevision, finishReplay, retrySession, readContent, request, hello, onClose, get features() { return negotiatedFeatures; }, get protocolVersion() { return negotiatedProtocol; }, get evictionCount() { return evictionCount; }, get hostCommandWaiterCount() { return closeWaiters.size; }, evictSession: evict, close: () => { closeClient(); transport.close(); } };
}
export type ZetaClient = ReturnType<typeof createClient>;
export function connect(transport: Transport, scheduler?: Scheduler, options?: ClientOptions) { return createClient(transport, scheduler, undefined, options); }
export type { RunState };
