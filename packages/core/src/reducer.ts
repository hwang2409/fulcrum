import type { RunEvent, RunItem, SubAgentEvent } from "./events.js";
import { appendText } from "./stream.js";

/** Maximum durable notification ids retained for replay dedupe. */
export const RECEIPT_LIMIT = 1_000;

export interface OutlineItem {
  readonly id: string;
  readonly kind: RunItem["type"];
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
}

type MessageDelta = Extract<RunEvent, { type: "message_delta" }>;
type MessageBlock = Extract<RunEvent, { type: "message_block" }>;
type MessageCommit = Extract<RunEvent, { type: "message_commit" }>;
type MessageItem = Extract<RunItem, { type: "message" }>;
const nextMessageId = (next: RunState, supplied?: string) => supplied ?? next.activeMessageId ?? (next.nextId === 1 ? "assistant" : `assistant-${next.nextId}`);
const finishPriorMessage = (next: RunState, id: string, endActiveMessage: () => void) => {
  if (next.activeMessageId && next.activeMessageId !== id) endActiveMessage();
};
const appendMessageOutline = (next: RunState, itemId: string) => {
  next.outline = [...next.outline, { id: itemId, kind: "message" }];
  next.nextId += 1;
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
const reduceMessageDelta = (
  next: RunState,
  event: MessageDelta | MessageBlock,
  getItem: EntityDraft["get"],
  setItem: EntityDraft["set"],
  endActiveMessage: () => void,
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
  if (!prior) appendMessageOutline(next, itemId);
  next.activeMessageId = id;
};
const reduceMessageCommit = (
  next: RunState,
  event: MessageCommit,
  getItem: EntityDraft["get"],
  setItem: EntityDraft["set"],
  endActiveMessage: () => void,
) => {
  const id = nextMessageId(next, event.message_id);
  finishPriorMessage(next, id, endActiveMessage);
  const itemId = messageItemId(id);
  const old = getItem(itemId);
  const prior = old?.type === "message" ? old : undefined;
  setItem({ id: itemId, type: "message", message: event.message, version: (prior?.version ?? 0) + 1, active: false });
  if (!prior) appendMessageOutline(next, itemId);
  next.activeMessageId = undefined;
};

export function reduceAllWithEntities(
  state: RunState,
  events: RunEvent[],
  entities: EntityDraft,
): RunState {
  // An empty delta carries no text: it must not open a row or publish a new state.
  const isEmptyDelta = (event: RunEvent) => event.type === "message_delta" && event.delta === "";
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
  const appendItem = (item: RunItem) => {
    setItem(item);
    next.outline = [...next.outline, { id: item.id, kind: item.type }];
  };
  const deleteItem = (id: string) => {
    entities.delete(id);
    next.outline = next.outline.filter((candidate) => candidate.id !== id);
  };
  const setToolActive = (id: string, active: boolean) => {
    if (Boolean(next.activeToolIds[id]) === active) return;
    next.activeToolIds = { ...next.activeToolIds };
    if (active) next.activeToolIds[id] = true;
    else delete next.activeToolIds[id];
  };
  // One row per call: once a call's approval has resolved and the call has a row, the approval's row folds into the
  // tool's row, which takes the earlier of the two places (live the approval comes first, a replayed history the tool).
  const foldApproval = (toolId: string) => {
    const approvalId = next.toolApprovals[toolId];
    const approval = approvalId ? getItem(approvalId) : undefined;
    const tool = getItem(toolItemId(toolId));
    if (approval?.type !== "approval" || !approval.ended || tool?.type !== "tool") return;
    if (tool.approval !== approval.ended) setItem({ ...tool, approval: approval.ended, version: tool.version + 1 });
    // Folded once: later events of the call (a chatty command's output) skip the outline search.
    next.toolApprovals = { ...next.toolApprovals };
    delete next.toolApprovals[toolId];
    if (!next.outline.some((entry) => entry.id === approvalId)) return;
    const outline = next.outline.filter((entry) => entry.id !== tool.id);
    outline.splice(outline.findIndex((entry) => entry.id === approvalId), 1, { id: tool.id, kind: "tool" });
    next.outline = outline;
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

  for (const event of events) {
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
        reduceMessageDelta(next, event, getItem, setItem, endActiveMessage);
        break;
      case "message_commit":
        reduceMessageCommit(next, event, getItem, setItem, endActiveMessage);
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
      case "user_message": {
        const id = event.intent === undefined ? `user:${next.nextId++}` : `user:intent:${event.intent}`;
        if (getItem(id)) setItem({ id, type: "user", event });
        else appendItem({ id, type: "user", event });
        break;
      }
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
