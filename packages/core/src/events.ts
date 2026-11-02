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
export type ToolView =
  | { kind: "shell"; command: string; cwd?: string; exitCode?: number }
  | { kind: "read"; path: string; range?: { offset?: number; limit?: number } }
  | { kind: "edit"; path: string; diff: string }
  | { kind: "write"; path: string; bytes?: number }
  | { kind: "search"; pattern: string; path?: string; matches?: string[] }
  | { kind: "fetch"; url?: string; query?: string; title?: string; bytes?: number }
  | { kind: "agent"; childRunId?: string; status?: string; description?: string };
export interface ToolResult {
  tool_call_id: string;
  content: string;
  is_error: boolean;
  is_canceled?: boolean;
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
      view?: ToolView;
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
    };
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
  | { type: "tool_start"; tool_call: ToolCall; view?: ToolView; data?: Record<string, unknown> }
  | {
      type: "tool_output";
      tool_call: ToolCall;
      output: string;
      view?: ToolView;
      data?: Record<string, unknown>;
    }
  | {
      type: "tool_end";
      tool_call: ToolCall;
      tool_result?: ToolResult;
      view?: ToolView;
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
  | { type: "unknown"; name: string; data: Record<string, unknown> };
