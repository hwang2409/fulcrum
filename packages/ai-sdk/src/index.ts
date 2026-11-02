import type { ContentBlock, RunEvent, ToolCall, ToolResult } from "@fulcrum/core";

/** The documented UI message stream implemented by this adapter. */
export const AI_SDK_PROTOCOL = { package: "ai", version: "6.0.0", stream: "v1" } as const;

type Row = Record<string, unknown>;
const object = (value: unknown, name: string): Row => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Row;
};
const string = (value: unknown, name: string) => {
  if (typeof value !== "string" || !value) throw new Error(`${name} must be a nonempty string`);
  return value;
};
const optionalString = (value: unknown, name: string) => value === undefined ? undefined : string(value, name);
const serialized = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value) ?? "null";
const argumentsFrom = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Row) }
    : { input: value };
const invalid = (error: unknown): RunEvent[] => [{ type: "error", error: { code: "adapter_invalid_payload", message: error instanceof Error ? error.message : "invalid AI SDK payload" } }];
const usage = (value: unknown) => {
  if (value === undefined) return undefined;
  const values = Object.entries(object(value, "usage")).filter((entry): entry is [string, number] =>
    typeof entry[1] === "number" && Number.isFinite(entry[1]),
  );
  return values.length ? Object.fromEntries(values) : undefined;
};
const partUsage = (part: Row) => {
  if (part.usage !== undefined) return usage(part.usage);
  if (!part.messageMetadata || typeof part.messageMetadata !== "object" || Array.isArray(part.messageMetadata)) return undefined;
  return usage((part.messageMetadata as Row).usage);
};

interface ToolState { call: ToolCall; input: string; }
interface BlockState { type: "text" | "reasoning"; text: string; }

export function createAiSdkAdapter() {
  let messageId: string | undefined;
  const blocks = new Map<string, BlockState>();
  const tools = new Map<string, ToolState>();
  const approvalByTool = new Map<string, string>();
  const call = (id: string, name?: string): ToolState => {
    const prior = tools.get(id);
    if (prior) return prior;
    const state = { call: { id, name: name ?? "tool", arguments: {} }, input: "" };
    tools.set(id, state);
    return state;
  };
  const approvalEnd = (toolCallId: string): RunEvent[] => {
    const requestId = approvalByTool.get(toolCallId);
    if (!requestId) return [];
    approvalByTool.delete(toolCallId);
    return [{ type: "approval_end", request_id: requestId }];
  };
  const commit = (): RunEvent | undefined => {
    if (!messageId) return undefined;
    const content: ContentBlock[] = [...blocks.values()].map((block) => ({ type: block.type, text: block.text }));
    return { type: "message_commit", message_id: messageId, message: { role: "assistant", content } };
  };
  const decode = (value: unknown): RunEvent[] => {
    try {
      const part = object(value, "part");
      const type = string(part.type, "part.type");
      switch (type) {
        case "start":
          messageId = optionalString(part.messageId, "part.messageId"); blocks.clear(); tools.clear(); approvalByTool.clear();
          return [{ type: "run_start", data: { ...(messageId ? { messageId } : {}), ...(part.messageMetadata === undefined ? {} : { messageMetadata: part.messageMetadata }) } }, { type: "turn_start" }, { type: "message_start", data: messageId ? { messageId } : {} }];
        case "text-start": case "reasoning-start": {
          const id = string(part.id, "part.id"); messageId ??= id; blocks.set(id, { type: type === "text-start" ? "text" : "reasoning", text: "" }); return [];
        }
        case "text-delta": case "reasoning-delta": {
          const id = string(part.id, "part.id"); const delta = string(part.delta, "part.delta");
          const kind = type === "text-delta" ? "text" : "reasoning";
          const block = blocks.get(id); if (!block || block.type !== kind) throw new Error(`${type} requires a matching start part`);
          block.text += delta;
          return [{ type: "message_delta", message_id: messageId, delta, kind }];
        }
        case "text-end": case "reasoning-end": {
          const id = string(part.id, "part.id"); if (!blocks.has(id)) throw new Error(`${type} requires a matching start part`); return [];
        }
        case "tool-input-start": {
          const id = string(part.toolCallId, "part.toolCallId"); const state = call(id, string(part.toolName, "part.toolName"));
          return [{ type: "tool_start", tool_call: state.call }];
        }
        case "tool-input-delta": {
          const id = string(part.toolCallId, "part.toolCallId"); const state = tools.get(id); if (!state) throw new Error("tool-input-delta requires tool-input-start");
          const input = string(part.inputTextDelta, "part.inputTextDelta"); state.input += input;
          return [{ type: "tool_input", tool_call: state.call, input }];
        }
        case "tool-input-available": {
          const id = string(part.toolCallId, "part.toolCallId"); const name = string(part.toolName, "part.toolName");
          const state = call(id, name); state.call = { id, name, arguments: argumentsFrom(part.input) }; tools.set(id, state);
          return [{ type: "tool_start", tool_call: state.call }];
        }
        case "tool-output-available": {
          const id = string(part.toolCallId, "part.toolCallId"); const state = tools.get(id) ?? call(id);
          const output = serialized(part.output);
          if (part.preliminary === true) return [{ type: "tool_output", tool_call: state.call, output }];
          const result: ToolResult = { tool_call_id: id, content: output, is_error: false };
          return [{ type: "tool_output", tool_call: state.call, output }, { type: "tool_end", tool_call: state.call, tool_result: result }, ...approvalEnd(id)];
        }
        case "tool-output-error": {
          const id = string(part.toolCallId, "part.toolCallId"); const state = tools.get(id) ?? call(id); const output = string(part.errorText, "part.errorText");
          return [{ type: "tool_output", tool_call: state.call, output }, { type: "tool_end", tool_call: state.call, tool_result: { tool_call_id: id, content: output, is_error: true } }, ...approvalEnd(id)];
        }
        case "tool-output-denied": {
          const id = string(part.toolCallId, "part.toolCallId"); const state = tools.get(id) ?? call(id);
          return [{ type: "tool_end", tool_call: state.call, tool_result: { tool_call_id: id, content: "tool execution denied", is_error: true, is_canceled: true } }, ...approvalEnd(id)];
        }
        case "tool-approval-request": {
          const requestId = string(part.approvalId, "part.approvalId"); const id = string(part.toolCallId, "part.toolCallId"); approvalByTool.set(id, requestId);
          return [{ type: "approval_request", request_id: requestId, tool_call: (tools.get(id) ?? call(id)).call, delegated: false }];
        }
        case "tool-input-error": {
          const id = string(part.toolCallId, "part.toolCallId"); const name = string(part.toolName, "part.toolName"); const output = string(part.errorText, "part.errorText");
          const state = call(id, name); state.call = { id, name, arguments: argumentsFrom(part.input) };
          return [{ type: "tool_start", tool_call: state.call }, { type: "tool_end", tool_call: state.call, tool_result: { tool_call_id: id, content: output, is_error: true } }];
        }
        case "start-step": return [];
        case "reset-step": blocks.clear(); return [{ type: "message_reset" }, { type: "retry" }];
        case "finish-step": return [];
        case "finish": { const value = partUsage(part); const event = commit(); return [...(event ? [event] : []), ...(value ? [{ type: "usage", usage: value } as RunEvent] : []), { type: "turn_end" }, { type: "run_end", data: { ...(part.finishReason === undefined ? {} : { finishReason: optionalString(part.finishReason, "part.finishReason") }), ...(part.messageMetadata === undefined ? {} : { messageMetadata: part.messageMetadata }) } }]; }
        case "abort": return [{ type: "error", error: { code: "run_aborted", message: optionalString(part.reason, "part.reason") ?? "run aborted" } }];
        case "error": return [{ type: "error", error: { code: "ai_sdk_error", message: string(part.errorText, "part.errorText") } }];
        case "message-metadata": return [{ type: "unknown", name: type, data: { ...part } }];
        default:
          if (type.startsWith("data-")) return [{ type: "unknown", name: type, data: { ...part } }];
          return [{ type: "unknown", name: type, data: { ...part } }];
      }
    } catch (error) { return invalid(error); }
  };
  return { decode };
}
