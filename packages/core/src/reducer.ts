import type { RunEvent, RunItem } from "./events.js";
import { appendText } from "./stream.js";

/** Maximum durable notification ids retained for replay dedupe. */
export const RECEIPT_LIMIT = 1_000;

export interface OutlineItem {
  id: string;
  kind: RunItem["type"];
}

export interface RunState {
  turns: string[];
  items: string[];
  outline: OutlineItem[];
  itemsById: Record<string, RunItem>;
  usage: Record<string, number>;
  agent: "idle" | "running";
  turn: "idle" | "running";
  receipts: Record<string, boolean>;
  receiptOrder: string[];
  nextId: number;
  activeMessageId?: string;
  activeToolIds: Record<string, boolean>;
}

export const initialState: RunState = {
  turns: [],
  items: [],
  outline: [],
  itemsById: {},
  usage: {},
  agent: "idle",
  turn: "idle",
  receipts: {},
  receiptOrder: [],
  nextId: 1,
  activeToolIds: {},
};

const messageItemId = (id: string) => `message:${id}`;
const toolItemId = (id: string) => `tool:${id}`;
const approvalItemId = (id: string) => `approval:${id}`;

interface EntityDraft {
  get(id: string): RunItem | undefined;
  set(item: RunItem): void;
  delete(id: string): void;
}

export function reduceAllWithEntities(
  state: RunState,
  events: RunEvent[],
  entities: EntityDraft,
): RunState {
  if (events.length === 0) return state;

  const next: RunState = {
    turns: state.turns,
    items: state.items,
    outline: state.outline,
    itemsById: {},
    usage: state.usage,
    agent: state.agent,
    turn: state.turn,
    receipts: state.receipts,
    receiptOrder: state.receiptOrder,
    nextId: state.nextId,
    activeMessageId: state.activeMessageId,
    activeToolIds: state.activeToolIds,
  };
  const getItem = (id: string) => entities.get(id);
  const setItem = (item: RunItem) => entities.set(item);
  const appendItem = (item: RunItem) => {
    setItem(item);
    next.items = [...next.items, item.id];
    next.outline = [...next.outline, { id: item.id, kind: item.type }];
  };
  const deleteItem = (id: string) => {
    entities.delete(id);
    next.items = next.items.filter((candidate) => candidate !== id);
    next.outline = next.outline.filter((candidate) => candidate.id !== id);
  };
  const setToolActive = (id: string, active: boolean) => {
    if (Boolean(next.activeToolIds[id]) === active) return;
    next.activeToolIds = { ...next.activeToolIds };
    if (active) next.activeToolIds[id] = true;
    else delete next.activeToolIds[id];
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
      case "message_delta": {
        const id =
          event.message_id ??
          next.activeMessageId ??
          (next.nextId === 1 ? "assistant" : `assistant-${next.nextId}`);
        if (next.activeMessageId && next.activeMessageId !== id)
          endActiveMessage();
        const itemId = messageItemId(id);
        const old = getItem(itemId);
        const continuing = next.activeMessageId === id;
        const prior = old?.type === "message" ? old : undefined;
        const item = appendText<RunItem>(
          {
            id: itemId,
            type: "message",
            message: prior?.message ?? { role: "assistant", content: [] },
            version: (prior?.version ?? 0) + 1,
            active: true,
          },
          continuing ? prior : undefined,
          "text",
          () => prior?.text ?? "",
          event.delta,
        );
        setItem(item);
        if (!prior) {
          next.items = [...next.items, itemId];
          next.outline = [...next.outline, { id: itemId, kind: "message" }];
          next.nextId += 1;
        }
        next.activeMessageId = id;
        break;
      }
      case "message_commit": {
        const id =
          event.message_id ??
          next.activeMessageId ??
          (next.nextId === 1 ? "assistant" : `assistant-${next.nextId}`);
        if (next.activeMessageId && next.activeMessageId !== id)
          endActiveMessage();
        const itemId = messageItemId(id);
        const old = getItem(itemId);
        const prior = old?.type === "message" ? old : undefined;
        setItem({
          id: itemId,
          type: "message",
          message: event.message,
          version: (prior?.version ?? 0) + 1,
          active: false,
        });
        if (!prior) {
          next.items = [...next.items, itemId];
          next.outline = [...next.outline, { id: itemId, kind: "message" }];
          next.nextId += 1;
        }
        next.activeMessageId = undefined;
        break;
      }
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
        const exists = getItem(itemId)?.type === "tool";
        const item: RunItem = {
          id: itemId,
          type: "tool",
          tool_call: event.tool_call,
          output: "",
          version: 1,
          active: true,
          is_error: false,
          canceled: false,
        };
        if (exists) setItem(item);
        else appendItem(item);
        setToolActive(id, true);
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
            tool_call: prior?.tool_call ?? event.tool_call,
            output: "",
            version: (prior?.version ?? 0) + 1,
            active: true,
            result: prior?.result,
            is_error: prior?.is_error ?? false,
            canceled: prior?.canceled ?? false,
          },
          continuing ? prior : undefined,
          "output",
          () => prior?.output ?? "",
          event.output,
        );
        if (prior) setItem(item);
        else appendItem(item);
        setToolActive(id, true);
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
          output: prior?.output ?? "",
          version: (prior?.version ?? 0) + 1,
          active: false,
          result,
          is_error: result?.is_error ?? false,
          canceled: result?.is_canceled ?? false,
        };
        if (prior) setItem(item);
        else appendItem(item);
        setToolActive(id, false);
        break;
      }
      case "approval_request": {
        const itemId = approvalItemId(event.request_id);
        appendItem({ id: itemId, type: "approval", request: event });
        break;
      }
      case "approval_end": {
        const itemId = approvalItemId(event.request_id);
        const old = getItem(itemId);
        if (old?.type === "approval") setItem({ ...old, ended: event });
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
        const id = `user:${next.nextId++}`;
        appendItem({ id, type: "user", event });
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
      case "unknown": {
        const id = `unknown:${next.nextId++}`;
        appendItem({ id, type: "unknown", event });
        break;
      }
    }
  }
  return next;
}

type EntitySource = { get(id: string): RunItem | undefined };
const entitySources = new WeakMap<RunState, EntitySource>();

export function reduceAll(state: RunState, events: RunEvent[]): RunState {
  if (events.length === 0) return state;
  const source =
    entitySources.get(state) ??
    ({ get: (id: string) => state.itemsById[id] } satisfies EntitySource);
  const changes = new Map<string, RunItem | undefined>();
  const get = (id: string) =>
    changes.has(id) ? changes.get(id) : source.get(id);
  const next = reduceAllWithEntities(state, events, {
    get,
    set: (item) => changes.set(item.id, item),
    delete: (id) => changes.set(id, undefined),
  });
  let materialized: Record<string, RunItem> | undefined;
  Object.defineProperty(next, "itemsById", {
    enumerable: true,
    get() {
      if (materialized) return materialized;
      materialized = {};
      for (const { id } of next.outline) {
        const item = get(id);
        if (item) materialized[id] = item;
      }
      return materialized;
    },
  });
  entitySources.set(next, { get });
  return next;
}

export function reduce(state: RunState, event: RunEvent): RunState {
  return reduceAll(state, [event]);
}
