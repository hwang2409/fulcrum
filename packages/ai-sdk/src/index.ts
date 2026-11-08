import type { ContentBlock, RunEvent, ToolCall, ToolResult } from "@fulcrum/core";

declare global { var __FULCRUM_DEV__: boolean | undefined; }
/*
 * The development rule of @fulcrum/react (packages/react/src/parts.tsx, the source of truth), copied: a bundler's
 * define (`globalThis.__FULCRUM_DEV__`, Vite's `import.meta.env.DEV`) folds it to a constant in this module, so the
 * warning below is dead code in production. An import from another package would rely on cross-module constant
 * propagation, which not every minifier does.
 */
const viteDevelopment = typeof (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env === "object"
  ? (import.meta as ImportMeta & { env: { DEV?: boolean } }).env.DEV
  : undefined;
const configuredDevelopment = globalThis.__FULCRUM_DEV__;
const development = configuredDevelopment === undefined ? viteDevelopment !== false : configuredDevelopment;

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
 * validation are adapter-owned and remain nonblank. A persisted UIMessage adds id -> SDK string, parts -> array, a
 * tool part's state -> known literal and approval -> { id, approved?: boolean, reason? }.
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
    title: part.title === undefined ? undefined : wireString(part.title, "part.title"),
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
/** One fulcrum message: a run of content between tool rows or stream breaks. */
interface Segment { id: string; content: ContentBlock[]; }
/** A text or reasoning part. It joins a segment with its first text, so a part that never streams text adds no row. */
interface BlockState { kind: "text" | "reasoning"; block: ContentBlock; segment?: Segment; }

export type AiSdkEntityKind = "message" | "tool" | "approval";
export type AiSdkEntityIdentity =
  | { source: "wire"; kind: AiSdkEntityKind; id: string }
  /** The `counter`th fulcrum message of the UI message `messageId`: the one id rule live streams and reloads share. */
  | { source: "message"; kind: "message"; messageId: string; counter: number }
  /** A message of a stream whose `start` carries no message id, named by the stream's key. */
  | { source: "synthetic"; kind: AiSdkEntityKind; streamKey: string; counter: number };

const escapeId = (value: string) => value.replaceAll("%", "%25").replaceAll(":", "%3A");
const unescapeId = (value: string) => value.replaceAll("%3A", ":").replaceAll("%25", "%");

/** Tags and escaped separators make every source/kind/key/value tuple map to exactly one string. */
export function encodeAiSdkEntityId(identity: AiSdkEntityIdentity): string {
  const kind = identity.kind;
  if (identity.source === "wire") return `w:${kind}:${escapeId(wireString(identity.id, "identity.id"))}`;
  if (!Number.isSafeInteger(identity.counter) || identity.counter < 1) throw new Error("identity.counter must be a positive safe integer");
  if (identity.source === "message") {
    if (kind !== "message") throw new Error("identity.kind must be \"message\"");
    return `m:message:${escapeId(wireString(identity.messageId, "identity.messageId"))}:${identity.counter}`;
  }
  return `s:${kind}:${escapeId(string(identity.streamKey, "identity.streamKey"))}:${identity.counter}`;
}

export function decodeAiSdkEntityId(value: string): AiSdkEntityIdentity {
  const wire = /^w:(message|tool|approval):([^:]*)$/.exec(value);
  if (wire) {
    const id = unescapeId(wire[2]!);
    if (escapeId(id) !== wire[2]) throw new Error("invalid encoded AI SDK entity id");
    return { source: "wire", kind: wire[1] as AiSdkEntityKind, id: wireString(id, "identity.id") };
  }
  const message = /^m:message:([^:]*):([1-9]\d*)$/.exec(value);
  if (message) {
    const messageId = unescapeId(message[1]!);
    const counter = Number(message[2]);
    if (escapeId(messageId) !== message[1] || !Number.isSafeInteger(counter)) throw new Error("invalid encoded AI SDK entity id");
    return { source: "message", kind: "message", messageId, counter };
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
  /** Stable key for this stream, unique within its run. It names messages only when `start` carries no message id. */
  streamKey: string;
  /**
   * The messages this stream's request sent (`sendMessages({ messages })` in a transport; the server's
   * `originalMessages`). Required: a continuation (the last one is the assistant message it continues) numbers its
   * messages after the ones that message already has, and without them it would overwrite the text before the tool.
   */
  originalMessages: readonly unknown[];
}

const serverFix = "On the server, pass both `originalMessages` and `generateMessageId` to `toUIMessageStreamResponse` (or `toUIMessageStream`). See https://github.com/hwang2409/fulcrum/blob/main/packages/ai-sdk/README.md#server-message-ids";

export function createAiSdkAdapter(options: AiSdkAdapterOptions) {
  const streamKey = string(options?.streamKey, "options.streamKey");
  const original = options.originalMessages;
  if (!Array.isArray(original)) throw new Error("options.originalMessages must be an array");
  const last = original.at(-1) as Row | undefined;
  const continues = last?.role === "assistant" && typeof last.id === "string" ? last.id : undefined;
  const continued = (messageId: string) => messageId === continues ? replayMessage(last!).count : 0;
  // Development only: a server setup whose message ids a reload cannot match. Once per adapter.
  let warned = false;
  const checkStart = development ? (messageId: string | undefined) => {
    if (warned || (messageId !== undefined && (continues === undefined || messageId === continues))) return;
    warned = true;
    console.warn(messageId === undefined
      ? `@fulcrum/ai-sdk: this stream's \`start\` part has no messageId, so its rows are named by streamKey and a re-sync from persisted messages adds them a second time. ${serverFix}`
      : `@fulcrum/ai-sdk: this stream continues assistant message "${continues}", but its \`start\` part names a new message "${messageId}", so a reload renames the message and a re-sync adds its earlier text a second time. ${serverFix}`);
  } : undefined;
  return { decode: messageDecoder(streamKey, continued, checkStart).decode };
}

/**
 * The stream decoder. `continued(messageId)` is how many fulcrum messages that UI message already has, so a
 * continuation numbers its messages after them. `streamKey` names the messages of a stream with no message id.
 */
function messageDecoder(streamKey: string | undefined, continued: (messageId: string) => number, checkStart?: (messageId: string | undefined) => void) {
  const wireId = (kind: AiSdkEntityKind, id: string) => encodeAiSdkEntityId({ source: "wire", kind, id });
  let wireMessageId: string | undefined;
  /** Fulcrum messages so far per UI message id (`undefined`: the stream's messages without one). */
  const counters = new Map<string | undefined, number>();
  const nextMessageId = () => {
    const counter = (counters.get(wireMessageId) ?? 0) + 1;
    counters.set(wireMessageId, counter);
    if (wireMessageId !== undefined) return encodeAiSdkEntityId({ source: "message", kind: "message", messageId: wireMessageId, counter });
    if (streamKey === undefined) throw new Error("a stream without a message id needs a streamKey");
    return encodeAiSdkEntityId({ source: "synthetic", kind: "message", streamKey, counter });
  };
  const blocks = new Map<string, BlockState>();
  const tools = new Map<string, ToolState>();

  /*
   * The one owner of "which fulcrum message does the next content go to". A UI message spans every step of a stream
   * and, after an approval, continuation streams with the same messageId, so it splits into segments: segment n is
   * `m:message:<messageId>:<n>` and carries the wire id in its metadata. The split depends only on what the UI message
   * persists (its parts in order, with one step-start part per step), so a reload numbers the same parts the same way
   * and a continuation starts after the segments its message already has (`continued`). States:
   * - no segment: the next content opens one;
   * - open: content streams into the current segment;
   * - a new tool row or a new step after the segment's content seals and commits it, before any later content
   *   streams, so the reader sees it finished while the tool runs and a stream that drops keeps it. The next content
   *   opens the next segment; a late delta for a committed segment's part continues as a block of the current one.
   * finish, abort, and error commit the current segment (`close`). Provider metadata that arrives for a committed
   * segment re-commits it at the next close: a commit while another segment streams would end that one in the store.
   */
  let segment: Segment | undefined;
  let pending: BlockState[] = [];
  const stale = new Set<Segment>();
  const target = (): Segment => {
    segment ??= { id: nextMessageId(), content: [] };
    for (const state of pending) { state.segment = segment; segment.content.push(state.block); }
    pending = [];
    return segment;
  };
  const commit = (done: Segment): RunEvent[] => {
    const content = done.content.filter((block) => block.text !== "" || block.meta);
    return content.length ? [{
      type: "message_commit",
      message_id: done.id,
      message: { role: "assistant", content: content.map((block) => ({ ...block })), ...(wireMessageId !== undefined ? { metadata: { wireId: wireMessageId } } : {}) },
    }] : [];
  };
  const seal = (): RunEvent[] => {
    if (!segment?.content.length) return [];
    const done = segment;
    segment = undefined;
    return commit(done);
  };
  const close = (): RunEvent[] => {
    // A part that never streamed text opens no row. It shows nothing, so it stays only to keep provider metadata, at
    // the end of the current segment.
    if (pending.length && segment) segment.content.push(...pending.map((state) => state.block));
    const events = [...(segment ? commit(segment) : []), ...[...stale].flatMap(commit)];
    segment = undefined; pending = []; stale.clear();
    return events;
  };

  const call = (id: string, name?: string, meta?: Record<string, unknown>): ToolState => {
    const prior = tools.get(id);
    if (prior) {
      if (name !== undefined || meta) prior.call = { ...prior.call, ...(name !== undefined ? { name } : {}), ...(meta ? { meta: mergeMeta(prior.call.meta, meta) } : {}) };
      return prior;
    }
    const state = { call: { id, name: name ?? "tool", arguments: {}, ...(meta ? { meta } : {}) }, input: "" };
    tools.set(id, state);
    return state;
  };
  const decodeBlock = (part: Row, type: string): RunEvent[] => {
    const kind = type.startsWith("text-") ? "text" : "reasoning";
    const id = wireString(part.id, "part.id");
    if (type.endsWith("-start")) {
      const state: BlockState = { kind, block: { type: kind, text: "", ...(providerMeta(part) ? { meta: providerMeta(part) } : {}) } };
      blocks.set(id, state);
      pending.push(state);
      return [];
    }
    const state = blocks.get(id);
    if (!state || state.kind !== kind) throw new Error(`${type} requires a matching start part`);
    const delta = type.endsWith("-end") ? "" : wireString(part.delta, "part.delta");
    if (delta !== "") {
      const current = target();
      // A block whose segment committed continues as a new block of the current one.
      if (state.segment !== current) {
        state.block = { type: kind, text: "" };
        state.segment = current;
        current.content.push(state.block);
      }
      state.block.text = String(state.block.text) + delta;
    }
    if (part.providerMetadata !== undefined) {
      state.block.meta = mergeMeta(state.block.meta as Record<string, unknown> | undefined, providerMeta(part)!);
      if (state.segment && state.segment !== segment) stale.add(state.segment);
    }
    return delta === "" ? [] : [{ type: "message_delta", message_id: state.segment!.id, delta, kind }];
  };

  // Sources and files stream in as whole blocks, in their place among the text and reasoning. A file that is an image
  // (the SDK's generated images) is an image block, so it renders as one.
  const decodeAsset = (part: Row, type: string): RunEvent[] => {
    let block: ContentBlock;
    if (type === "file") {
      const url = wireString(part.url, "part.url");
      const mediaType = wireString(part.mediaType, "part.mediaType");
      block = { ...(/^image\//i.test(mediaType) ? { type: "image" } : { type: "file", kind: "file" }), url, mediaType, ...(providerMeta(part) ? { meta: providerMeta(part) } : {}) };
    } else {
      const sourceId = wireString(part.sourceId, "part.sourceId");
      const meta = defined({ sourceId, providerMetadata: part.providerMetadata === undefined ? undefined : [part.providerMetadata] });
      block = {
        type: "source", kind: "source",
        ...(type === "source-url" ? { url: wireString(part.url, "part.url") } : { mediaType: wireString(part.mediaType, "part.mediaType") }),
        ...(part.title === undefined ? {} : { title: wireString(part.title, "part.title") }),
        ...(part.filename === undefined ? {} : { filename: wireString(part.filename, "part.filename") }),
        meta,
      };
    }
    const current = target();
    current.content.push(block);
    return [{ type: "message_block", message_id: current.id, block: { ...block } }];
  };

  const decodeTool = (part: Row, type: string): RunEvent[] => {
    const originalId = wireString(part.toolCallId, "part.toolCallId");
    const id = wireId("tool", originalId);
    const sealed = tools.has(id) ? [] : seal();
    return [...sealed, ...decodeToolPart(part, type, id, originalId)];
  };
  const decodeToolPart = (part: Row, type: string, id: string, originalId: string): RunEvent[] => {
    const meta = { ...toolMeta(part), wireId: originalId };
    if (type === "tool-input-start") {
      const state = call(id, wireString(part.toolName, "part.toolName"), meta);
      return [{ type: "tool_start", tool_call: state.call }];
    }
    if (type === "tool-input-delta") {
      const state = tools.get(id);
      if (!state) throw new Error("tool-input-delta requires tool-input-start");
      const input = wireString(part.inputTextDelta, "part.inputTextDelta");
      if (input === "") return [];
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
      return [{ type: "approval_request", request_id: wireId("approval", approvalId), tool_call: call(id, undefined, { ...meta, approvalId }).call, delegated: false }];
    }
    // A continuation's adapter has not seen the call: core keeps the known call, and this only names an orphan.
    const state = call(id, undefined, meta);
    // The decision is not on the wire: the host ends the approval with respondToApproval or decodeAiSdkMessage.
    if (type === "tool-output-denied")
      return [{ type: "tool_end", tool_call: state.call, tool_result: { tool_call_id: id, content: "tool execution denied", is_error: true, is_canceled: true } }];
    const isError = type === "tool-output-error";
    const output = isError ? wireString(part.errorText, "part.errorText") : serialized(part.output);
    // Each output, preliminary or final, is the whole output so far, so it replaces the row's output.
    const events: RunEvent[] = [{ type: "tool_output", tool_call: state.call, output, replace: true }];
    if (!isError && part.preliminary === true) return events;
    const result: ToolResult = { tool_call_id: id, content: output, is_error: isError };
    return [...events, { type: "tool_end", tool_call: state.call, tool_result: result }];
  };

  const decodeLifecycle = (part: Row, type: string): RunEvent[] => {
    if (type === "start") {
      const events = close();
      wireMessageId = optionalWireString(part.messageId, "part.messageId");
      checkStart?.(wireMessageId);
      if (wireMessageId !== undefined && !counters.has(wireMessageId)) counters.set(wireMessageId, continued(wireMessageId));
      const messageId = wireMessageId !== undefined ? wireId("message", wireMessageId) : undefined;
      blocks.clear(); tools.clear();
      return [...events, { type: "run_start", data: defined({ messageId, messageMetadata: part.messageMetadata }) }, { type: "turn_start" }, { type: "message_start", data: messageId ? { messageId } : {} }];
    }
    if (type === "start-step") return seal();
    if (type === "finish-step") return [];
    if (type === "finish") {
      const value = partUsage(part);
      return [...close(), ...(value ? [{ type: "usage", usage: value } as RunEvent] : []), { type: "turn_end" }, { type: "run_end", data: defined({ finishReason: optionalString(part.finishReason, "part.finishReason"), messageMetadata: part.messageMetadata }) }];
    }
    if (type === "abort") return [...close(), { type: "error", error: { code: "aborted", message: "run aborted" } }];
    return [...close(), { type: "error", error: { code: "ai_sdk_error", message: wireString(part.errorText, "part.errorText") } }];
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
  return { decode, count: (messageId: string) => counters.get(messageId) ?? 0 };
}

/** The AI SDK's approval response: the argument of `addToolApprovalResponse` and the `approval` field it records. */
export interface AiSdkApprovalResponse { id: string; approved: boolean; reason?: string; }

/** Ends the approval row the adapter opened for `response.id`. */
function aiSdkApprovalEnd(response: AiSdkApprovalResponse, name = "response"): RunEvent {
  const id = wireString(response.id, `${name}.id`);
  if (typeof response.approved !== "boolean") throw new Error(`${name}.approved must be a boolean`);
  const reason = optionalWireString(response.reason, `${name}.reason`);
  return {
    type: "approval_end",
    request_id: encodeAiSdkEntityId({ source: "wire", kind: "approval", id }),
    decision: response.approved ? "approve" : "deny",
    ...(reason !== undefined ? { data: { reason } } : {}),
  };
}

export interface AiSdkApprovalTarget {
  /** `useChat()`'s helpers or a `Chat`: the AI SDK records the decision on its tool part. */
  chat: {
    readonly messages: readonly { readonly parts: readonly unknown[] }[];
    addToolApprovalResponse(response: AiSdkApprovalResponse): void | PromiseLike<void>;
  };
  /** The run store's `dispatch`: fulcrum ends the approval card. */
  dispatch(event: RunEvent): void;
}

const isToolPart = (part: Row) => typeof part.type === "string" && (part.type === "dynamic-tool" || part.type.startsWith("tool-"));
/** The condition under which ai 6.0.0 `addToolApprovalResponse` records a decision (dist/index.mjs:11329-11345). */
const pendingApproval = (messages: AiSdkApprovalTarget["chat"]["messages"], id: string) =>
  (messages.at(-1)?.parts ?? []).some((value) => {
    const part = value as Row | null;
    return !!part && isToolPart(part) && part.state === "approval-requested" && (part.approval as Row | undefined)?.id === id;
  });

/**
 * Answers an AI SDK tool approval: the decision is a client transition (`addToolApprovalResponse`) that no stream
 * echoes, so the host that makes it also ends fulcrum's card. `requestId` is the approval's fulcrum id, the value an
 * `Approval` card passes to `onApprove`/`onDeny`. The SDK records a decision only for an approval still pending in the
 * chat's last message, and resolves silently otherwise; so this rejects unless the approval is pending there (a card
 * left behind by a new prompt, a second answer, an unknown id). The SDK records first and fulcrum ends the card only
 * after: if the SDK call rejects, nothing is dispatched. Either way a rejected promise makes an `Approval` card show
 * the error and offer its buttons again, instead of claiming a decision the SDK never made.
 * Limit: `useChat()`'s `messages` is the last render's snapshot, so two calls for one approval before a re-render both
 * pass the check. An `Approval` card cannot do this (it sends one decision at a time); a host calling it directly must.
 */
export async function respondToApproval(
  { chat, dispatch }: AiSdkApprovalTarget,
  { requestId, approved, reason }: { requestId: string; approved: boolean; reason?: string },
): Promise<void> {
  const identity = decodeAiSdkEntityId(requestId);
  if (identity.source !== "wire" || identity.kind !== "approval") throw new Error("requestId must be an AI SDK approval request id");
  const response: AiSdkApprovalResponse = { id: identity.id, approved, ...(reason !== undefined ? { reason } : {}) };
  const end = aiSdkApprovalEnd(response);
  // An Approval card shows these messages to the user; the SDK's own error stays as the cause.
  if (!pendingApproval(chat.messages, identity.id)) throw new Error("this approval is no longer waiting for a decision");
  try {
    await chat.addToolApprovalResponse(response);
  } catch (error) {
    throw new Error("the decision could not be saved, try again", { cause: error });
  }
  dispatch(end);
}

const toolStates = new Set(["input-streaming", "input-available", "approval-requested", "approval-responded", "output-available", "output-error", "output-denied"]);
type Play = (chunk: Row) => void;

const replayBlock = (play: Play, part: Row, type: "text" | "reasoning", id: string) => {
  play({ type: `${type}-start`, id, providerMetadata: part.providerMetadata });
  play({ type: `${type}-delta`, id, delta: part.text });
  play({ type: `${type}-end`, id });
};

/** An approval replays as its request, then the decision if the user made one. */
const replayApproval = (play: Play, events: RunEvent[], toolCallId: unknown, approval: Row, at: string) => {
  play({ type: "tool-approval-request", toolCallId, approvalId: approval.id });
  if (approval.approved === undefined) return;
  // A malformed decision is one error; the tool's outcome still plays, so the row does not stay live.
  try { events.push(aiSdkApprovalEnd(approval as unknown as AiSdkApprovalResponse, `${at}.approval`)); }
  catch (error) { events.push(...invalid(error)); }
};

/** A tool part replays as its input, its approval request, the decision, then its outcome. */
const replayTool = (play: Play, events: RunEvent[], part: Row, type: string, at: string) => {
  const state = string(part.state, `${at}.state`);
  if (!toolStates.has(state)) throw new Error(`${at}.state is not a tool state`);
  const approval = part.approval === undefined ? undefined : object(part.approval, `${at}.approval`);
  const toolCallId = part.toolCallId;
  const call = { toolCallId, toolName: type === "dynamic-tool" ? part.toolName : type.slice(5), title: part.title, providerExecuted: part.providerExecuted, dynamic: type === "dynamic-tool" || undefined };
  if (state === "input-streaming") {
    play({ type: "tool-input-start", ...call });
    if (part.input !== undefined) play({ type: "tool-input-delta", toolCallId, inputTextDelta: JSON.stringify(part.input) });
    return;
  }
  // An input that failed to parse keeps it as rawInput, with no input (the stream's tool-input-error).
  if (state === "output-error" && part.input === undefined) {
    play({ type: "tool-input-error", ...call, input: part.rawInput, errorText: part.errorText });
    return;
  }
  play({ type: "tool-input-available", ...call, input: part.input, providerMetadata: part.callProviderMetadata });
  if (approval) replayApproval(play, events, toolCallId, approval, at);
  if (state === "output-available") play({ type: "tool-output-available", toolCallId, output: part.output, preliminary: part.preliminary });
  else if (state === "output-error") play({ type: "tool-output-error", toolCallId, errorText: part.errorText });
  else if (state === "output-denied") play({ type: "tool-output-denied", toolCallId });
};

/** One persisted assistant message through the stream decoder, and how many fulcrum messages it made. */
function replayMessage(message: unknown): { events: RunEvent[]; count: number } {
  let row: Row;
  let parts: unknown[];
  let id: string;
  try {
    row = object(message, "message");
    if (row.role !== "assistant") throw new Error("message.role must be \"assistant\"");
    id = wireString(row.id, "message.id");
    if (!Array.isArray(row.parts)) throw new Error("message.parts must be an array");
    parts = row.parts;
  } catch (error) { return { events: invalid(error), count: 0 }; }
  const adapter = messageDecoder(undefined, () => 0);
  const events = adapter.decode({ type: "start", messageId: id });
  const play: Play = (chunk) => { events.push(...adapter.decode(defined(chunk))); };
  parts.forEach((value, index) => {
    const at = `message.parts[${index}]`;
    try {
      const part = object(value, at);
      const type = string(part.type, `${at}.type`);
      if (type === "text" || type === "reasoning") replayBlock(play, part, type, String(index));
      else if (type === "step-start") play({ type: "start-step" });
      else if (type === "dynamic-tool" || type.startsWith("tool-")) replayTool(play, events, part, type, at);
      else play(part); // sources, files, and data parts keep their chunk's shape
    } catch (error) { events.push(...invalid(error)); }
  });
  events.push(...adapter.decode(defined({ type: "finish", messageMetadata: row.metadata })));
  return { events, count: adapter.count(id) };
}

/**
 * Decodes one persisted assistant `UIMessage` (what `useChat` keeps and a host stores) into the events its streams
 * produced, so a reload rebuilds the run with no host step. Each part replays as the chunks that built it, through the
 * same decoder as a live stream, so its rows get the live ids: a store can hold reloaded messages and keep streaming,
 * and decoding a message again replaces its rows. An approval's decision comes from the tool part's `approval` field,
 * which the SDK keeps after the continuation: `addToolApprovalResponse` writes `approval: { id, approved, reason }`
 * (ai 6.0.0 dist/index.mjs:11329-11341), and the continuation's output chunks update the part without touching it
 * (`updateToolPart`, dist/index.mjs:4508-4540; `tool-output-denied`, dist/index.mjs:4802-4806).
 */
export function decodeAiSdkMessage(message: unknown): RunEvent[] {
  return replayMessage(message).events;
}
