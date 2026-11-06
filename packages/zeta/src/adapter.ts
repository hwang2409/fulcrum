import type {
  ApprovalDecision,
  ContentBlock,
  ImageContentBlock,
  Message,
  RunEvent,
  SubAgentEvent,
  SubAgentStatus,
  SubAgentUrgency,
  ToolCall,
  ToolResult,
  ToolView,
} from "@fulcrum/core";
import { resolveToolView } from "@fulcrum/core";
import { zetaTools } from "./tool-map.js";

const object = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
};
const optionalObject = (value: unknown, name: string) =>
  value === undefined ? undefined : object(value, name);
const string = (value: unknown, name: string) => {
  if (typeof value !== "string" || !value) throw new Error(`${name} must be a nonempty string`);
  return value;
};
const optionalString = (value: unknown, name: string) =>
  value === undefined ? undefined : string(value, name);
const boolean = (value: unknown, name: string) => {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
};
const optionalNumber = (value: unknown, name: string) => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
};

const tool = (value: unknown): ToolCall => {
  const input = object(value, "tool_call");
  return {
    id: string(input.id, "tool_call.id"),
    name: string(input.name, "tool_call.name"),
    arguments: { ...object(input.arguments, "tool_call.arguments") },
    ...(input.arguments_truncated === true ? { meta: { argumentsTruncated: true } } : {}),
  };
};

// zeta streams text as "assistant" and reasoning as "thinking".
const deltaKind = (kind: string | undefined) => kind === undefined || kind === "assistant" ? "text" : kind === "thinking" ? "reasoning" : kind;
const basename = (path: string) => path.split(/[\\/]/).pop() || undefined;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value > 0;
// Live images carry base64 bytes. Negotiated history stubs carry only an opaque content_read handle.
const image = (input: Record<string, unknown>, at: string): ImageContentBlock => {
  const mediaType = input.mimeType === undefined ? undefined : string(input.mimeType, `${at}.mimeType`);
  const handle = input.handle === undefined ? undefined : string(input.handle, `${at}.handle`);
  const data = input.data === undefined ? undefined : string(input.data, `${at}.data`);
  if (!handle && !data && input.data_omitted !== true) throw new Error(`${at} must contain data or handle`);
  const filename = input.path === undefined || input.path === null ? undefined : basename(string(input.path, `${at}.path`));
  return {
    type: "image",
    ...(data && mediaType ? { url: `data:${mediaType};base64,${data}` } : {}),
    ...(handle ? { source: { kind: "lazy", key: handle } } : {}),
    ...(mediaType ? { mediaType } : {}),
    ...(filename ? { filename } : {}),
    ...(positive(input.size) ? { size: input.size } : {}),
  };
};
// A tool's ToolImageBlock adds an optional caption and pixel size to the message image's fields.
const toolImage = (input: Record<string, unknown>, at: string): ImageContentBlock => ({
  ...image(input, at),
  ...(typeof input.caption === "string" && input.caption.trim() ? { alt: input.caption } : {}),
  ...(positive(input.width) && positive(input.height) ? { width: input.width, height: input.height } : {}),
});
// zeta's block types map onto fulcrum's: thinking is reasoning, an image's base64 data becomes a data URL.
const contentBlock = (value: unknown, index: number): ContentBlock => {
  const input = object(value, `message.content[${index}]`);
  const type = string(input.type, `message.content[${index}].type`);
  switch (type) {
    case "text":
    case "thinking":
      return {
        type: type === "thinking" ? "reasoning" : type,
        text: typeof input.text === "string" ? input.text : (() => { throw new Error(`message.content[${index}].text must be a string`); })(),
        ...(input.signature === undefined ? {} : { signature: string(input.signature, `message.content[${index}].signature`) }),
      };
    case "image":
      return image(input, `message.content[${index}]`);
    // With content_read, history attachments are image stubs with opaque handles. Older history stays a file row.
    case "attachment": {
      const filename = string(input.name, `message.content[${index}].name`);
      return input.handle === undefined
        ? { type: "file", filename, ...(finite(input.size) ? { size: input.size } : {}) }
        : { type: "image", filename, source: { kind: "lazy", key: string(input.handle, `message.content[${index}].handle`) }, ...(positive(input.size) ? { size: input.size } : {}) };
    }
    case "redacted_thinking":
      return { type: "reasoning", text: "", redacted: true, data: string(input.data, `message.content[${index}].data`) };
    case "tool_use":
      return { type, tool_call: tool(input.tool_call) };
    default:
      // A block type this adapter does not know yet renders as the lossless unsupported block.
      return { ...input, type };
  }
};

const toolResult = (value: unknown): ToolResult => {
  const input = object(value, "tool_result");
  if (input.content_blocks !== undefined && input.content_blocks !== null && !Array.isArray(input.content_blocks)) throw new Error("tool_result.content_blocks must be an array");
  // Only images: zeta already flattens text and resource blocks into `content`. History sends `content_blocks: []`.
  const blocks = ((input.content_blocks ?? []) as unknown[]).flatMap((block, index) => {
    const at = `tool_result.content_blocks[${index}]`;
    return object(block, at).type === "image" ? [toolImage(block as Record<string, unknown>, at)] : [];
  });
  return {
    tool_call_id: string(input.tool_call_id, "tool_result.tool_call_id"),
    content: typeof input.content === "string" ? input.content : (() => { throw new Error("tool_result.content must be a string"); })(),
    is_error: boolean(input.is_error, "tool_result.is_error"),
    ...(input.is_canceled === undefined ? {} : { is_canceled: boolean(input.is_canceled, "tool_result.is_canceled") }),
    ...(blocks.length ? { blocks } : {}),
    ...(input.structured_content_truncated === true ? { truncated: true } : {}),
  };
};

const message = (value: unknown): Message => {
  const input = object(value, "message");
  if (!Array.isArray(input.content)) throw new Error("message.content must be an array");
  const result: Message = {
    role: string(input.role, "message.role"),
    // A tool_use block is its call's tool row, not message content.
    content: Array.from(input.content, contentBlock).filter((block) => block.type !== "tool_use"),
  };
  if (input.tool_result !== undefined && input.tool_result !== null)
    result.tool_result = toolResult(input.tool_result);
  if (input.metadata !== undefined)
    result.metadata = { ...object(input.metadata, "message.metadata") };
  return result;
};

const invalid = (error: unknown): RunEvent[] => [{
  type: "error",
  error: {
    code: "adapter_invalid_payload",
    message: error instanceof Error ? error.message : "invalid zeta payload",
  },
}];

const timestamp = (data: Record<string, unknown>, key: string) =>
  optionalString(data[key], `data.${key}`);
const summary = (data: Record<string, unknown>) =>
  optionalString(data.summary, "data.summary") ??
  optionalString(data.question, "data.question") ??
  optionalString(data.description, "data.description") ??
  optionalString(data.text, "data.text") ??
  optionalString(data.preview, "data.preview");

const subAgent = (
  data: Record<string, unknown>,
  status: SubAgentStatus,
  urgency?: SubAgentUrgency,
  childKey = "child_instance_id",
): SubAgentEvent => {
  const rowSummary = summary(data);
  const notificationId = optionalString(data.notification_id, "data.notification_id");
  const startedAt = timestamp(data, "started_at");
  const updatedAt = timestamp(data, "updated_at");
  const endedAt = timestamp(data, "completed_at");
  const sequence = optionalNumber(data.sequence, "data.sequence");
  return {
    type: "sub_agent",
    childRunId: string(data[childKey], `data.${childKey}`),
    status,
    ...(rowSummary === undefined ? {} : { summary: rowSummary }),
    ...(urgency ? { urgency } : {}),
    ...(notificationId ? { notificationId } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(sequence === undefined ? {} : { sequence }),
  };
};

const completionStatus = (data: Record<string, unknown>): [SubAgentStatus, SubAgentUrgency?] => {
  switch (string(data.status, "data.status")) {
    case "completed": return ["done"];
    case "error": return ["error", "error"];
    case "canceled": return ["canceled"];
    default: throw new Error("data.status is invalid");
  }
};

const resumedStatus = (data: Record<string, unknown>): [SubAgentStatus, SubAgentUrgency?] => {
  if (data.status === undefined) return ["running"];
  switch (string(data.status, "data.status")) {
    case "running": return ["running"];
    case "idle": return ["idle"];
    case "completed":
    case "done": return ["done"];
    case "error": return ["error", "error"];
    case "canceled": return ["canceled"];
    default: throw new Error("data.status is invalid");
  }
};

const turnData = (data: Record<string, unknown>) => {
  if (data.turn !== undefined &&
      !((typeof data.turn === "string" && data.turn) || (typeof data.turn === "number" && Number.isFinite(data.turn))))
    throw new Error("data.turn must be a nonempty string or finite number");
  return data;
};

const childNotification = (name: string, data: Record<string, unknown>): RunEvent | undefined => {
  const kind = name === "sub_agent_receipt" || name === "notification_by_kind"
    ? string(data.kind ?? "agent_completion", "data.kind")
    : name;
  switch (kind) {
    case "agent_completion": {
      const [status, urgency] = completionStatus(data);
      return subAgent(data, status, urgency);
    }
    case "child_idle": return subAgent(data, "idle");
    case "child_question": return subAgent(data, "waiting_input", "input");
    case "child_question_withdrawn": return subAgent(data, "running");
    default: return undefined;
  }
};

const viewOf = (call: ToolCall) => {
  const view = resolveToolView(zetaTools, call);
  return view ? { view } : {};
};
/**
 * bash's result text, `"stdout:\n" + stdout + "\nstderr:\n" + stderr` (zeta src/zeta/tools/bash/__init__.py). History
 * keeps only this text (structured_content is null there). A timeout marker or a cancel stays raw; a spill preview is
 * split too, so its truncation note can sit inside stdout. shortcut: the split is at the last "\nstderr:\n", so a
 * stderr that itself contains that text is mislabeled (stdout containing it is fine); exact once zeta keeps
 * structured_content in history.
 */
const bashText = (content: string) => {
  if (!content.startsWith("stdout:\n")) return undefined;
  const split = content.lastIndexOf("\nstderr:\n");
  return split < 0 ? undefined : { stdout: content.slice(8, split), stderr: content.slice(split + 9) };
};

// bash reports exit_code, stdout, and stderr in structured_content. Values of the wrong type are ignored, not trusted.
const finishedView = (call: ToolCall, result: unknown) => {
  // A call with no command (history without arguments, apps/web/GAPS.md #3) keeps the generic card: a shell card
  // with an empty `$` header reads as broken.
  const view = resolveToolView(zetaTools, call);
  if (view?.kind !== "shell") return view ? { view } : {};
  const { structured_content: extra, content, is_error } = (result ?? {}) as { structured_content?: unknown; content?: unknown; is_error?: unknown };
  const { exit_code, stdout, stderr, cwd_after } = extra && typeof extra === "object" ? (extra as Record<string, unknown>) : {};
  if (typeof stdout === "string" && typeof stderr === "string")
    return { view: { ...view, ...(Number.isInteger(exit_code) ? { exitCode: exit_code as number } : {}), stdout, stderr, ...(typeof cwd_after === "string" && view.cwd ? { cwd: cwd_after } : {}) } satisfies ToolView };
  const parsed = call.name === "bash" && typeof content === "string" ? bashText(content) : undefined;
  if (!parsed) return { view };
  // zeta sets is_error for a nonzero exit or a timeout, so a clean result means exit 0; a failure's code is unknown.
  return { view: { ...view, ...parsed, ...(is_error === false ? { exitCode: 0 } : {}) } satisfies ToolView };
};

// zeta's terminal approval decisions (src/zeta/core/approval.py `ApprovalDecision`, plus "abort"); "ask" is not an ending.
const zetaDecisions: ReadonlyMap<unknown, ApprovalDecision> = new Map([["allow", "approve"], ["deny", "deny"], ["abort", "abort"]]);

export function fromZetaEvent(value: unknown): RunEvent[] {
  try {
    const wire = object(value, "event");
    const name = string(wire.event, "event");
    optionalString(wire.session_id, "session_id");
    const data = optionalObject(wire.data, "data") ?? {};
    const notification = childNotification(name, data);
    if (notification) return [notification];

    switch (name) {
      case "agent_start": return [{ type: "run_start", data }];
      case "agent_end": return [{ type: "run_end", data }];
      case "turn_start": return [{ type: "turn_start", data: turnData(data) }];
      case "turn_end": return [{ type: "turn_end", data: turnData(data) }];
      case "message_start": return [{ type: "message_start", data }];
      case "assistant_delta": return [{ type: "message_delta", message_id: optionalString(data.message_id, "data.message_id"), delta: string(wire.delta, "delta"), kind: deltaKind(optionalString(wire.kind, "kind")) }];
      case "assistant_message": return [{ type: "message_commit", message_id: optionalString(data.message_id, "data.message_id"), message: message(wire.message) }];
      case "assistant_reset": return [{ type: "message_reset", data }];
      case "retry": return [{ type: "retry" }];
      case "delivery_status": {
        const status = string(wire.status, "status");
        if (status !== "delivered" && status !== "dropped") throw new Error("status must be delivered or dropped");
        return [{ type: "delivery_status", delivery_id: string(wire.delivery_id, "delivery_id"), method: string(wire.method, "method"), status, content: string(wire.content, "content"), ...(wire.reason === undefined ? {} : { reason: string(wire.reason, "reason") }) }];
      }
      case "tool_start": {
        const call = tool(wire.tool_call);
        return [{ type: "tool_start", tool_call: call, ...viewOf(call), data }];
      }
      case "tool_output": return [{ type: "tool_output", tool_call: tool(wire.tool_call), output: string(wire.output, "output"), data }];
      case "tool_end": {
        const call = tool(wire.tool_call);
        const result = wire.tool_result === undefined || wire.tool_result === null ? {} : { tool_result: toolResult(wire.tool_result) };
        return [{ type: "tool_end", tool_call: call, ...result, ...finishedView(call, wire.tool_result), data }];
      }
      case "approval_request": {
        const call = tool(wire.tool_call);
        const state = wire.state === undefined ? undefined : string(wire.state, "state");
        if (state !== undefined && state !== "reconnecting" && state !== "resolving") throw new Error("state must be reconnecting or resolving");
        const approval: RunEvent = {
          type: "approval_request", request_id: string(wire.request_id, "request_id"), tool_call: call, ...viewOf(call), delegated: boolean(wire.delegated, "delegated"),
          ...(state ? { state } : {}),
          ...(wire.status === undefined ? {} : { status: string(wire.status, "status") }),
          ...(wire.disabled_reason === undefined ? {} : { disabled_reason: string(wire.disabled_reason, "disabled_reason") }),
        };
        const childRunId = optionalString(wire.agent_instance_id, "agent_instance_id");
        return childRunId ? [approval, subAgent({ ...data, child_instance_id: childRunId, description: `approval for ${approval.tool_call.name}` }, "waiting_approval", "approval")] : [approval];
      }
      case "approval_end": {
        const decision = zetaDecisions.get(data.decision);
        const approval: RunEvent = { type: "approval_end", request_id: string(wire.request_id, "request_id"), ...(decision ? { decision } : {}), data };
        const childRunId = optionalString(data.agent_instance_id, "data.agent_instance_id");
        if (!childRunId) return [approval];
        const [status, urgency] = resumedStatus(data);
        return [approval, subAgent({ ...data, child_instance_id: childRunId }, status, urgency)];
      }
      case "usage": {
        // zeta keeps the provider's usage details (a service tier, nested cache counts) beside the token counts: the counts
        // are the usage, the details are dropped.
        const input = wire.usage !== null && typeof wire.usage === "object" && !Array.isArray(wire.usage) ? wire.usage as Record<string, unknown> : {};
        const usage = Object.fromEntries(Object.entries(input).filter((entry): entry is [string, number] => finite(entry[1]) && entry[1] >= 0));
        return [{ type: "usage", usage }];
      }
      case "user_message": {
        // A live echo names each image zeta stored ({ name, mime_type, size }) without its bytes: a file row, as in history.
        const attachments = Array.isArray(wire.attachments) ? wire.attachments.flatMap((item: any) => typeof item?.name === "string" ? [{ type: "file", filename: item.name, ...(typeof item.mime_type === "string" && { mediaType: item.mime_type }), ...(finite(item.size) && { size: item.size }) }] : []) : undefined;
        return [{ type: "user_message", text: string(wire.text, "text"), mode: string(wire.mode, "mode"), ...(attachments === undefined ? {} : { attachments }), ...(wire.delivery_id === undefined ? {} : { delivery_id: string(wire.delivery_id, "delivery_id") }) }];
      }
      case "error": {
        const input = object(wire.error, "error");
        const event: RunEvent = { type: "error", error: { code: string(input.code, "error.code"), message: string(input.message, "error.message") } };
        const childRunId = optionalString(data.agent_instance_id, "data.agent_instance_id");
        return childRunId ? [event, subAgent({ ...data, child_instance_id: childRunId, summary: event.error.message }, "error", "error")] : [event];
      }
      case "turn_aborted": return [{ type: "error", error: { code: "aborted", message: optionalString(wire.message, "message") ?? "turn aborted" } }];
      case "child_message_delivered": {
        const childRunId = optionalString(data.agent_instance_id, "data.agent_instance_id");
        return childRunId
          ? [subAgent(data, "running", undefined, "agent_instance_id")]
          : [{ type: "notification", notification_id: optionalString(data.notification_id, "data.notification_id"), data: { ...data } }];
      }
      case "sub_agent_receipt":
      case "notification_by_kind":
      case "task_exit_notification":
      case "project_inbox_notification": return [{ type: "notification", notification_id: optionalString(data.notification_id, "data.notification_id"), data: { ...data } }];
      case "memory_updated":
      case "compaction_start":
      case "compaction_end":
      case "account_limit":
      case "account_state_unknown": return [{ type: "unknown", name, data: { ...wire, data } }];
      default: return [{ type: "unknown", name, data: { ...wire, data } }];
    }
  } catch (error) {
    return invalid(error);
  }
}

const text = (content: unknown[]) =>
  content.flatMap((block) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string" ? [(block as { text: string }).text] : [])).join("");

const historyRow = (value: unknown, calls: Map<string, ToolCall>): RunEvent[] => {
  const row = object(value, "history row");
  if (row.event === "usage") return fromZetaEvent(row);
  if (row.event === "delivery_status") return fromZetaEvent(row);
  if (row.event === "history_group_truncated") return [{ type: "history_truncated", text: "[history group too large; truncated]" }];
  if (Array.isArray(row.content) && text(row.content) === "[history group too large; truncated]") return [{ type: "history_truncated", text: "[history group too large; truncated]" }];
  if (row.event === "approval_request" || row.event === "approval_end") {
    // History empties tool_use arguments, but an approval row keeps them: the call's result row then gets its full view.
    let call: ToolCall | undefined;
    try { call = tool(row.tool_call); } catch { /* no usable call: the row still maps */ }
    if (call && calls.has(call.id) && Object.keys(call.arguments).length) calls.set(call.id, call);
    return fromZetaEvent(row);
  }
  const id = string(row.id, "history row id");
  const role = string(row.role, "history row role");
  if (!Array.isArray(row.content)) throw new Error("history row content must be an array");
  const content = row.content as unknown[];
  const events: RunEvent[] = [];
  if (row.tool_result !== undefined && row.tool_result !== null) {
    const result = toolResult(row.tool_result);
    const call = calls.get(result.tool_call_id) ?? { id: result.tool_call_id, name: "tool", arguments: {} };
    return [{ type: "tool_end", tool_call: call, tool_result: result, ...finishedView(call, row.tool_result) }];
  }
  if (role === "user") {
    const attachments = content.flatMap((block, index) => (block as { type?: unknown } | null)?.type === "attachment" ? [contentBlock(block, index)] : []);
    events.push({ type: "user_message", message_id: id, text: text(content), mode: "send", ...(attachments.length ? { attachments } : {}), ...(row.delivery_id === undefined ? {} : { delivery_id: string(row.delivery_id, "history row delivery_id") }) });
  } else if (role === "assistant") {
    // History keeps text, thinking, and image stubs; tool_use blocks become tool rows. An empty thinking header carries nothing to show.
    const shown = content.filter((block) => {
      const type = (block as { type?: unknown } | null)?.type;
      return type === "attachment" || ((type === "text" || type === "thinking") && (block as { text?: unknown }).text !== "");
    });
    if (shown.length) events.push({ type: "message_commit", message_id: id, message: message({ role, content: shown }) });
    for (const block of content) {
      if ((block as { type?: unknown } | null)?.type !== "tool_use") continue;
      const call = tool((block as { tool_call?: unknown }).tool_call);
      calls.set(call.id, call);
      events.push({ type: "tool_start", tool_call: call, ...viewOf(call) });
    }
  } else {
    const notification = optionalObject(row.notification ?? undefined, "history row notification");
    events.push({ type: "notification", notification_id: optionalString(notification?.notification_id, "notification.notification_id"), data: { ...notification, role, text: text(content) } });
  }
  const failed = optionalObject(row.failed_turn ?? undefined, "failed_turn");
  if (failed) events.push({ type: "error", error: { code: string(failed.code, "failed_turn.code"), message: string(failed.message, "failed_turn.message") } });
  return events;
};

/**
 * Maps `session_history` rows (oldest first, every page in order) to run events. Tool calls open at their `tool_use`
 * block and close at their result row; a call with no result stays active until a later `run_end`. A row that does not
 * validate becomes one `adapter_invalid_payload` error, and the other rows still map.
 */
export function fromZetaHistory(rows: readonly unknown[]): RunEvent[] {
  const calls = new Map<string, ToolCall>();
  return rows.flatMap((row) => {
    try {
      return historyRow(row, calls);
    } catch (error) {
      return invalid(error);
    }
  });
}
