export * from "./protocol.js";
import type { EventParams, RpcError, HelloResult, ToolCall, ToolResult, Message } from "./protocol.js";
import type { RunEvent, RunState } from "@fulcrum/core";
import { createRunStore, type Scheduler } from "@fulcrum/core";
export { createRunStore } from "@fulcrum/core";

export function fromZetaEvent(e: EventParams): RunEvent[] {
  switch (e.event) {
    case "agent_start": return [{ type: "run_start", data: e.data }];
    case "agent_end": return [{ type: "run_end", data: e.data }];
    case "turn_start": return [{ type: "turn_start", data: e.data }];
    case "turn_end": return [{ type: "turn_end", data: e.data }];
    case "message_start": return [{ type: "message_start", data: e.data }];
    case "assistant_delta": return [{ type: "message_delta", message_id: String(e.data?.message_id ?? "assistant"), delta: String(e.delta ?? ""), kind: String(e.kind ?? "assistant") }];
    case "assistant_message": return [{ type: "message_commit", message_id: String(e.data?.message_id ?? "assistant"), message: e.message as Message }];
    case "assistant_reset": case "retry": return [{ type: e.event === "retry" ? "retry" : "message_reset" }];
    case "tool_start": return [{ type: "tool_start", tool_call: e.tool_call as ToolCall, data: e.data }];
    case "tool_output": return [{ type: "tool_output", tool_call: e.tool_call as ToolCall, output: String(e.output ?? ""), data: e.data }];
    case "tool_end": return [{ type: "tool_end", tool_call: e.tool_call as ToolCall, tool_result: e.tool_result as ToolResult | undefined, data: e.data }];
    case "approval_request": return [{ type: "approval_request", request_id: String(e.request_id), tool_call: e.tool_call as ToolCall, delegated: Boolean(e.delegated) }];
    case "approval_end": return [{ type: "approval_end", request_id: String(e.request_id), data: e.data }];
    case "usage": return [{ type: "usage", usage: e.usage as Record<string, number> }];
    case "user_message": return [{ type: "user_message", text: String(e.text), mode: String(e.mode), attachments: e.attachments as unknown[] }];
    case "error": return [{ type: "error", error: e.error as { code: string; message: string } }];
    case "sub_agent_receipt": case "task_exit_notification": case "project_inbox_notification": case "child_question": case "child_question_withdrawn": case "child_idle": case "child_message_delivered": case "notification_by_kind": return [{ type: "notification", notification_id: typeof e.data?.notification_id === "string" ? e.data.notification_id : undefined, data: e.data }];
    default: return [{ type: "unknown", name: e.event, data: e.data }];
  }
}
export interface Transport { send(text: string): void; onMessage(cb: (text: string) => void): void; onClose?(cb: () => void): void; close(): void }
export function createClient(transport: Transport, store = createRunStore()) { let nextId = 1; const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>(); transport.onMessage(text => { const msg = JSON.parse(text) as { method?: string; params?: EventParams; id?: number; result?: unknown; error?: RpcError }; if (msg.method === "event" && msg.params) { for (const event of fromZetaEvent(msg.params)) store.dispatch(event); return; } if (typeof msg.id === "number") { const p = pending.get(msg.id); if (!p) return; pending.delete(msg.id); msg.error ? p.reject(Object.assign(new Error(msg.error.message), msg.error)) : p.resolve(msg.result); } }); const rejectPending = () => { const error = new Error("transport closed"); for (const p of pending.values()) p.reject(error); pending.clear(); }; transport.onClose?.(rejectPending); const request = (method: string, params: Record<string, unknown> = {}) => new Promise<unknown>((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); }); const hello = (features?: string[]) => request("hello", { protocol_version: "1.0", client_version: "1.2", ...(features ? { features } : {}) }) as Promise<HelloResult>; const close = () => { rejectPending(); transport.close(); }; return { store, request, hello, close }; }
export function connect(transport: Transport) { return createClient(transport); }
export function webSocketTransport(url: string): Transport { const ws = new WebSocket(url); let callback: ((text: string) => void) | undefined; let closed: (() => void) | undefined; ws.addEventListener("message", e => callback?.(String(e.data))); ws.addEventListener("close", () => closed?.()); return { send: text => ws.send(text), onMessage: cb => { callback = cb; }, onClose: cb => { closed = cb; }, close: () => ws.close() }; }
