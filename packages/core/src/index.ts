export type RunEvent =
  | { type: "run_start" | "run_end" | "turn_start" | "turn_end" | "message_start" | "message_reset"; data?: Record<string, unknown> }
  | { type: "message_delta"; message_id?: string; delta: string; kind?: string }
  | { type: "retry" }
  | { type: "message_commit"; message_id?: string; message: Message }
  | { type: "tool_start"; tool_call: ToolCall; data?: Record<string, unknown> }
  | { type: "tool_output"; tool_call: ToolCall; output: string; data?: Record<string, unknown> }
  | { type: "tool_end"; tool_call: ToolCall; tool_result?: ToolResult; data?: Record<string, unknown> }
  | { type: "approval_request"; request_id: string; tool_call: ToolCall; delegated: boolean }
  | { type: "approval_end"; request_id: string; data?: Record<string, unknown> }
  | { type: "usage"; usage: Record<string, number> }
  | { type: "user_message"; text: string; mode: string; attachments?: unknown[] }
  | { type: "error"; error: { code: string; message: string } }
  | { type: "notification"; notification_id?: string; data?: Record<string, unknown> }
  | { type: "unknown"; name: string; data?: Record<string, unknown> };
export interface ContentBlock { type: string; [key: string]: unknown }
export interface Message { role: string; content: ContentBlock[]; tool_result?: ToolResult; metadata?: Record<string, unknown> }
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
export interface ToolResult { tool_call_id: string; content: string; is_error: boolean; is_canceled?: boolean }


export interface RunItem { id: string; type: string; [key: string]: unknown }
export interface RunState {
  turns: string[]; items: string[]; itemsById: Record<string, RunItem>;
  messagesById: Record<string, Message & { chunks?: string[] }>;
  toolCallsById: Record<string, { tool_call: ToolCall; outputs: string[]; result?: ToolResult; is_error: boolean; canceled: boolean }>;
  approvalsById: Record<string, { request: RunEvent; ended?: RunEvent; delegated: boolean }>;
  usage: Record<string, number>; userMessages: Array<{ text: string; mode: string; attachments?: unknown[] }>;
  errors: Array<{ code: string; message: string }>; agent: "idle" | "running"; turn: "idle" | "running"; childNotifications: RunEvent[]; receipts: Record<string, true>;
}
export const initialState: RunState = { turns: [], items: [], itemsById: {}, messagesById: {}, toolCallsById: {}, approvalsById: {}, usage: {}, userMessages: [], errors: [], agent: "idle", turn: "idle", childNotifications: [], receipts: {} };
const eventOf = (input: RunEvent | { params?: RunEvent }): RunEvent => ("params" in input && input.params ? input.params : input) as RunEvent;
const item = (state: RunState, value: RunItem): RunState => ({ ...state, items: [...state.items, value.id], itemsById: { ...state.itemsById, [value.id]: value } });
export function reduce(state: RunState = initialState, input: RunEvent | { params?: RunEvent }): RunState {
  const e = eventOf(input) as any; const id = e.type === "notification" && typeof e.notification_id === "string" ? e.notification_id : typeof e.data?.notification_id === "string" ? e.data.notification_id : undefined;
  if (id && state.receipts[id]) return state;
  let next = state;
  if (id) next = { ...next, receipts: { ...next.receipts, [id]: true } };
  switch (e.type) {
    case "run_start": next = { ...next, agent: "running" }; break;
    case "run_end": next = { ...next, agent: "idle", turn: "idle" }; break;
    case "turn_start": next = { ...next, turn: "running", turns: [...next.turns, String(e.data?.turn ?? next.turns.length + 1)] }; break;
    case "turn_end": next = { ...next, turn: "idle" }; break;
    case "message_delta": { const mid = String(e.message_id ?? "assistant"); const old = next.messagesById[mid]; const message = old ? { ...old, chunks: [...(old.chunks ?? []), e.delta] } : { role: "assistant", content: [], chunks: [e.delta] }; next = { ...next, messagesById: { ...next.messagesById, [mid]: message } }; break; }
    case "message_commit": { const mid = String(e.message_id ?? "assistant"); const message = e.message; next = { ...next, messagesById: { ...next.messagesById, [mid]: message }, items: next.items.includes(mid) ? next.items : [...next.items, mid] }; break; }
    case "message_reset": { const messages = { ...next.messagesById }; for (const [k, v] of Object.entries(messages)) if (v.chunks) delete messages[k]; next = { ...next, messagesById: messages }; break; }
    case "retry": next = { ...next, errors: next.errors }; break;
    case "tool_start": { const id = e.tool_call.id; next = { ...next, toolCallsById: { ...next.toolCallsById, [id]: { tool_call: e.tool_call, outputs: [], is_error: false, canceled: false } } }; break; }
    case "tool_output": { const old = next.toolCallsById[e.tool_call.id] ?? { tool_call: e.tool_call, outputs: [], is_error: false, canceled: false }; next = { ...next, toolCallsById: { ...next.toolCallsById, [e.tool_call.id]: { ...old, outputs: [...old.outputs, e.output] } } }; break; }
    case "tool_end": { const old = next.toolCallsById[e.tool_call.id] ?? { tool_call: e.tool_call, outputs: [], is_error: false, canceled: false }; const result = e.tool_result; next = { ...next, toolCallsById: { ...next.toolCallsById, [e.tool_call.id]: { ...old, result, is_error: result?.is_error ?? false, canceled: result?.is_canceled ?? false } } }; break; }
    case "approval_request": next = { ...next, approvalsById: { ...next.approvalsById, [e.request_id]: { request: e, delegated: e.delegated } } }; break;
    case "approval_end": { const old = next.approvalsById[e.request_id]; if (old) next = { ...next, approvalsById: { ...next.approvalsById, [e.request_id]: { ...old, ended: e } } }; break; }
    case "usage": { const usage = { ...next.usage }; for (const [k, v] of Object.entries(e.usage)) usage[k] = (usage[k] ?? 0) + Number(v); next = { ...next, usage }; break; }
    case "user_message": next = { ...next, userMessages: [...next.userMessages, { text: e.text, mode: e.mode, attachments: e.attachments }] }; break;
    case "error": next = { ...next, errors: [...next.errors, e.error] }; break;
    case "notification": case "unknown": next = { ...next, childNotifications: [...next.childNotifications, e] }; break;
  }
  return next;
}

export type Scheduler = (cb: () => void) => void;
const defaultScheduler: Scheduler = cb => typeof requestAnimationFrame === "function" ? requestAnimationFrame(cb) : queueMicrotask(cb);
export function createRunStore(initial: RunState = initialState, scheduler: Scheduler = defaultScheduler) { let state = initial; const listeners = new Set<() => void>(); let queued = false; return { getState: () => state, subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }, dispatch(event: RunEvent | { params?: RunEvent }) { state = reduce(state, event); if (!queued) { queued = true; scheduler(() => { queued = false; for (const fn of listeners) fn(); }); } return state; } }; }

