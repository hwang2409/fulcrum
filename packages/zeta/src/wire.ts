export type RequestId = string | number;
export type JsonObject = { [key: string]: unknown };
export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}
export interface TransportMessage {
  jsonrpc: "2.0";
  id?: RequestId | null;
  method?: string;
  params?: EventParams;
  result?: unknown;
  error?: RpcError;
}
export interface EventParams {
  event: string;
  session_id?: string;
  stream_id?: string;
  seq?: number;
  data?: JsonObject;
  [key: string]: unknown;
}
export type HistoryValidator = {
  readonly end: number;
  readonly entry_id: string | null;
  readonly [field: string]: unknown;
};
export type PendingApproval = {
  readonly request_id: string;
  readonly tool_call: ToolCall;
  readonly delegated: boolean;
  readonly agent_instance_id?: string;
  readonly label?: string;
  readonly resolution_pending?: "approve" | "deny" | "expire" | "abort";
};
export type JoinStatus = {
  readonly state: "idle" | "running" | "tool";
  readonly pending_approvals: readonly PendingApproval[];
  readonly pending_approvals_truncated?: boolean;
};
export type SessionReplayJoinResult = {
  readonly messages: readonly unknown[];
  readonly next_before: number | null;
  readonly history_validator: HistoryValidator;
  readonly replay: { readonly stream_id: string; readonly history_seq: number };
  readonly status: JoinStatus & { readonly pending_approvals_truncated: boolean };
};

const optionalString = (value: unknown) => value === undefined || typeof value === "string";
const pendingApproval = (value: unknown): PendingApproval | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const tool = row.tool_call as Record<string, unknown> | null;
  if (typeof row.request_id !== "string" || row.request_id.length === 0 || typeof row.delegated !== "boolean" ||
      !tool || Array.isArray(tool) || typeof tool.id !== "string" || tool.id.length === 0 ||
      typeof tool.name !== "string" || tool.name.length === 0 || !tool.arguments ||
      typeof tool.arguments !== "object" || Array.isArray(tool.arguments) ||
      !optionalString(row.agent_instance_id) || !optionalString(row.label) ||
      (row.resolution_pending !== undefined && !["approve", "deny", "expire", "abort"].includes(row.resolution_pending as string))) return null;
  return row as PendingApproval;
};

/** Parses the status projection shared by ordinary status and sequenced replay joins. */
export function parseJoinStatus(value: unknown): JoinStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if ((row.state !== "idle" && row.state !== "running" && row.state !== "tool") ||
      !Array.isArray(row.pending_approvals) ||
      (row.pending_approvals_truncated !== undefined && typeof row.pending_approvals_truncated !== "boolean")) return null;
  const approvals = row.pending_approvals.map(pendingApproval);
  if (approvals.some((approval) => approval === null)) return null;
  return {
    state: row.state,
    pending_approvals: approvals as PendingApproval[],
    ...(row.pending_approvals_truncated === undefined ? {} : { pending_approvals_truncated: row.pending_approvals_truncated as boolean }),
  };
}
export interface HelloResult {
  protocol_version: string;
  server?: string;
  capabilities?: {
    requests?: string[];
    notifications?: string[];
    features?: string[];
  };
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
}
export interface ToolResult {
  tool_call_id: string;
  content: string;
  is_error: boolean;
  is_canceled?: boolean;
  [key: string]: unknown;
}
export interface Message {
  role: string;
  content: Array<Record<string, unknown>>;
  tool_result?: ToolResult;
  metadata?: JsonObject;
}

export type ServedTurnEndReason = "completed" | "user_stop" | "error" | "disconnect";
export type ServedTurnEnd = { turn_id: string; reason: ServedTurnEndReason };
