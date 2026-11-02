export type RequestId = string | number;
export type JsonObject = { [key: string]: unknown };
export interface RpcError { code: number; message: string; data?: unknown }
export interface TransportMessage { jsonrpc: "2.0"; id?: RequestId | null; method?: string; params?: EventParams; result?: unknown; error?: RpcError }
export interface EventParams { event: string; session_id?: string; data?: JsonObject; [key: string]: unknown }
export interface HelloResult { protocol_version: string; server?: string; capabilities?: { requests?: string[]; notifications?: string[]; features?: string[] } }
export interface ToolCall { id: string; name: string; arguments: JsonObject }
export interface ToolResult { tool_call_id: string; content: string; is_error: boolean; is_canceled?: boolean; [key: string]: unknown }
export interface Message { role: string; content: Array<Record<string, unknown>>; tool_result?: ToolResult; metadata?: JsonObject }
