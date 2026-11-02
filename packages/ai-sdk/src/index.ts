import type { ContentBlock, RunEvent, ToolCall, ToolResult } from "@fulcrum/core";

/** The documented UI message stream implemented by this adapter. */
export const AI_SDK_PROTOCOL = { package: "ai", version: "6.0.0", stream: "v1" } as const;

type Row = Record<string, unknown>;
const object = (value: unknown, name: string): Row => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Row;
};
const string = (value: unknown, name: string) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a nonempty string`);
  return value;
};
const wireString = (value: unknown, name: string) => {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
};

/*
 * AI SDK 6.0.0 fields read here: type (known literal) -> matching part;
 * id, sourceId, toolCallId, approvalId, messageId, delta, inputTextDelta,
 * toolName, errorText, url, mediaType, title, filename -> SDK string,
 * wireString (blank and whitespace are valid); data-* id -> optional SDK
 * string, preserved in the unknown-part payload; input, output,
 * messageMetadata, providerMetadata -> unknown, passed through;
 * providerExecuted, dynamic, preliminary, transient -> optional boolean,
 * passed through when present; finishReason -> optional SDK FinishReason,
 * optionalString; usage -> object of finite numbers; streamKey and type
 * validation are adapter-owned and remain nonblank.
 */
const optionalString = (value: unknown, name: string) => value === undefined ? undefined : string(value, name);
const optionalWireString = (value: unknown, name: string) => value === undefined ? undefined : wireString(value, name);
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

export type AiSdkEntityKind = "message" | "tool" | "approval";
export type AiSdkEntityIdentity =
  | { source: "wire"; kind: AiSdkEntityKind; id: string }
  | { source: "synthetic"; kind: AiSdkEntityKind; streamKey: string; counter: number };

const escapeId = (value: string) => value.replaceAll("%", "%25").replaceAll(":", "%3A");
const unescapeId = (value: string) => value.replaceAll("%3A", ":").replaceAll("%25", "%");

/** Tags and escaped separators make every source/kind/key/value tuple map to exactly one string. */
export function encodeAiSdkEntityId(identity: AiSdkEntityIdentity): string {
  const kind = identity.kind;
  if (identity.source === "wire") return `w:${kind}:${escapeId(wireString(identity.id, "identity.id"))}`;
  const streamKey = escapeId(string(identity.streamKey, "identity.streamKey"));
  if (!Number.isSafeInteger(identity.counter) || identity.counter < 1) throw new Error("identity.counter must be a positive safe integer");
  return `s:${kind}:${streamKey}:${identity.counter}`;
}

export function decodeAiSdkEntityId(value: string): AiSdkEntityIdentity {
  const wire = /^w:(message|tool|approval):([^:]*)$/.exec(value);
  if (wire) {
    const id = unescapeId(wire[2]!);
    if (escapeId(id) !== wire[2]) throw new Error("invalid encoded AI SDK entity id");
    return { source: "wire", kind: wire[1] as AiSdkEntityKind, id: wireString(id, "identity.id") };
  }
  const synthetic = /^s:(message|tool|approval):([^:]*):([1-9]\d*)$/.exec(value);
  if (synthetic) {
    const streamKey = unescapeId(synthetic[2]!);
    const counter = Number(synthetic[3]);
    if (escapeId(streamKey) !== synthetic[2] || !Number.isSafeInteger(counter)) throw new Error("invalid encoded AI SDK entity id");
    return { source: "synthetic", kind: synthetic[1] as AiSdkEntityKind, streamKey: string(streamKey, "identity.streamKey"), counter };
  }
  throw new Error("invalid encoded AI SDK entity id");
}

export interface AiSdkAdapterOptions {
  /** Stable identity for this message stream, unique within its run. */
  streamKey: string;
}

export function createAiSdkAdapter(options: AiSdkAdapterOptions) {
  const streamKey = string(options?.streamKey, "options.streamKey");
  const wireId = (kind: AiSdkEntityKind, id: string) => encodeAiSdkEntityId({ source: "wire", kind, id });
  const syntheticId = (kind: AiSdkEntityKind, counter: number) => encodeAiSdkEntityId({ source: "synthetic", kind, streamKey, counter });
  let messageId: string | undefined;
  let wireMessageId: string | undefined;
  let messageNumber = 0;
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
    if (requestId === undefined) return [];
    approvalByTool.delete(toolCallId);
    return [{ type: "approval_end", request_id: requestId }];
  };
  const commit = (): RunEvent | undefined => {
    if (!content.length) return undefined;
    messageId ??= syntheticId("message", ++messageNumber);
    return {
      type: "message_commit",
      message_id: messageId,
      message: { role: "assistant", content: content.map((block) => ({ ...block })), ...(wireMessageId !== undefined ? { metadata: { wireId: wireMessageId } } : {}) },
    };
  };

  const decodeBlock = (part: Row, type: string): RunEvent[] => {
    const kind = type.startsWith("text-") ? "text" : "reasoning";
    const id = wireString(part.id, "part.id");
    if (type.endsWith("-start")) {
      messageId ??= syntheticId("message", ++messageNumber);
      const block: ContentBlock = { type: kind, text: "", ...(providerMeta(part) ? { meta: providerMeta(part) } : {}) };
      blocks.set(id, { kind, block });
      content.push(block);
      return [];
    }
    const state = blocks.get(id);
    if (!state || state.kind !== kind) throw new Error(`${type} requires a matching start part`);
    if (part.providerMetadata !== undefined) state.block.meta = mergeMeta(state.block.meta as Record<string, unknown> | undefined, providerMeta(part)!);
    if (type.endsWith("-end")) return [];
    const delta = wireString(part.delta, "part.delta");
    state.block.text = String(state.block.text) + delta;
    return [{ type: "message_delta", message_id: messageId, delta, kind }];
  };

  const decodeAsset = (part: Row, type: string): RunEvent[] => {
    if (type === "file") {
      const block: ContentBlock = { type: "file", kind: "file", url: wireString(part.url, "part.url"), mediaType: wireString(part.mediaType, "part.mediaType"), ...(providerMeta(part) ? { meta: providerMeta(part) } : {}) };
      content.push(block);
      return [];
    }
    const sourceId = wireString(part.sourceId, "part.sourceId");
    const meta = defined({ sourceId, providerMetadata: part.providerMetadata === undefined ? undefined : [part.providerMetadata] });
    const block: ContentBlock = {
      type: "source", kind: "source",
      ...(type === "source-url" ? { url: wireString(part.url, "part.url") } : { mediaType: wireString(part.mediaType, "part.mediaType") }),
      ...(part.title === undefined ? {} : { title: wireString(part.title, "part.title") }),
      ...(part.filename === undefined ? {} : { filename: wireString(part.filename, "part.filename") }),
      meta,
    };
    content.push(block);
    return [];
  };

  const decodeTool = (part: Row, type: string): RunEvent[] => {
    const originalId = wireString(part.toolCallId, "part.toolCallId");
    const id = wireId("tool", originalId);
    const meta = { ...toolMeta(part), wireId: originalId };
    if (type === "tool-input-start") {
      const state = call(id, wireString(part.toolName, "part.toolName"), meta);
      return [{ type: "tool_start", tool_call: state.call }];
    }
    if (type === "tool-input-delta") {
      const state = tools.get(id);
      if (!state) throw new Error("tool-input-delta requires tool-input-start");
      const input = wireString(part.inputTextDelta, "part.inputTextDelta");
      state.input += input;
      return [{ type: "tool_input", tool_call: state.call, input }];
    }
    if (type === "tool-input-available" || type === "tool-input-error") {
      const name = wireString(part.toolName, "part.toolName");
      const state = call(id, name, meta);
      state.call = { ...state.call, id, name, arguments: argumentsFrom(part.input) };
      tools.set(id, state);
      if (type === "tool-input-available") return [{ type: "tool_start", tool_call: state.call }];
      const output = wireString(part.errorText, "part.errorText");
      return [{ type: "tool_start", tool_call: state.call }, { type: "tool_end", tool_call: state.call, tool_result: { tool_call_id: id, content: output, is_error: true } }];
    }
    if (type === "tool-approval-request") {
      const approvalId = wireString(part.approvalId, "part.approvalId");
      const requestId = wireId("approval", approvalId);
      approvalByTool.set(id, requestId);
      return [{ type: "approval_request", request_id: requestId, tool_call: call(id, undefined, { ...meta, approvalId }).call, delegated: false }];
    }
    const state = call(id, undefined, meta);
    if (type === "tool-output-denied")
      return [{ type: "tool_end", tool_call: state.call, tool_result: { tool_call_id: id, content: "tool execution denied", is_error: true, is_canceled: true } }, ...approvalEnd(id)];
    const isError = type === "tool-output-error";
    const output = isError ? wireString(part.errorText, "part.errorText") : serialized(part.output);
    if (!isError && part.preliminary === true) return [{ type: "tool_output", tool_call: state.call, output }];
    const result: ToolResult = { tool_call_id: id, content: output, is_error: isError };
    return [{ type: "tool_output", tool_call: state.call, output }, { type: "tool_end", tool_call: state.call, tool_result: result }, ...approvalEnd(id)];
  };

  const decodeLifecycle = (part: Row, type: string): RunEvent[] => {
    if (type === "start") {
      wireMessageId = optionalWireString(part.messageId, "part.messageId");
      messageId = wireMessageId !== undefined ? wireId("message", wireMessageId) : undefined;
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
    return [{ type: "error", error: { code: "ai_sdk_error", message: wireString(part.errorText, "part.errorText") } }];
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
