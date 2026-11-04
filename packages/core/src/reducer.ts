import type { RunEvent, RunItem, SubAgentEvent } from "./events.js";
import { appendText } from "./stream.js";
import { messageAlias } from "./message-identity.js";

/** Maximum durable notification ids retained for replay dedupe. */
export const RECEIPT_LIMIT = 1_000;

export interface OutlineItem {
  readonly id: string;
  readonly kind: RunItem["type"];
}

/** One positional outline edit, as `Array.prototype.splice` takes it: remove `deleteCount` entries at `index`, insert `items` there. */
export interface OutlineSplice {
  readonly index: number;
  readonly deleteCount: number;
  readonly items: readonly OutlineItem[];
}

export interface RunState {
  turns: string[];
  outline: readonly OutlineItem[];
  usage: Record<string, number>;
  agent: "idle" | "running";
  turn: "idle" | "running";
  receipts: Record<string, boolean>;
  receiptOrder: string[];
  nextId: number;
  activeMessageId?: string;
  activeToolIds: Record<string, boolean>;
  /** Tool call id -> its approval's item id. */
  toolApprovals: Record<string, string>;
}

export const initialState: RunState = {
  turns: [],
  outline: [],
  usage: {},
  agent: "idle",
  turn: "idle",
  receipts: {},
  receiptOrder: [],
  nextId: 1,
  activeToolIds: {},
  toolApprovals: {},
};

const messageItemId = (id: string) => `message:${id}`;
const toolItemId = (id: string) => `tool:${id}`;
const approvalItemId = (id: string) => `approval:${id}`;
const terminalSubAgentStatuses = new Set(["done", "error", "canceled"]);
const subAgentTime = (event: SubAgentEvent) => {
  const value = event.endedAt ?? event.updatedAt ?? event.startedAt;
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
};
const compareSubAgentOrder = (prior: SubAgentEvent, event: SubAgentEvent) => {
  if (prior.sequence !== undefined && event.sequence !== undefined)
    return Math.sign(event.sequence - prior.sequence);
  const before = subAgentTime(prior);
  const after = subAgentTime(event);
  return before === undefined || after === undefined ? undefined : Math.sign(after - before);
};

interface EntityDraft {
  get(id: string): RunItem | undefined;
  set(item: RunItem): void;
  delete(id: string): void;
  /** Called once per outline edit, in order, as the reducer makes it. */
  splice(splice: OutlineSplice): void;
  getMessageAlias(key: string): string | undefined;
  setMessageAlias(key: string, id: string): void;
}
type SpliceOutline = (index: number, deleteCount: number, items: readonly OutlineItem[]) => void;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
type Validator = (value: unknown) => boolean;
interface FieldSchema {
  readonly required: boolean;
  readonly validate: Validator;
  readonly fields?: Readonly<Record<string, FieldSchema>>;
  readonly inspectFields?: boolean;
}
type EventSchema<E> = { readonly [K in Exclude<keyof E, "type">]-?: FieldSchema };
const required = (validate: Validator, fields?: FieldSchema["fields"], inspectFields = false): FieldSchema => ({ required: true, validate, fields, inspectFields });
const optional = (validate: Validator, fields?: FieldSchema["fields"], inspectFields = false): FieldSchema => ({ required: false, validate, fields, inspectFields });
const string: Validator = (value) => typeof value === "string";
const boolean: Validator = (value) => typeof value === "boolean";
const finite: Validator = (value) => typeof value === "number" && Number.isFinite(value);
const oneOf = (...values: readonly unknown[]): Validator => (value) => values.includes(value);
const array: Validator = Array.isArray;
const object: Validator = record;
const usage: Validator = (value) => {
  if (!record(value)) return false;
  for (const amount of Object.values(value)) if (!finite(amount)) return false;
  return true;
};
const toolCall: Validator = (value) => record(value) && string(value.id) && string(value.name) && record(value.arguments);
const message: Validator = (value) => record(value) && string(value.role) && array(value.content);
const block: Validator = (value) => record(value) && string(value.type);
const error: Validator = (value) => record(value) && string(value.code) && string(value.message);
const toolCallFields = { id: required(string), name: required(string), arguments: required(object) };
const messageFields = { role: required(string), content: required(array) };
const toolResultFields = {
  tool_call_id: required(string),
  content: required(string),
  is_error: required(boolean),
  is_canceled: optional(boolean),
};

/** Every consumed event field declares whether invalid data rejects the event or is omitted from it. */
export const eventSchemas = {
  run_start: { data: optional(object) },
  run_end: { data: optional(object) },
  turn_start: { data: optional(object) },
  turn_end: { data: optional(object) },
  message_start: { data: optional(object) },
  message_reset: { data: optional(object) },
  retry: {},
  message_delta: { message_id: optional(string), delta: required(string), kind: optional(string) },
  message_block: { message_id: optional(string), block: required(block, { type: required(string) }) },
  message_commit: { message_id: optional(string), message: required(message, messageFields) },
  tool_start: { tool_call: required(toolCall, toolCallFields), view: optional(object), data: optional(object) },
  tool_input: { tool_call: required(toolCall, toolCallFields), input: required(string), view: optional(object), data: optional(object) },
  tool_output: { tool_call: required(toolCall, toolCallFields), output: required(string), view: optional(object), data: optional(object) },
  tool_end: { tool_call: required(toolCall, toolCallFields), tool_result: optional(object, toolResultFields, true), view: optional(object), data: optional(object) },
  approval_request: { request_id: required(string), tool_call: required(toolCall, toolCallFields), view: optional(object), delegated: required(boolean) },
  approval_end: { request_id: required(string), decision: optional(oneOf("approve", "deny", "abort")), data: optional(object) },
  usage: { usage: required(usage) },
  user_message: { text: required(string), mode: required(string), attachments: optional(array), delivery_id: optional(string), intent: optional(string) },
  error: { error: required(error, { code: required(string), message: required(string) }) },
  notification: { notification_id: optional(string), data: optional(object) },
  unknown: { name: required(string), data: required(object, { notification_id: optional(string) }, true) },
  sub_agent: {
    childRunId: required(string),
    status: required(oneOf("running", "waiting_approval", "waiting_input", "idle", "done", "error", "canceled")),
    name: optional(string),
    task: optional(string),
    latestActivity: optional(string),
    toolCount: optional(finite),
    summary: optional(string),
    urgency: optional(oneOf("approval", "input", "error")),
    notificationId: optional(string),
    startedAt: optional(string),
    updatedAt: optional(string),
    endedAt: optional(string),
    sequence: optional(finite),
  },
} satisfies { readonly [T in RunEvent["type"]]: EventSchema<Extract<RunEvent, { type: T }>> };

const OMIT = Symbol("omit invalid optional field");
type Sanitized = { readonly value?: Record<string, unknown>; readonly count: number };
const sanitizeFields = (input: Record<string, unknown>, schema: Readonly<Record<string, FieldSchema>>): Sanitized => {
  let count = 0;
  let changes: Map<string, unknown> | undefined;
  for (const field in schema) {
    const rule = schema[field]!;
    let value: unknown;
    let invalid = false;
    try {
      value = input[field];
      invalid = value !== undefined && !rule.validate(value);
    } catch {
      invalid = true;
    }
    if (value === undefined || invalid) {
      if (rule.required) return { count: 0 };
      if (invalid) {
        (changes ??= new Map()).set(field, OMIT);
        count++;
      }
      continue;
    }
    if (!rule.inspectFields || !rule.fields) continue;
    const nested = sanitizeFields(value as Record<string, unknown>, rule.fields);
    if (!nested.value) return { count: 0 };
    count += nested.count;
    if (nested.value !== value) (changes ??= new Map()).set(field, nested.value);
  }
  if (!changes) return { value: input, count };
  try {
    const descriptors = Object.getOwnPropertyDescriptors(input);
    for (const [field, value] of changes) {
      if (value === OMIT) delete descriptors[field];
      else descriptors[field] = { value, enumerable: descriptors[field]?.enumerable ?? true, configurable: true, writable: true };
    }
    return { value: Object.create(Object.getPrototypeOf(input), descriptors) as Record<string, unknown>, count };
  } catch {
    return { count: 0 };
  }
};

const validateEvent = (input: unknown, onSanitized?: (count: number) => void): RunEvent | undefined => {
  if (!record(input) || typeof input.type !== "string") return undefined;
  const type = input.type;
  const schema = eventSchemas[type as RunEvent["type"]] as Readonly<Record<string, FieldSchema>> | undefined;
  if (!schema)
    return { type: "unknown", name: type, data: record(input.data) ? input.data : {} };
  const sanitized = sanitizeFields(input, schema);
  if (!sanitized.value) return undefined;
  if (sanitized.count) onSanitized?.(sanitized.count);
  return sanitized.value as unknown as RunEvent;
};

type MessageDelta = Extract<RunEvent, { type: "message_delta" }>;
type MessageBlock = Extract<RunEvent, { type: "message_block" }>;
type MessageCommit = Extract<RunEvent, { type: "message_commit" }>;
type MessageItem = Extract<RunItem, { type: "message" }>;
const nextMessageId = (next: RunState, supplied?: string) => supplied ?? next.activeMessageId ?? (next.nextId === 1 ? "assistant" : `assistant-${next.nextId}`);
const finishPriorMessage = (next: RunState, id: string, endActiveMessage: () => void) => {
  if (next.activeMessageId && next.activeMessageId !== id) endActiveMessage();
};
const appendMessageOutline = (next: RunState, itemId: string, spliceOutline: SpliceOutline) => {
  spliceOutline(next.outline.length, 0, [{ id: itemId, kind: "message" }]);
  next.nextId += 1;
};
const reduceUserMessage = (
  next: RunState,
  event: Extract<RunEvent, { type: "user_message" }>,
  entities: EntityDraft,
  appendItem: (item: RunItem) => void,
  setItem: EntityDraft["set"],
) => {
  const intentId = event.intent === undefined ? undefined : `user:intent:${event.intent}`;
  const deliveryId = event.delivery_id === undefined ? undefined : messageAlias(event.delivery_id);
  const deliveryItemId = event.delivery_id === undefined ? undefined : `user:delivery:${event.delivery_id}`;
  const id = (deliveryId && entities.getMessageAlias(deliveryId)) ||
    (intentId && entities.getMessageAlias(intentId)) ||
    (intentId && entities.get(intentId) ? intentId : undefined) ||
    intentId || deliveryItemId || `user:${next.nextId++}`;
  if (entities.get(id)) setItem({ id, type: "user", event });
  else appendItem({ id, type: "user", event });
  if (deliveryId) entities.setMessageAlias(deliveryId, id);
  if (intentId) entities.setMessageAlias(intentId, id);
};
/**
 * A streaming message reads as its content blocks, then its text tail. A block that is not text first moves the tail
 * into the content as a text block, so text, reasoning, and sources keep the order they arrived in. Only the last
 * block is copied: the other blocks keep their identity, so their renderers skip the update.
 */
const appendBlock = (prior: MessageItem | undefined, itemId: string, event: MessageDelta | MessageBlock, version: number): MessageItem => {
  const message = prior?.message ?? { role: "assistant", content: [] };
  const content = message.content.slice();
  if (prior?.text) content.push({ type: "text", text: prior.text });
  const last = content.at(-1);
  if (event.type === "message_block") content.push(event.block);
  else if (last && last.type === event.kind && typeof last.text === "string" && !prior?.text) content[content.length - 1] = { ...last, text: last.text + event.delta };
  else content.push({ type: event.kind!, text: event.delta });
  return { id: itemId, type: "message", message: { ...message, content }, version, active: true };
};
// Rows that change are usually recent: search from the end.
const outlineIndex = (outline: readonly OutlineItem[], id: string) => {
  for (let index = outline.length - 1; index >= 0; index--) if (outline[index]!.id === id) return index;
  return -1;
};
const reduceMessageDelta = (
  next: RunState,
  event: MessageDelta | MessageBlock,
  getItem: EntityDraft["get"],
  setItem: EntityDraft["set"],
  endActiveMessage: () => void,
  spliceOutline: SpliceOutline,
) => {
  const id = nextMessageId(next, event.message_id);
  finishPriorMessage(next, id, endActiveMessage);
  const itemId = messageItemId(id);
  const old = getItem(itemId);
  const continuing = next.activeMessageId === id;
  const prior = old?.type === "message" ? old : undefined;
  // A stream that is not the active one restarts its message: it replaces what the message had, never appends to it.
  const base = continuing ? prior : undefined;
  const version = (prior?.version ?? 0) + 1;
  const text = event.type === "message_delta" && (!event.kind || event.kind === "assistant" || event.kind === "text");
  const item = !text
    ? appendBlock(base, itemId, event, version)
    : appendText<RunItem>(
        { id: itemId, type: "message", message: base?.message ?? { role: "assistant", content: [] }, version, active: true },
        base,
        "text",
        () => prior?.text ?? "",
        event.delta,
      );
  setItem(item);
  if (!prior) appendMessageOutline(next, itemId, spliceOutline);
  next.activeMessageId = id;
};
const reduceMessageCommit = (
  next: RunState,
  event: MessageCommit,
  getItem: EntityDraft["get"],
  setItem: EntityDraft["set"],
  endActiveMessage: () => void,
  spliceOutline: SpliceOutline,
) => {
  const id = nextMessageId(next, event.message_id);
  finishPriorMessage(next, id, endActiveMessage);
  const itemId = messageItemId(id);
  const old = getItem(itemId);
  const prior = old?.type === "message" ? old : undefined;
  setItem({ id: itemId, type: "message", message: event.message, version: (prior?.version ?? 0) + 1, active: false });
  if (!prior) appendMessageOutline(next, itemId, spliceOutline);
  next.activeMessageId = undefined;
};

/** Internal direct reductions write their supplied entity and alias maps; callers own those maps and the returned state. */
export function reduceAllWithEntities(
  state: RunState,
  events: RunEvent[],
  entities: EntityDraft,
  onInvalid?: (event: RunEvent) => void,
  onSanitized?: (count: number) => void,
): RunState {
  // An empty delta carries no text: it must not open a row or publish a new state.
  const isEmptyDelta = (event: RunEvent | null) => event?.type === "message_delta" && event.delta === "";
  if (events.some(isEmptyDelta)) events = events.filter((event) => !isEmptyDelta(event));
  if (events.length === 0) return state;

  const next: RunState = {
    turns: state.turns,
    outline: state.outline,
    usage: state.usage,
    agent: state.agent,
    turn: state.turn,
    receipts: state.receipts,
    receiptOrder: state.receiptOrder,
    nextId: state.nextId,
    activeMessageId: state.activeMessageId,
    activeToolIds: state.activeToolIds,
    toolApprovals: state.toolApprovals,
  };
  const getItem = (id: string) => entities.get(id);
  const setItem = (item: RunItem) => entities.set(item);
  // The first edit copies the outline; later edits in the same batch write that copy in place.
  let ownOutline = false;
  const spliceOutline: SpliceOutline = (index, deleteCount, items) => {
    if (!ownOutline) next.outline = next.outline.slice();
    ownOutline = true;
    (next.outline as OutlineItem[]).splice(index, deleteCount, ...items);
    entities.splice({ index, deleteCount, items });
  };
  const appendItem = (item: RunItem) => {
    setItem(item);
    spliceOutline(next.outline.length, 0, [{ id: item.id, kind: item.type }]);
  };
  const deleteItem = (id: string) => {
    entities.delete(id);
    const index = outlineIndex(next.outline, id);
    if (index >= 0) spliceOutline(index, 1, []);
  };
  const setToolActive = (id: string, active: boolean) => {
    if (Boolean(next.activeToolIds[id]) === active) return;
    next.activeToolIds = { ...next.activeToolIds };
    if (active) next.activeToolIds[id] = true;
    else delete next.activeToolIds[id];
  };
  // One row per call: once a call's approval has resolved and the call has a row, the approval's row folds into the
  // tool's row, which takes the earlier of the two places (live the approval comes first, a replayed history the tool).
  // Positional edits only, so views keep every other row as it is.
  const foldApproval = (toolId: string) => {
    const approvalId = next.toolApprovals[toolId];
    const approval = approvalId ? getItem(approvalId) : undefined;
    const tool = getItem(toolItemId(toolId));
    if (approval?.type !== "approval" || !approval.ended || tool?.type !== "tool") return;
    if (tool.approval !== approval.ended) setItem({ ...tool, approval: approval.ended, version: tool.version + 1 });
    // Folded once: later events of the call (a chatty command's output) skip the outline search.
    next.toolApprovals = { ...next.toolApprovals };
    delete next.toolApprovals[toolId];
    const approvalIndex = outlineIndex(next.outline, approvalId!);
    if (approvalIndex < 0) return;
    const toolIndex = outlineIndex(next.outline, tool.id);
    if (toolIndex >= 0 && toolIndex < approvalIndex) return spliceOutline(approvalIndex, 1, []);
    if (toolIndex >= 0) spliceOutline(toolIndex, 1, []);
    spliceOutline(approvalIndex, 1, [{ id: tool.id, kind: "tool" }]);
  };
  const endActiveMessage = () => {
    if (!next.activeMessageId) return;
    const item = getItem(messageItemId(next.activeMessageId));
    if (item?.type === "message" && item.active)
      setItem({ ...item, active: false });
    next.activeMessageId = undefined;
  };
  const endActiveStreams = () => {
    endActiveMessage();
    for (const toolId of Object.keys(next.activeToolIds)) {
      const item = getItem(toolItemId(toolId));
      if (item?.type === "tool" && item.active)
        setItem({ ...item, active: false });
    }
    next.activeToolIds = {};
  };

  for (const value of events) {
    const event = validateEvent(value, onSanitized);
    if (!event) { onInvalid?.(value); continue; }
    const candidate =
      event.type === "notification"
        ? event.notification_id
        : event.type === "sub_agent"
          ? event.notificationId
          : event.type === "unknown"
            ? event.data.notification_id
            : undefined;
    const receipt = typeof candidate === "string" ? candidate : undefined;
    if (receipt && next.receipts[receipt]) continue;
    if (receipt) {
      const receipts = { ...next.receipts, [receipt]: true };
      const order = [...next.receiptOrder, receipt];
      if (order.length > RECEIPT_LIMIT) delete receipts[order.shift()!];
      next.receipts = receipts;
      next.receiptOrder = order;
    }

    switch (event.type) {
      case "run_start":
        next.agent = "running";
        break;
      case "run_end":
        next.agent = "idle";
        next.turn = "idle";
        endActiveStreams();
        break;
      case "turn_start":
        next.turn = "running";
        next.turns = [
          ...next.turns,
          String(event.data?.turn ?? next.turns.length + 1),
        ];
        break;
      case "turn_end":
        next.turn = "idle";
        endActiveMessage();
        break;
      case "message_start":
        break;
      case "message_delta":
      case "message_block":
        reduceMessageDelta(next, event, getItem, setItem, endActiveMessage, spliceOutline);
        break;
      case "message_commit":
        reduceMessageCommit(next, event, getItem, setItem, endActiveMessage, spliceOutline);
        break;
      case "message_reset": {
        if (!next.activeMessageId) break;
        deleteItem(messageItemId(next.activeMessageId));
        next.activeMessageId = undefined;
        break;
      }
      case "retry":
        endActiveMessage();
        break;
      case "tool_start": {
        const id = event.tool_call.id;
        const itemId = toolItemId(id);
        const old = getItem(itemId);
        const prior = old?.type === "tool" ? old : undefined;
        const exists = Boolean(prior);
        const item: RunItem = {
          id: itemId,
          type: "tool",
          tool_call: event.tool_call,
          view: event.view,
          output: "",
          version: 1,
          active: true,
          is_error: false,
          canceled: false,
          ...(prior?.approval ? { approval: prior.approval } : {}),
        };
        if (exists) setItem(item);
        else appendItem(item);
        setToolActive(id, true);
        foldApproval(id);
        break;
      }
      case "tool_input": {
        const id = event.tool_call.id;
        const itemId = toolItemId(id);
        const old = getItem(itemId);
        const prior = old?.type === "tool" ? old : undefined;
        if (!prior) {
          appendItem({ id: itemId, type: "tool", tool_call: event.tool_call, view: event.view, output: "", version: 1, active: true, is_error: false, canceled: false });
          setToolActive(id, true);
          foldApproval(id);
          break;
        }
        setItem({ ...prior, tool_call: event.tool_call, view: event.view ?? prior.view, version: prior.version + 1 });
        foldApproval(id);
        break;
      }
      case "tool_output": {
        const id = event.tool_call.id;
        const itemId = toolItemId(id);
        const old = getItem(itemId);
        const prior = old?.type === "tool" ? old : undefined;
        const continuing = Boolean(next.activeToolIds[id]);
        const item = appendText<RunItem>(
          {
            id: itemId,
            type: "tool",
            tool_call: prior?.tool_call.arguments === event.tool_call.arguments ? prior.tool_call : event.tool_call,
            view: event.view ?? prior?.view,
            output: "",
            version: (prior?.version ?? 0) + 1,
            active: true,
            result: prior?.result,
            is_error: prior?.is_error ?? false,
            canceled: prior?.canceled ?? false,
            ...(prior?.approval ? { approval: prior.approval } : {}),
          },
          continuing ? prior : undefined,
          "output",
          () => prior?.output ?? "",
          event.output,
        );
        if (prior) setItem(item);
        else appendItem(item);
        setToolActive(id, true);
        foldApproval(id);
        break;
      }
      case "tool_end": {
        const id = event.tool_call.id;
        const itemId = toolItemId(id);
        const old = getItem(itemId);
        const prior = old?.type === "tool" ? old : undefined;
        const result = event.tool_result;
        const item: RunItem = {
          id: itemId,
          type: "tool",
          tool_call: prior?.tool_call ?? event.tool_call,
          view: event.view ?? prior?.view,
          output: prior?.output ?? "",
          version: (prior?.version ?? 0) + 1,
          active: false,
          result,
          is_error: result?.is_error ?? false,
          canceled: result?.is_canceled ?? false,
          ...(prior?.approval ? { approval: prior.approval } : {}),
        };
        if (prior) setItem(item);
        else appendItem(item);
        setToolActive(id, false);
        foldApproval(id);
        break;
      }
      case "approval_request": {
        const itemId = approvalItemId(event.request_id);
        const old = getItem(itemId);
        // A request can arrive twice (a status snapshot and the live event); it stays one row.
        if (old?.type === "approval") setItem({ ...old, request: event });
        else appendItem({ id: itemId, type: "approval", request: event });
        if (next.toolApprovals[event.tool_call.id] !== itemId) next.toolApprovals = { ...next.toolApprovals, [event.tool_call.id]: itemId };
        foldApproval(event.tool_call.id);
        break;
      }
      case "approval_end": {
        const itemId = approvalItemId(event.request_id);
        const old = getItem(itemId);
        if (old?.type !== "approval") break;
        setItem({ ...old, ended: event });
        if (old.request.type === "approval_request") foldApproval(old.request.tool_call.id);
        break;
      }
      case "usage": {
        const usage = { ...next.usage };
        for (const [key, value] of Object.entries(event.usage))
          usage[key] = (usage[key] ?? 0) + value;
        next.usage = usage;
        break;
      }
      case "user_message":
        reduceUserMessage(next, event, entities, appendItem, setItem);
        break;
      case "error": {
        const id = `error:${next.nextId++}`;
        next.agent = "idle";
        next.turn = "idle";
        endActiveStreams();
        appendItem({ id, type: "error", event });
        break;
      }
      case "notification": {
        const id = `notification:${next.nextId++}`;
        appendItem({ id, type: "notification", event });
        break;
      }
      case "sub_agent": {
        const id = `sub-agent:${event.childRunId}`;
        const prior = getItem(id);
        if (prior?.type === "sub_agent") {
          const order = compareSubAgentOrder(prior, event);
          const priorTerminal = terminalSubAgentStatuses.has(prior.status);
          if (order === -1 || (priorTerminal && (order === undefined || !terminalSubAgentStatuses.has(event.status)))) break;
          const toolCount = prior.toolCount === undefined || event.toolCount === undefined ? event.toolCount ?? prior.toolCount : Math.max(prior.toolCount, event.toolCount);
          setItem({ ...prior, ...event, id, urgency: event.urgency, toolCount });
        } else {
          appendItem({ ...event, id });
        }
        break;
      }
      case "unknown": {
        const id = `unknown:${next.nextId++}`;
        appendItem({ id, type: "unknown", event });
        break;
      }
    }
  }
  return next;
}
