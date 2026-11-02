import type {
  ContentBlock,
  Message,
  RunEvent,
  SubAgentEvent,
  SubAgentStatus,
  SubAgentUrgency,
  ToolCall,
  ToolResult,
} from "@fulcrum/core";

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
  };
};

const contentBlock = (value: unknown, index: number): ContentBlock => {
  const input = object(value, `message.content[${index}]`);
  const type = string(input.type, `message.content[${index}].type`);
  switch (type) {
    case "text":
    case "thinking":
      return {
        type,
        text: typeof input.text === "string" ? input.text : (() => { throw new Error(`message.content[${index}].text must be a string`); })(),
        ...(input.signature === undefined ? {} : { signature: string(input.signature, `message.content[${index}].signature`) }),
      };
    case "image":
      return {
        type,
        data: string(input.data, `message.content[${index}].data`),
        mimeType: string(input.mimeType, `message.content[${index}].mimeType`),
      };
    case "redacted_thinking":
      return { type, data: string(input.data, `message.content[${index}].data`) };
    case "tool_use":
      return { type, tool_call: tool(input.tool_call) };
    default:
      throw new Error(`message.content[${index}].type is unsupported`);
  }
};

const toolResult = (value: unknown): ToolResult => {
  const input = object(value, "tool_result");
  return {
    tool_call_id: string(input.tool_call_id, "tool_result.tool_call_id"),
    content: typeof input.content === "string" ? input.content : (() => { throw new Error("tool_result.content must be a string"); })(),
    is_error: boolean(input.is_error, "tool_result.is_error"),
    ...(input.is_canceled === undefined ? {} : { is_canceled: boolean(input.is_canceled, "tool_result.is_canceled") }),
  };
};

const message = (value: unknown): Message => {
  const input = object(value, "message");
  if (!Array.isArray(input.content)) throw new Error("message.content must be an array");
  const result: Message = {
    role: string(input.role, "message.role"),
    content: Array.from(input.content, contentBlock),
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
      case "assistant_delta": return [{ type: "message_delta", message_id: optionalString(data.message_id, "data.message_id"), delta: string(wire.delta, "delta"), kind: optionalString(wire.kind, "kind") ?? "assistant" }];
      case "assistant_message": return [{ type: "message_commit", message_id: optionalString(data.message_id, "data.message_id"), message: message(wire.message) }];
      case "assistant_reset": return [{ type: "message_reset", data }];
      case "retry": return [{ type: "retry" }];
      case "tool_start": return [{ type: "tool_start", tool_call: tool(wire.tool_call), data }];
      case "tool_output": return [{ type: "tool_output", tool_call: tool(wire.tool_call), output: string(wire.output, "output"), data }];
      case "tool_end": return [{ type: "tool_end", tool_call: tool(wire.tool_call), ...(wire.tool_result === undefined || wire.tool_result === null ? {} : { tool_result: toolResult(wire.tool_result) }), data }];
      case "approval_request": {
        const approval: RunEvent = { type: "approval_request", request_id: string(wire.request_id, "request_id"), tool_call: tool(wire.tool_call), delegated: boolean(wire.delegated, "delegated") };
        const childRunId = optionalString(wire.agent_instance_id, "agent_instance_id");
        return childRunId ? [approval, subAgent({ ...data, child_instance_id: childRunId, description: `approval for ${approval.tool_call.name}` }, "waiting_approval", "approval")] : [approval];
      }
      case "approval_end": {
        const approval: RunEvent = { type: "approval_end", request_id: string(wire.request_id, "request_id"), data };
        const childRunId = optionalString(data.agent_instance_id, "data.agent_instance_id");
        if (!childRunId) return [approval];
        const [status, urgency] = resumedStatus(data);
        return [approval, subAgent({ ...data, child_instance_id: childRunId }, status, urgency)];
      }
      case "usage": {
        const input = object(wire.usage, "usage");
        if (Object.values(input).some((item) => typeof item !== "number" || !Number.isFinite(item))) throw new Error("usage must contain finite numbers");
        return [{ type: "usage", usage: { ...input } as Record<string, number> }];
      }
      case "user_message": {
        if (wire.attachments !== undefined && !Array.isArray(wire.attachments)) throw new Error("attachments must be an array");
        return [{ type: "user_message", text: string(wire.text, "text"), mode: string(wire.mode, "mode"), ...(wire.attachments === undefined ? {} : { attachments: [...wire.attachments] }) }];
      }
      case "error": {
        const input = object(wire.error, "error");
        const event: RunEvent = { type: "error", error: { code: string(input.code, "error.code"), message: string(input.message, "error.message") } };
        const childRunId = optionalString(data.agent_instance_id, "data.agent_instance_id");
        return childRunId ? [event, subAgent({ ...data, child_instance_id: childRunId, summary: event.error.message }, "error", "error")] : [event];
      }
      case "turn_aborted": return [{ type: "error", error: { code: "turn_aborted", message: optionalString(wire.message, "message") ?? "turn aborted" } }];
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
