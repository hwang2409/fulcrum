/**
 * One piece of a message, in order. The known types below are what the default renderer draws; any other type is kept
 * as it is and shown as an unsupported block, so no adapter data is lost. URLs are unchecked here: renderers pass them
 * through `safeUrl` before they become links or images.
 */
export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}
/** Text, as markdown or plain text (the message decides). Adjacent text blocks render as one. */
export interface TextContentBlock extends ContentBlock {
  type: "text";
  text: string;
}
/** The model's reasoning. `redacted` reasoning has no readable text (the provider sent it encrypted). */
export interface ReasoningContentBlock extends ContentBlock {
  type: "reasoning";
  text: string;
  redacted?: boolean;
}
/** A cited source: a web page (`url`) or a document (`mediaType`, `filename`). */
export interface SourceContentBlock extends ContentBlock {
  type: "source";
  kind: "source";
  url?: string;
  mediaType?: string;
  title?: string;
  filename?: string;
}
/** A file the message carries. `size` is in bytes. */
export interface FileContentBlock extends ContentBlock {
  type: "file";
  kind: "file";
  url?: string;
  mediaType?: string;
  title?: string;
  filename?: string;
  size?: number;
}
/** A host-resolved content source. `key` must be unique for the loader that resolves it. */
export interface LazyContentSource { kind: "lazy"; key: string }
/** Any content block whose bytes are resolved by its host instead of stored in run state. */
export type LazyContentBlock = ContentBlock & { source: LazyContentSource };
/** An image. `width` and `height` (pixels) let the renderer reserve its exact shape before it loads. `size` is in bytes. */
export interface ImageContentBlock extends ContentBlock {
  type: "image";
  url?: string;
  source?: LazyContentSource;
  mediaType?: string;
  alt?: string;
  filename?: string;
  width?: number;
  height?: number;
  size?: number;
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
  /** Adapter metadata for bounded wire projections. */
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
  /** What the result carries beside its text, such as images, in order. Renderers show them under the output. */
  blocks?: ContentBlock[];
  /** A retained structured result was bounded by the wire. */
  truncated?: boolean;
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
/** How an approval ended. Adapters map their harness's words (zeta's "allow") onto these; leave it unset when unknown. */
export type ApprovalDecision = "approve" | "deny" | "abort";
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
      /** Text streaming in after `message.content`: the message reads as its content blocks, then this text. */
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
/** What is known about how a run ended. `unknown` means transport loss prevented the adapter from observing it. */
export type RunEndOutcome = "unknown";
export type RunEvent =
  | {
      type:
        | "run_start"
        | "turn_start"
        | "turn_end"
        | "message_start"
        | "message_reset";
      data?: Record<string, unknown>;
    }
  | { type: "run_end"; outcome?: RunEndOutcome; data?: Record<string, unknown> }
  /** Streams text into a message. A `kind` other than text ("reasoning") streams into its own block of that type. */
  | { type: "message_delta"; message_id?: string; delta: string; kind?: string }
  /** Adds a whole block (a source, a file, an image) to the streaming message, after what it has so far. */
  | { type: "message_block"; message_id?: string; block: ContentBlock }
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
      /** Temporary adapter-supplied state while the request cannot accept a decision. */
      state?: "reconnecting" | "resolving";
      status?: string;
      disabled_reason?: string;
    }
  | { type: "approval_end"; request_id: string; decision?: ApprovalDecision; data?: Record<string, unknown> }
  | { type: "usage"; usage: Record<string, number> }
  | {
      type: "user_message";
      text: string;
      mode: string;
      attachments?: ContentBlock[];
      /** The harness's stable identity for this message, when replay supplies one. */
      message_id?: string;
      /** The server's durable identity for this accepted message, when client delivery IDs were negotiated. */
      delivery_id?: string;
      /**
       * The client's identity for the user intent this message carries out. A later user message with the same intent
       * replaces the earlier row in place instead of adding one: a steer the harness dropped and the client resent as
       * a new message stays one row. Leave it unset when the transport cannot tell; every message is then its own row.
       */
      intent?: string;
      delivery_status?: "delivered" | "dropped";
      delivery_reason?: string;
    }
  | { type: "delivery_status"; delivery_id: string; method: string; status: "delivered" | "dropped"; content: string; reason?: string }
  | { type: "history_truncated"; text: string }
  /** `code: "aborted"` means the user stopped the run (a stop, not a failure); parts show it as a neutral "stopped". */
  | { type: "error"; error: { code: string; message: string } }
  | {
      type: "notification";
      notification_id?: string;
      data?: Record<string, unknown>;
    }
  | { type: "unknown"; name: string; data: Record<string, unknown> }
  | SubAgentEvent;
