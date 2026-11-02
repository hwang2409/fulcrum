import { createRunStore, type Scheduler, type RunState } from "@fulcrum/core";
import { fromZetaEvent } from "./adapter.js";
import type {
  EventParams,
  HelloResult,
  RpcError,
  TransportMessage,
} from "./wire.js";
import type { Transport } from "./transport.js";
export function createClient(
  transport: Transport,
  scheduler?: Scheduler,
  closeError?: (handshaken: boolean, code?: number) => unknown,
) {
  let nextId = 1;
  let handshaken = false;
  let negotiatedFeatures: string[] = [];
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  const stores = new Map<string, ReturnType<typeof createRunStore>>();
  const store = createRunStore(undefined, scheduler);
  const forSession = (session?: string) => {
    if (!session) return store;
    let value = stores.get(session);
    if (!value) {
      value = createRunStore(undefined, scheduler);
      stores.set(session, value);
    }
    return value;
  };
  transport.onMessage((text) => {
    const message = JSON.parse(text) as TransportMessage;
    if (message.method === "event" && message.params) {
      for (const event of fromZetaEvent(message.params))
        forSession(message.params.session_id).dispatch(event);
      return;
    }
    if (message.id === null && message.error) {
      const error = Object.assign(new Error(message.error.message), message.error);
      pending.forEach((request) => request.reject(error));
      pending.clear();
      return;
    }
    if (typeof message.id !== "number") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error)
      request.reject(
        Object.assign(new Error(message.error.message), message.error),
      );
    else request.resolve(message.result);
  });
  const rejectPending = (code?: number) => {
    const error = closeError?.(handshaken, code) ?? new Error("transport closed");
    pending.forEach((request) => request.reject(error));
    pending.clear();
  };
  transport.onClose?.(rejectPending);
  const request = (method: string, params: Record<string, unknown> = {}) => {
    if (!handshaken && method !== "hello")
      return Promise.reject(new Error("hello required"));
    return new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      try {
        transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  };
  const hello = (requestedFeatures?: string[]): Promise<HelloResult> => {
    const send = () =>
      request("hello", {
        protocol_version: "1.0",
        client_version: "1.2",
        ...(requestedFeatures ? { features: requestedFeatures } : {}),
      }) as Promise<HelloResult>;
    const response = transport.ready ? transport.ready.then(send) : send();
    return response.then((result) => {
      handshaken = true;
      negotiatedFeatures = result.capabilities?.features ?? [];
      return result;
    });
  };
  return {
    store,
    stores,
    forSession,
    request,
    hello,
    get features() {
      return negotiatedFeatures;
    },
    close: () => {
      rejectPending();
      transport.close();
    },
  };
}
export function connect(transport: Transport, scheduler?: Scheduler) {
  return createClient(transport, scheduler);
}
export type { RunState, EventParams, RpcError, HelloResult };
