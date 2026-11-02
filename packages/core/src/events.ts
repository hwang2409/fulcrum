export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}
export interface Message {
  role: string;
  content: ContentBlock[];
  tool_result?: ToolResult;
  metadata?: Record<string, unknown>;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface ToolResult {
  tool_call_id: string;
  content: string;
  is_error: boolean;
  is_canceled?: boolean;
}
export type SubAgentStatus =
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "idle"
  | "done"
  | "error"
  | "canceled";
export type SubAgentUrgency = "approval" | "input" | "error";
export interface SubAgentEvent {
  type: "sub_agent";
  childRunId: string;
  status: SubAgentStatus;
  summary?: string;
  urgency?: SubAgentUrgency;
  notificationId?: string;
  startedAt?: string;
  updatedAt?: string;
  endedAt?: string;
}
export type RunItem =
  | {
      id: string;
      type: "message";
      message: Message;
      version: number;
      active: boolean;
      text?: string;
    }
  | {
      id: string;
      type: "tool";
      tool_call: ToolCall;
      output: string;
      version: number;
      active: boolean;
      result?: ToolResult;
      is_error: boolean;
      canceled: boolean;
    }
  | { id: string; type: "approval"; request: RunEvent; ended?: RunEvent }
  | {
      id: string;
      type: "user" | "error" | "notification" | "unknown";
      event: RunEvent;
    }
  | ({ id: string } & SubAgentEvent);
export type RunEvent =
  | {
      type:
        | "run_start"
        | "run_end"
        | "turn_start"
        | "turn_end"
        | "message_start"
        | "message_reset";
      data?: Record<string, unknown>;
    }
  | { type: "message_delta"; message_id?: string; delta: string; kind?: string }
  | { type: "retry" }
  | { type: "message_commit"; message_id?: string; message: Message }
  | { type: "tool_start"; tool_call: ToolCall; data?: Record<string, unknown> }
  | {
      type: "tool_output";
      tool_call: ToolCall;
      output: string;
      data?: Record<string, unknown>;
    }
  | {
      type: "tool_end";
      tool_call: ToolCall;
      tool_result?: ToolResult;
      data?: Record<string, unknown>;
    }
  | {
      type: "approval_request";
      request_id: string;
      tool_call: ToolCall;
      delegated: boolean;
    }
  | { type: "approval_end"; request_id: string; data?: Record<string, unknown> }
  | { type: "usage"; usage: Record<string, number> }
  | {
      type: "user_message";
      text: string;
      mode: string;
      attachments?: unknown[];
    }
  | { type: "error"; error: { code: string; message: string } }
  | {
      type: "notification";
      notification_id?: string;
      data?: Record<string, unknown>;
    }
  | { type: "unknown"; name: string; data: Record<string, unknown> }
  | SubAgentEvent;
