import type { Message as CoreMessage, RunEvent } from "@fulcrum/core";
import type { EventParams, Message, ToolCall, ToolResult } from "./wire.js";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const string = (value: unknown) => typeof value === "string" ? value : undefined;
const requiredString = (value: unknown, name: string) => {
  const result = string(value);
  if (!result) throw new Error(`${name} must be a string`);
  return result;
};
const dataOf = (event: Record<string, unknown>) => object(event.data) ?? {};
const tool = (value: unknown): ToolCall => {
  const valueObject = object(value);
  if (!valueObject) throw new Error("tool_call must be an object");
  return { id: requiredString(valueObject.id, "tool_call.id"), name: requiredString(valueObject.name, "tool_call.name"), arguments: object(valueObject.arguments) ?? (() => { throw new Error("tool_call.arguments must be an object"); })() };
};
const message = (value: unknown): Message => {
  const valueObject = object(value);
  if (!valueObject || typeof valueObject.role !== "string" || !Array.isArray(valueObject.content)) throw new Error("message is invalid");
  return valueObject as unknown as Message;
};
const invalid = (error: unknown): RunEvent[] => [{ type: "error", error: { code: "adapter_invalid_payload", message: error instanceof Error ? error.message : "invalid zeta payload" } }];

export function decodeZetaEvent(value: unknown): EventParams | RunEvent[] {
  try {
    const event = object(value);
    if (!event) throw new Error("event must be an object");
    const name = requiredString(event.event, "event");
    if (event.data !== undefined && !object(event.data)) throw new Error("data must be an object");
    const data = dataOf(event);
    const session_id = string(event.session_id);
    const result: EventParams = { ...event, event: name, data };
    switch (name) {
      case "assistant_delta": requiredString(event.delta, "delta"); break;
      case "assistant_message": message(event.message); break;
      case "tool_start": case "tool_end": tool(event.tool_call); break;
      case "tool_output": tool(event.tool_call); requiredString(event.output, "output"); break;
      case "approval_request": requiredString(event.request_id, "request_id"); tool(event.tool_call); if (typeof event.delegated !== "boolean") throw new Error("delegated must be boolean"); break;
      case "approval_end": requiredString(event.request_id, "request_id"); break;
      case "usage": { const usage = object(event.usage); if (!usage || Object.values(usage).some((v) => typeof v !== "number")) throw new Error("usage must contain numbers"); break; }
      case "user_message": requiredString(event.text, "text"); requiredString(event.mode, "mode"); break;
      case "error": { const error = object(event.error); if (!error || typeof error.code !== "string" || typeof error.message !== "string") throw new Error("error is invalid"); break; }
      case "sub_agent_receipt": case "child_idle": case "task_exit_notification": case "child_question": case "child_question_withdrawn": case "child_message_delivered": {
        if (!string(data.agent_instance_id) && !string(data.child_id) && !string(data.task_id) && !string(data.question_id) && !string(data.message_id)) throw new Error("child event has no child id");
        break;
      }
    }
    return result;
  } catch (error) { return invalid(error); }
}

export function fromZetaEvent(event: EventParams | unknown): RunEvent[] {
  const decoded = decodeZetaEvent(event);
  if (Array.isArray(decoded)) return decoded;
  const data = decoded.data ?? {};
  switch (decoded.event) {
    case "agent_start": return [{ type: "run_start", data }];
    case "agent_end": return [{ type: "run_end", data }];
    case "turn_start": return [{ type: "turn_start", data }];
    case "turn_end": return [{ type: "turn_end", data }];
    case "message_start": return [{ type: "message_start", data }];
    case "assistant_delta": return [{ type: "message_delta", message_id: string(data.message_id), delta: decoded.delta as string, kind: string(decoded.kind) ?? "assistant" }];
    case "assistant_message": return [{ type: "message_commit", message_id: string(data.message_id), message: decoded.message as CoreMessage }];
    case "assistant_reset": return [{ type: "message_reset", data }];
    case "retry": return [{ type: "retry" }];
    case "tool_start": return [{ type: "tool_start", tool_call: decoded.tool_call as ToolCall, data }];
    case "tool_output": return [{ type: "tool_output", tool_call: decoded.tool_call as ToolCall, output: decoded.output as string, data }];
    case "tool_end": return [{ type: "tool_end", tool_call: decoded.tool_call as ToolCall, tool_result: decoded.tool_result as ToolResult | undefined, data }];
    case "approval_request": return [{ type: "approval_request", request_id: decoded.request_id as string, tool_call: decoded.tool_call as ToolCall, delegated: decoded.delegated as boolean }];
    case "approval_end": return [{ type: "approval_end", request_id: decoded.request_id as string, data }];
    case "usage": return [{ type: "usage", usage: decoded.usage as Record<string, number> }];
    case "user_message": return [{ type: "user_message", text: decoded.text as string, mode: decoded.mode as string, attachments: decoded.attachments as unknown[] | undefined }];
    case "error": return [{ type: "error", error: decoded.error as { code: string; message: string } }];
    case "turn_aborted": return [{ type: "error", error: { code: "turn_aborted", message: string(decoded.message) ?? "turn aborted" } }];
    case "sub_agent_receipt": case "child_idle": case "task_exit_notification": case "child_question": case "child_question_withdrawn": case "child_message_delivered": {
      const child_id = string(data.agent_instance_id) ?? string(data.child_id) ?? string(data.task_id) ?? string(data.question_id) ?? string(data.message_id)!;
      return [{ type: "notification", notification_id: string(data.notification_id), data: { ...decoded, data, child_id, child_status: decoded.event, child_summary: string(data.result) ?? string(data.summary) } }];
    }
    case "project_inbox_notification": case "notification_by_kind": return [{ type: "notification", notification_id: string(data.notification_id), data: { ...decoded, data } }];
    case "memory_updated": case "compaction_start": case "compaction_end": case "account_limit": case "account_state_unknown": return [{ type: "unknown", name: decoded.event, data: { ...decoded, data } }];
    default: return [{ type: "unknown", name: decoded.event, data: { ...decoded, data } }];
  }
}
