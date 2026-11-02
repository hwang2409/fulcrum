import type { RunEvent, RunItem } from "./events.js";

export interface RunState {
  turns: string[];
  items: string[];
  itemsById: Record<string, RunItem>;
  usage: Record<string, number>;
  agent: "idle" | "running";
  turn: "idle" | "running";
  receipts: Record<string, boolean>;
  nextId: number;
  activeMessageId?: string;
  activeToolIds: Record<string, boolean>;
}

export const initialState: RunState = {
  turns: [],
  items: [],
  itemsById: {},
  usage: {},
  agent: "idle",
  turn: "idle",
  receipts: {},
  nextId: 1,
  activeToolIds: {},
};

const messageItemId = (id: string) => `message:${id}`;
const toolItemId = (id: string) => `tool:${id}`;
const approvalItemId = (id: string) => `approval:${id}`;

export function reduceAll(state: RunState, events: RunEvent[]): RunState {
  if (events.length === 0) return state;

  const next: RunState = { ...state };
  let ownsItems = false;
  const setItem = (item: RunItem) => {
    if (!ownsItems) {
      next.itemsById = { ...next.itemsById };
      ownsItems = true;
    }
    next.itemsById[item.id] = item;
  };
  const appendItem = (item: RunItem) => {
    setItem(item);
    next.items = [...next.items, item.id];
  };
  const deleteItem = (id: string) => {
    if (!ownsItems) {
      next.itemsById = { ...next.itemsById };
      ownsItems = true;
    }
    delete next.itemsById[id];
    next.items = next.items.filter((candidate) => candidate !== id);
  };
  const setToolActive = (id: string, active: boolean) => {
    next.activeToolIds = { ...next.activeToolIds };
    if (active) next.activeToolIds[id] = true;
    else delete next.activeToolIds[id];
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
    if (receipt) next.receipts = { ...next.receipts, [receipt]: true };

    switch (event.type) {
      case "run_start":
        next.agent = "running";
        break;
      case "run_end":
        next.agent = "idle";
        next.turn = "idle";
        next.activeMessageId = undefined;
        next.activeToolIds = {};
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
        next.activeMessageId = undefined;
        break;
      case "message_start":
        break;
      case "message_delta": {
        const id =
          event.message_id ??
          next.activeMessageId ??
          (next.nextId === 1 ? "assistant" : `assistant-${next.nextId}`);
        const itemId = messageItemId(id);
        const old = next.itemsById[itemId];
        const continuing = next.activeMessageId === id;
        const prior = old?.type === "message" ? old : undefined;
        const item: RunItem = {
          id: itemId,
          type: "message",
          message: prior?.message ?? { role: "assistant", content: [] },
          text: (continuing ? prior?.text ?? "" : "") + event.delta,
          version: (prior?.version ?? 0) + 1,
        };
        setItem(item);
        if (!prior) {
          next.items = [...next.items, itemId];
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
        const itemId = messageItemId(id);
        const old = next.itemsById[itemId];
        const prior = old?.type === "message" ? old : undefined;
        setItem({
          id: itemId,
          type: "message",
          message: event.message,
          version: (prior?.version ?? 0) + 1,
        });
        if (!prior) {
          next.items = [...next.items, itemId];
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
        next.activeMessageId = undefined;
        break;
      case "tool_start": {
        const id = event.tool_call.id;
        const itemId = toolItemId(id);
        const exists = next.itemsById[itemId]?.type === "tool";
        const item: RunItem = {
          id: itemId,
          type: "tool",
          tool_call: event.tool_call,
          output: "",
          version: 1,
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
        const old = next.itemsById[itemId];
        const prior = old?.type === "tool" ? old : undefined;
        const continuing = Boolean(next.activeToolIds[id]);
        const item: RunItem = {
          id: itemId,
          type: "tool",
          tool_call: prior?.tool_call ?? event.tool_call,
          output: (continuing ? prior?.output ?? "" : "") + event.output,
          version: (prior?.version ?? 0) + 1,
          result: prior?.result,
          is_error: prior?.is_error ?? false,
          canceled: prior?.canceled ?? false,
        };
        if (prior) setItem(item);
        else appendItem(item);
        setToolActive(id, true);
        break;
      }
      case "tool_end": {
        const id = event.tool_call.id;
        const itemId = toolItemId(id);
        const old = next.itemsById[itemId];
        const prior = old?.type === "tool" ? old : undefined;
        const result = event.tool_result;
        const item: RunItem = {
          id: itemId,
          type: "tool",
          tool_call: prior?.tool_call ?? event.tool_call,
          output: prior?.output ?? "",
          version: (prior?.version ?? 0) + 1,
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
        const old = next.itemsById[itemId];
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
        next.activeMessageId = undefined;
        next.activeToolIds = {};
        appendItem({ id, type: "error", event });
        break;
      }
      case "notification": {
        const id = `notification:${receipt ?? next.nextId}`;
        next.nextId += 1;
        appendItem({ id, type: "notification", event });
        break;
      }
      case "unknown": {
        const id = `unknown:${receipt ?? next.nextId}`;
        next.nextId += 1;
        appendItem({ id, type: "unknown", event });
        break;
      }
    }
  }
  return next;
}

export function reduce(state: RunState, event: RunEvent): RunState {
  return reduceAll(state, [event]);
}
