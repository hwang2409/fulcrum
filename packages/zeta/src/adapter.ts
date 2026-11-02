import type { Message as CoreMessage, RunEvent } from "@fulcrum/core";
import type { EventParams, Message, ToolCall, ToolResult } from "./wire.js";
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
        { type: "tool_start", tool_call: event.tool_call as ToolCall, data },
      ];
    case "tool_output":
      return [
        {
          type: "tool_output",
          tool_call: event.tool_call as ToolCall,
          output: String(event.output ?? ""),
          data,
        },
      ];
    case "tool_end":
      return [
        {
          type: "tool_end",
          tool_call: event.tool_call as ToolCall,
          tool_result: event.tool_result as ToolResult | undefined,
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
