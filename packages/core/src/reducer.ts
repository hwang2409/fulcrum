import type { RunEvent, RunItem, SubAgentEvent } from "./events.js";
import { appendText } from "./stream.js";

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
}
type SpliceOutline = (index: number, deleteCount: number, items: readonly OutlineItem[]) => void;

type MessageDelta = Extract<RunEvent, { type: "message_delta" }>;
type MessageCommit = Extract<RunEvent, { type: "message_commit" }>;
const nextMessageId = (next: RunState, supplied?: string) => supplied ?? next.activeMessageId ?? (next.nextId === 1 ? "assistant" : `assistant-${next.nextId}`);
const finishPriorMessage = (next: RunState, id: string, endActiveMessage: () => void) => {
  if (next.activeMessageId && next.activeMessageId !== id) endActiveMessage();
};
const appendMessageOutline = (next: RunState, itemId: string, spliceOutline: SpliceOutline) => {
  spliceOutline(next.outline.length, 0, [{ id: itemId, kind: "message" }]);
  next.nextId += 1;
};
// Rows that change are usually recent: search from the end.
const outlineIndex = (outline: readonly OutlineItem[], id: string) => {
  for (let index = outline.length - 1; index >= 0; index--) if (outline[index]!.id === id) return index;
  return -1;
};
const reduceMessageDelta = (
  next: RunState,
  event: MessageDelta,
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
  const streamedKind = event.kind && event.kind !== "assistant" && event.kind !== "text" ? event.kind : undefined;
  const item = streamedKind
    ? (() => {
        const message = prior?.message ?? { role: "assistant", content: [] };
        const content = message.content.map((block) => ({ ...block }));
        const block = content.at(-1);
        if (block?.type === streamedKind && typeof block.text === "string") block.text += event.delta;
        else content.push({ type: streamedKind, text: event.delta });
        return {
          id: itemId,
          type: "message" as const,
          message: { ...message, content },
          version: (prior?.version ?? 0) + 1,
          active: true,
          ...(prior?.text === undefined ? {} : { text: prior.text }),
        };
      })()
    : appendText<RunItem>(
        { id: itemId, type: "message", message: prior?.message ?? { role: "assistant", content: [] }, version: (prior?.version ?? 0) + 1, active: true },
        continuing ? prior : undefined,
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
