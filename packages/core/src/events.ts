export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}
export interface SourceContentBlock extends ContentBlock {
  type: "source";
  kind: "source";
  url?: string;
  mediaType?: string;
  title?: string;
  filename?: string;
}
export interface FileContentBlock extends ContentBlock {
  type: "file";
  kind: "file";
  url?: string;
  mediaType?: string;
  title?: string;
  filename?: string;
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
  meta?: Record<string, unknown>;
}
/**
 * The agent-neutral view of a tool call. Harness tool maps produce it; renderers pick a card by `kind`. No view means
 * the generic card. `read.range.offset` is the number of lines skipped (0-based), `limit` the number of lines read.
 * `edit.diff` is a unified diff (`lineDiff` writes one from old and new text). `shell.stdout`/`stderr` are the split
 * streams when the harness reports them; the card then shows them instead of the combined output. `fetch.contentType`
 * is the response's Content-Type header; the card highlights the body by it.
 */
export type ToolView = (
  | { kind: "shell"; command: string; cwd?: string; exitCode?: number; stdout?: string; stderr?: string }
  | { kind: "read"; path: string; range?: { offset?: number; limit?: number } }
  | { kind: "edit"; path: string; diff: string }
  | { kind: "write"; path: string; content?: string; bytes?: number }
  | { kind: "search"; pattern: string; path?: string; matches?: string[] }
  | ({ kind: "fetch"; title?: string; bytes?: number; status?: number; contentType?: string } & ({ url: string; query?: never } | { query: string; url?: never }))
) & { durationMs?: number };
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
  /** The worker or preset label, for example "reviewer". */
  name?: string;
  /** The delegated task, one line. */
  task?: string;
  /** The newest progress line, for example "$ bun test". */
  latestActivity?: string;
  /** Tool calls the child started so far. It never goes down. */
  toolCount?: number;
  summary?: string;
  urgency?: SubAgentUrgency;
  notificationId?: string;
  startedAt?: string;
  updatedAt?: string;
  endedAt?: string;
  sequence?: number;
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
      /** The end of this call's approval, once it resolved: the approval's row folds into the tool's row. */
      approval?: RunEvent;
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
  | { type: "tool_start"; tool_call: ToolCall; view?: ToolView; data?: Record<string, unknown> }
  | { type: "tool_input"; tool_call: ToolCall; input: string; view?: ToolView; data?: Record<string, unknown> }
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
      view?: ToolView;
      delegated: boolean;
    }
  | { type: "approval_end"; request_id: string; data?: Record<string, unknown> }
  | { type: "usage"; usage: Record<string, number> }
  | {
      type: "user_message";
      text: string;
      mode: string;
      attachments?: unknown[];
      /**
       * The client's identity for the user intent this message carries out. A later user message with the same intent
       * replaces the earlier row in place instead of adding one: a steer the harness dropped and the client resent as
       * a new message stays one row. Leave it unset when the transport cannot tell; every message is then its own row.
       */
      intent?: string;
    }
  /** `code: "aborted"` means the user stopped the run (a stop, not a failure); parts show it as a neutral "stopped". */
  | { type: "error"; error: { code: string; message: string } }
  | {
      type: "notification";
      notification_id?: string;
      data?: Record<string, unknown>;
    }
  | { type: "unknown"; name: string; data: Record<string, unknown> }
  | SubAgentEvent;
