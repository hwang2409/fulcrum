import type { Message as CoreMessage, RunEvent, ToolView } from "@fulcrum/core";
import type { EventParams, Message, ToolCall, ToolResult } from "./wire.js";

const text = (value: unknown) => typeof value === "string" ? value : undefined;
const number = (value: unknown) => typeof value === "number" ? value : undefined;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const diffLines = (prefix: string, value: string) =>
  value.replace(/\n$/, "").split("\n").map((line) => `${prefix}${line}`).join("\n");
const editDiff = (path: string, args: Record<string, unknown>) => {
  const edits = Array.isArray(args.edits) ? args.edits.map(record).filter(Boolean) : [args];
  const hunks = edits.map((edit) => {
    const oldString = text(edit?.old_string) ?? "";
    const newString = text(edit?.new_string) ?? "";
    return `@@\n${diffLines("-", oldString)}\n${diffLines("+", newString)}`;
  });
  return `--- a/${path}\n+++ b/${path}\n${hunks.join("\n")}` + (hunks.length ? "\n" : "");
};

/** Translate zeta-specific arguments and structured results at the adapter seam. */
export function zetaToolView(call: ToolCall, result?: ToolResult): ToolView | undefined {
  const args = call.arguments;
  const structured = record(result?.structured_content);
  switch (call.name) {
    case "bash": {
      const command = text(args.command) ?? text(args.cmd);
      if (!command) return undefined;
      return { kind: "shell", command, ...(text(args.cwd) ? { cwd: text(args.cwd) } : {}), ...(number(structured?.exit_code) !== undefined ? { exitCode: number(structured?.exit_code) } : {}) };
    }
    case "read": {
      const path = text(args.path);
      if (!path) return undefined;
      const offset = number(args.offset);
      const limit = number(args.limit);
      return { kind: "read", path, ...(offset !== undefined || limit !== undefined ? { range: { ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) } } : {}) };
    }
    case "edit": {
      const path = text(args.path);
      return path ? { kind: "edit", path, diff: editDiff(path, args) } : undefined;
    }
    case "write": {
      const path = text(args.path);
      const content = text(args.content);
      return path ? { kind: "write", path, ...(content !== undefined ? { bytes: new TextEncoder().encode(content).byteLength } : {}) } : undefined;
    }
    case "grep":
    case "glob": {
      const pattern = text(args.pattern);
      return pattern ? { kind: "search", pattern, ...(text(args.path) ? { path: text(args.path) } : {}) } : undefined;
    }
    case "fetch": {
      const url = text(args.url);
      return url ? { kind: "fetch", url } : undefined;
    }
    case "websearch": {
      const query = text(args.query);
      return query ? { kind: "fetch", query } : undefined;
    }
    case "agent": {
      const childRunId = text(structured?.child_instance_id);
      const status = text(structured?.status);
      const description = text(structured?.description) ?? text(args.description);
      return { kind: "agent", ...(childRunId ? { childRunId } : {}), ...(status ? { status } : {}), ...(description ? { description } : {}) };
    }
    default:
      return undefined;
  }
}

const toolCall = (event: EventParams) => event.tool_call as ToolCall;

export function fromZetaEvent(event: EventParams): RunEvent[] {
  const data = event.data ?? {};
  switch (event.event) {
    case "agent_start":
      return [{ type: "run_start", data }];
    case "agent_end":
      return [{ type: "run_end", data }];
    case "turn_start":
      return [{ type: "turn_start", data }];
    case "turn_end":
      return [{ type: "turn_end", data }];
    case "message_start":
      return [{ type: "message_start", data }];
    case "assistant_delta":
      return [
        {
          type: "message_delta",
          message_id:
            typeof data.message_id === "string" ? data.message_id : undefined,
          delta: String(event.delta ?? ""),
          kind: String(event.kind ?? "assistant"),
        },
      ];
    case "assistant_message":
      return [
        {
          type: "message_commit",
          message_id:
            typeof data.message_id === "string" ? data.message_id : undefined,
          message: event.message as unknown as CoreMessage,
        },
      ];
    case "assistant_reset":
      return [{ type: "message_reset", data }];
    case "retry":
      return [{ type: "retry" }];
    case "tool_start":
      return [
        { type: "tool_start", tool_call: toolCall(event), view: zetaToolView(toolCall(event)), data },
      ];
    case "tool_output":
      return [
        {
          type: "tool_output",
          tool_call: toolCall(event),
          output: String(event.output ?? ""),
          view: zetaToolView(toolCall(event)),
          data,
        },
      ];
    case "tool_end":
      return [
        {
          type: "tool_end",
          tool_call: toolCall(event),
          tool_result: event.tool_result as ToolResult | undefined,
          view: zetaToolView(toolCall(event), event.tool_result as ToolResult | undefined),
          data,
        },
      ];
    case "approval_request":
      return [
        {
          type: "approval_request",
          request_id: String(event.request_id),
          tool_call: event.tool_call as ToolCall,
          delegated: Boolean(event.delegated),
        },
      ];
    case "approval_end":
      return [
        { type: "approval_end", request_id: String(event.request_id), data },
      ];
    case "usage":
      return [{ type: "usage", usage: event.usage as Record<string, number> }];
    case "user_message":
      return [
        {
          type: "user_message",
          text: String(event.text),
          mode: String(event.mode),
          attachments: event.attachments as unknown[] | undefined,
        },
      ];
    case "error":
      return [
        {
          type: "error",
          error: event.error as { code: string; message: string },
        },
      ];
    case "turn_aborted":
      return [
        {
          type: "error",
          error: {
            code: "turn_aborted",
            message: String(event.message ?? "turn aborted"),
          },
        },
      ];
    case "sub_agent_receipt":
    case "task_exit_notification":
    case "project_inbox_notification":
    case "child_question":
    case "child_question_withdrawn":
    case "child_idle":
    case "child_message_delivered":
    case "notification_by_kind":
      return [
        {
          type: "notification",
          notification_id:
            typeof data.notification_id === "string"
              ? data.notification_id
              : undefined,
          data: { ...event, data },
        },
      ];
    case "memory_updated":
    case "compaction_start":
    case "compaction_end":
    case "account_limit":
    case "account_state_unknown":
      return [{ type: "unknown", name: event.event, data: { ...event, data } }];
    default:
      return [{ type: "unknown", name: event.event, data: { ...event, data } }];
  }
}
