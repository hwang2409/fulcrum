import type {
  Message,
  RunEvent,
  RunItem,
  ToolCall,
  ToolResult,
} from "./events.js";
import { appendStream, shareStream } from "./stream.js";

interface StreamedMessage extends Message {
  chunks?: string[];
  version: number;
}
interface StreamedTool {
  tool_call: ToolCall;
  outputs: string[];
  version: number;
  result?: ToolResult;
  is_error: boolean;
  canceled: boolean;
}
export interface RunState {
  turns: string[];
  items: string[];
  itemsById: Record<string, RunItem>;
  messagesById: Record<string, StreamedMessage>;
  toolCallsById: Record<string, StreamedTool>;
  approvalsById: Record<
    string,
    { request: RunEvent; ended?: RunEvent; delegated: boolean }
  >;
  usage: Record<string, number>;
  userMessages: Array<{ text: string; mode: string; attachments?: unknown[] }>;
  agent: "idle" | "running";
  turn: "idle" | "running";
  receipts: Record<string, boolean>;
  nextId: number;
  activeMessageId?: string;
}
export const initialState: RunState = {
  turns: [],
  items: [],
  itemsById: {},
  messagesById: {},
  toolCallsById: {},
  approvalsById: {},
  usage: {},
  userMessages: [],
  agent: "idle",
  turn: "idle",
  receipts: {},
  nextId: 1,
};
const append = (state: RunState, item: RunItem): RunState => ({
  ...state,
  items: [...state.items, item.id],
  itemsById: { ...state.itemsById, [item.id]: item },
});
const messageItemId = (id: string) => `message:${id}`;
const toolItemId = (id: string) => `tool:${id}`;
const approvalItemId = (id: string) => `approval:${id}`;

interface StreamingState {
  messages: RunState["messagesById"];
  items: RunState["itemsById"];
  messageId: string;
  message: StreamedMessage;
}
const streamingStates = new WeakMap<RunState, StreamingState>();
const publishMessageDelta = (
  state: RunState,
  id: string,
  message: StreamedMessage,
  item: RunItem,
  isNew: boolean,
): RunState => {
  const prior = streamingStates.get(state);
  const messages = prior?.messages ?? state.messagesById;
  const itemsById = prior?.items ?? state.itemsById;
  const next: RunState = {
    turns: state.turns,
    items: isNew ? [...state.items, item.id] : state.items,
    get itemsById() {
      return { ...itemsById, [item.id]: item };
    },
    get messagesById() {
      return { ...messages, [id]: message };
    },
    toolCallsById: state.toolCallsById,
    approvalsById: state.approvalsById,
    usage: state.usage,
    userMessages: state.userMessages,
    agent: state.agent,
    turn: state.turn,
    receipts: state.receipts,
    nextId: isNew ? state.nextId + 1 : state.nextId,
    activeMessageId: id,
  };
  streamingStates.set(next, { messages, items: itemsById, messageId: id, message });
  return next;
};

export function reduce(state: RunState, event: RunEvent): RunState {
  const candidate =
    event.type === "notification"
      ? event.notification_id
      : event.type === "unknown"
        ? event.data.notification_id
        : undefined;
  const receipt = typeof candidate === "string" ? candidate : undefined;
  if (receipt && state.receipts[receipt]) return state;
  let next = receipt
    ? { ...state, receipts: { ...state.receipts, [receipt]: true } }
    : state;

  switch (event.type) {
    case "run_start":
      return { ...next, agent: "running" };
    case "run_end":
      return { ...next, agent: "idle", turn: "idle" };
    case "turn_start":
      return {
        ...next,
        turn: "running",
        turns: [
          ...next.turns,
          String(event.data?.turn ?? next.turns.length + 1),
        ],
      };
    case "turn_end":
      return { ...next, turn: "idle", activeMessageId: undefined };
    case "message_start":
      return next;
    case "message_delta": {
      const id =
        event.message_id ??
        next.activeMessageId ??
        (next.nextId === 1 ? "assistant" : `assistant-${next.nextId}`);
      const streaming = streamingStates.get(next);
      const old =
        streaming?.messageId === id
          ? streaming.message
          : next.messagesById[id];
      const continuing = next.activeMessageId === id;
      const message = appendStream(
        {
          role: old?.role ?? "assistant",
          content: old?.content ?? [],
          version: (old?.version ?? 0) + 1,
        },
        "chunks",
        continuing ? old : undefined,
        event.delta,
      );
      const itemId = messageItemId(id);
      const item = shareStream(
        {
          id: itemId,
          type: "message" as const,
          message,
          version: message.version,
        },
        "chunks",
        message,
      );
      return publishMessageDelta(next, id, message, item, !old);
    }
    case "message_commit": {
      const id =
        event.message_id ??
        next.activeMessageId ??
        (next.nextId === 1 ? "assistant" : `assistant-${next.nextId}`);
      const old = next.messagesById[id];
      const message = {
        ...event.message,
        version: (old?.version ?? 0) + 1,
      };
      const itemId = messageItemId(id);
      const item = {
        id: itemId,
        type: "message" as const,
        message,
        version: message.version,
      };
      const updated = {
        ...next,
        activeMessageId: undefined,
        nextId: old ? next.nextId : next.nextId + 1,
        messagesById: { ...next.messagesById, [id]: message },
        itemsById: { ...next.itemsById, [itemId]: item },
      };
      return old
        ? updated
        : { ...updated, items: [...updated.items, itemId] };
    }
    case "message_reset": {
      const id = next.activeMessageId;
      if (!id) return next;
      const itemId = messageItemId(id);
      const messagesById = { ...next.messagesById };
      const itemsById = { ...next.itemsById };
      delete messagesById[id];
      delete itemsById[itemId];
      return {
        ...next,
        activeMessageId: undefined,
        items: next.items.filter((candidate) => candidate !== itemId),
        itemsById,
        messagesById,
      };
    }
    case "retry":
      return next.activeMessageId
        ? { ...next, activeMessageId: undefined }
        : next;
    case "tool_start": {
      const id = event.tool_call.id;
      const itemId = toolItemId(id);
      const value = {
        tool_call: event.tool_call,
        outputs: [],
        version: 1,
        is_error: false,
        canceled: false,
      };
      const item = {
        id: itemId,
        type: "tool" as const,
        tool_call: event.tool_call,
        outputs: value.outputs,
        version: 1,
      };
      const updated = {
        ...next,
        toolCallsById: { ...next.toolCallsById, [id]: value },
      };
      return next.itemsById[itemId]
        ? {
            ...updated,
            itemsById: { ...updated.itemsById, [itemId]: item },
          }
        : append(updated, item);
    }
    case "tool_output": {
      const id = event.tool_call.id;
      const old = next.toolCallsById[id];
      const value = appendStream(
        {
          tool_call: old?.tool_call ?? event.tool_call,
          version: (old?.version ?? 0) + 1,
          result: old?.result,
          is_error: old?.is_error ?? false,
          canceled: old?.canceled ?? false,
        },
        "outputs",
        old,
        event.output,
      );
      const itemId = toolItemId(id);
      const item = shareStream(
        {
          id: itemId,
          type: "tool" as const,
          tool_call: value.tool_call,
          version: value.version,
          result: value.result,
        },
        "outputs",
        value,
      );
      const updated = {
        ...next,
        toolCallsById: { ...next.toolCallsById, [id]: value },
        itemsById: { ...next.itemsById, [itemId]: item },
      };
      return next.itemsById[itemId]
        ? updated
        : { ...updated, items: [...updated.items, itemId] };
    }
    case "tool_end": {
      const id = event.tool_call.id;
      const old = next.toolCallsById[id];
      const outputs = old?.outputs ?? [];
      const result = event.tool_result;
      const value = {
        tool_call: old?.tool_call ?? event.tool_call,
        outputs,
        result,
        version: (old?.version ?? 0) + 1,
        is_error: result?.is_error ?? false,
        canceled: result?.is_canceled ?? false,
      };
      const itemId = toolItemId(id);
      const item = {
        id: itemId,
        type: "tool" as const,
        tool_call: value.tool_call,
        outputs,
        version: value.version,
        result,
      };
      const updated = {
        ...next,
        toolCallsById: { ...next.toolCallsById, [id]: value },
        itemsById: { ...next.itemsById, [itemId]: item },
      };
      return next.itemsById[itemId]
        ? updated
        : { ...updated, items: [...updated.items, itemId] };
    }
    case "approval_request": {
      const itemId = approvalItemId(event.request_id);
      return append(
        {
          ...next,
          approvalsById: {
            ...next.approvalsById,
            [event.request_id]: { request: event, delegated: event.delegated },
          },
        },
        { id: itemId, type: "approval", request: event },
      );
    }
    case "approval_end": {
      const old = next.approvalsById[event.request_id];
      if (!old) return next;
      const itemId = approvalItemId(event.request_id);
      return {
        ...next,
        approvalsById: {
          ...next.approvalsById,
          [event.request_id]: { ...old, ended: event },
        },
        itemsById: {
          ...next.itemsById,
          [itemId]: {
            id: itemId,
            type: "approval",
            request: old.request,
            ended: event,
          },
        },
      };
    }
    case "usage": {
      const usage = { ...next.usage };
      for (const [key, value] of Object.entries(event.usage))
        usage[key] = (usage[key] ?? 0) + value;
      return { ...next, usage };
    }
    case "user_message": {
      const id = `user:${next.nextId}`;
      return append(
        {
          ...next,
          nextId: next.nextId + 1,
          userMessages: [...next.userMessages, event],
        },
        { id, type: "user", event },
      );
    }
    case "error": {
      const id = `error:${next.nextId}`;
      return append(
        {
          ...next,
          nextId: next.nextId + 1,
          agent: "idle",
          turn: "idle",
        },
        { id, type: "error", event },
      );
    }
    case "notification": {
      const id = `notification:${receipt ?? next.nextId}`;
      return append(
        { ...next, nextId: next.nextId + 1 },
        { id, type: "notification", event },
      );
    }
    case "unknown": {
      const id = `unknown:${receipt ?? next.nextId}`;
      return append(
        { ...next, nextId: next.nextId + 1 },
        { id, type: "unknown", event },
      );
    }
  }
  throw new Error("unreachable run event");
}
