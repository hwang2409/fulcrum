export type RequestId = string | number;
export type JsonObject = { [key: string]: unknown };
export type ErrorCode = number;
export interface RpcError { code: ErrorCode; message: string; data?: unknown }
export interface RpcRequest<P = JsonObject> { jsonrpc: "2.0"; id: RequestId; method: string; params?: P }
export interface RpcResponse<T = unknown> { jsonrpc: "2.0"; id: RequestId | null; result?: T; error?: RpcError }
export interface RpcNotification<P = JsonObject> { jsonrpc: "2.0"; method: string; params?: P }
export interface ToolCall { id: string; name: string; arguments: JsonObject }
export interface ToolResult { tool_call_id: string; content: string; is_error: boolean; is_canceled?: boolean; content_blocks?: unknown[]; structured_content?: JsonObject }
export type ContentBlock = { type: "text"; text: string; path?: string; size?: number } | { type: "image"; data: string; mimeType: string; path?: string; size?: number } | { type: "thinking"; text: string; signature?: string } | { type: "redacted_thinking"; data: string } | { type: "tool_use"; tool_call: ToolCall };
export interface Message { role: string; content: ContentBlock[]; tool_result?: ToolResult; metadata?: JsonObject }
export interface Approval { request_id: string; tool_call: ToolCall; delegated: boolean; agent_instance_id?: string; [key: string]: unknown }
export interface SessionMetadata { version: number; session_id: string; created_at: string; updated_at: string; provider: string; model: string; cwd: string; [key: string]: unknown }
export type EventParams = { event: string; session_id?: string; data?: JsonObject; [key: string]: unknown };
export type EventNotification = RpcNotification<EventParams> & { method: "event" };
export interface HelloParams { protocol_version: "1.0" | "1.1" | "1.2"; client_version: string; features?: string[] }
export interface HelloResult { protocol_version: string; server?: string; capabilities?: { requests?: string[]; notifications?: string[]; features?: string[] } }
