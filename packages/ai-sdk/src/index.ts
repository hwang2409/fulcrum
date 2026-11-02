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
  value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Row) } : { input: value };
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
const defined = (row: Row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
const providerMeta = (part: Row) => part.providerMetadata === undefined ? undefined : { providerMetadata: [part.providerMetadata] };
const toolMeta = (part: Row) => {
  const meta = defined({
    providerExecuted: part.providerExecuted,
    dynamic: part.dynamic,
    title: part.title,
    providerMetadata: part.providerMetadata === undefined ? undefined : [part.providerMetadata],
  });
  return Object.keys(meta).length ? meta : undefined;
};
const mergeMeta = (prior: Record<string, unknown> | undefined, next: Record<string, unknown>) => ({
  ...prior,
  ...next,
  ...(prior?.providerMetadata && next.providerMetadata
    ? { providerMetadata: [...prior.providerMetadata as unknown[], ...next.providerMetadata as unknown[]] }
    : {}),
});

interface ToolState { call: ToolCall; input: string; }
interface BlockState { kind: "text" | "reasoning"; block: ContentBlock; }

export function createAiSdkAdapter() {
  let messageId: string | undefined;
  const content: ContentBlock[] = [];
  const blocks = new Map<string, BlockState>();
  const tools = new Map<string, ToolState>();
  const approvalByTool = new Map<string, string>();

  const call = (id: string, name?: string, meta?: Record<string, unknown>): ToolState => {
    const prior = tools.get(id);
    if (prior) {
      if (name || meta) prior.call = { ...prior.call, ...(name ? { name } : {}), ...(meta ? { meta: mergeMeta(prior.call.meta, meta) } : {}) };
      return prior;
    }
    const state = { call: { id, name: name ?? "tool", arguments: {}, ...(meta ? { meta } : {}) }, input: "" };
    tools.set(id, state);
    return state;
  };
  const approvalEnd = (toolCallId: string): RunEvent[] => {
    const requestId = approvalByTool.get(toolCallId);
    if (!requestId) return [];
    approvalByTool.delete(toolCallId);
    return [{ type: "approval_end", request_id: requestId }];
  };
  const commit = (): RunEvent | undefined => messageId
    ? { type: "message_commit", message_id: messageId, message: { role: "assistant", content: content.map((block) => ({ ...block })) } }
    : undefined;

  const decodeBlock = (part: Row, type: string): RunEvent[] => {
    const kind = type.startsWith("text-") ? "text" : "reasoning";
    const id = string(part.id, "part.id");
    if (type.endsWith("-start")) {
      messageId ??= id;
      const block: ContentBlock = { type: kind, text: "", ...(providerMeta(part) ? { meta: providerMeta(part) } : {}) };
      blocks.set(id, { kind, block });
      content.push(block);
      return [];
    }
    const state = blocks.get(id);
    if (!state || state.kind !== kind) throw new Error(`${type} requires a matching start part`);
    if (part.providerMetadata !== undefined) state.block.meta = mergeMeta(state.block.meta as Record<string, unknown> | undefined, providerMeta(part)!);
    if (type.endsWith("-end")) return [];
    const delta = string(part.delta, "part.delta");
    state.block.text = String(state.block.text) + delta;
    return [{ type: "message_delta", message_id: messageId, delta, kind }];
  };

  const decodeAsset = (part: Row, type: string): RunEvent[] => {
    if (type === "file") {
      const block: ContentBlock = { type: "file", kind: "file", url: string(part.url, "part.url"), mediaType: string(part.mediaType, "part.mediaType"), ...(providerMeta(part) ? { meta: providerMeta(part) } : {}) };
      content.push(block);
      return [];
    }
    const sourceId = string(part.sourceId, "part.sourceId");
    const meta = defined({ sourceId, providerMetadata: part.providerMetadata === undefined ? undefined : [part.providerMetadata] });
    const block: ContentBlock = {
      type: "source", kind: "source",
      ...(type === "source-url" ? { url: string(part.url, "part.url") } : { mediaType: string(part.mediaType, "part.mediaType") }),
      ...(part.title === undefined ? {} : { title: string(part.title, "part.title") }),
      ...(part.filename === undefined ? {} : { filename: string(part.filename, "part.filename") }),
      meta,
    };
    content.push(block);
    return [];
  };

  const decodeTool = (part: Row, type: string): RunEvent[] => {
    const id = string(part.toolCallId, "part.toolCallId");
    if (type === "tool-input-start") {
      const state = call(id, string(part.toolName, "part.toolName"), toolMeta(part));
      return [{ type: "tool_start", tool_call: state.call }];
    }
    if (type === "tool-input-delta") {
      const state = tools.get(id);
      if (!state) throw new Error("tool-input-delta requires tool-input-start");
      const input = string(part.inputTextDelta, "part.inputTextDelta");
      state.input += input;
      return [{ type: "tool_input", tool_call: state.call, input }];
    }
    if (type === "tool-input-available" || type === "tool-input-error") {
      const name = string(part.toolName, "part.toolName");
      const state = call(id, name, toolMeta(part));
      state.call = { ...state.call, id, name, arguments: argumentsFrom(part.input) };
      tools.set(id, state);
      if (type === "tool-input-available") return [{ type: "tool_start", tool_call: state.call }];
      const output = string(part.errorText, "part.errorText");
      return [{ type: "tool_start", tool_call: state.call }, { type: "tool_end", tool_call: state.call, tool_result: { tool_call_id: id, content: output, is_error: true } }];
    }
    if (type === "tool-approval-request") {
      const requestId = string(part.approvalId, "part.approvalId");
      approvalByTool.set(id, requestId);
      return [{ type: "approval_request", request_id: requestId, tool_call: (tools.get(id) ?? call(id)).call, delegated: false }];
    }
    const state = call(id, undefined, toolMeta(part));
    if (type === "tool-output-denied")
      return [{ type: "tool_end", tool_call: state.call, tool_result: { tool_call_id: id, content: "tool execution denied", is_error: true, is_canceled: true } }, ...approvalEnd(id)];
    const isError = type === "tool-output-error";
    const output = isError ? string(part.errorText, "part.errorText") : serialized(part.output);
    if (!isError && part.preliminary === true) return [{ type: "tool_output", tool_call: state.call, output }];
    const result: ToolResult = { tool_call_id: id, content: output, is_error: isError };
    return [{ type: "tool_output", tool_call: state.call, output }, { type: "tool_end", tool_call: state.call, tool_result: result }, ...approvalEnd(id)];
  };

  const decodeLifecycle = (part: Row, type: string): RunEvent[] => {
    if (type === "start") {
      messageId = optionalString(part.messageId, "part.messageId");
      content.length = 0; blocks.clear(); tools.clear(); approvalByTool.clear();
      return [{ type: "run_start", data: defined({ messageId, messageMetadata: part.messageMetadata }) }, { type: "turn_start" }, { type: "message_start", data: messageId ? { messageId } : {} }];
    }
    if (type === "start-step" || type === "finish-step") return [];
    if (type === "finish") {
      const value = partUsage(part);
      const event = commit();
      return [...(event ? [event] : []), ...(value ? [{ type: "usage", usage: value } as RunEvent] : []), { type: "turn_end" }, { type: "run_end", data: defined({ finishReason: optionalString(part.finishReason, "part.finishReason"), messageMetadata: part.messageMetadata }) }];
    }
    if (type === "abort") return [{ type: "error", error: { code: "run_aborted", message: "run aborted" } }];
    return [{ type: "error", error: { code: "ai_sdk_error", message: string(part.errorText, "part.errorText") } }];
  };

  const decode = (value: unknown): RunEvent[] => {
    try {
      const part = object(value, "part");
      const type = string(part.type, "part.type");
      if (/^(text|reasoning)-(start|delta|end)$/.test(type)) return decodeBlock(part, type);
      if (type === "source-url" || type === "source-document" || type === "file") return decodeAsset(part, type);
      if (type.startsWith("tool-")) return decodeTool(part, type);
      if (["start", "start-step", "finish-step", "finish", "abort", "error"].includes(type)) return decodeLifecycle(part, type);
      return [{ type: "unknown", name: type, data: { ...part } }];
    } catch (error) { return invalid(error); }
  };
  return { decode };
}
