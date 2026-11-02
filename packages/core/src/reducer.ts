import type {
  Message,
  RunEvent,
  RunItem,
  ToolCall,
  ToolResult,
} from "./events.js";
export interface RunState {
  turns: string[];
  items: string[];
  itemsById: Record<string, RunItem>;
  messagesById: Record<
    string,
    Message & { chunks?: string[]; version: number }
  >;
  toolCallsById: Record<
    string,
    {
      tool_call: ToolCall;
      outputs: string[];
      version: number;
      result?: ToolResult;
      is_error: boolean;
      canceled: boolean;
    }
  >;
  approvalsById: Record<
    string,
    { request: RunEvent; ended?: RunEvent; delegated: boolean }
  >;
  usage: Record<string, number>;
  userMessages: Array<{ text: string; mode: string; attachments?: unknown[] }>;
  errors: Array<{ code: string; message: string }>;
  agent: "idle" | "running";
  turn: "idle" | "running";
  childNotifications: RunEvent[];
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
  errors: [],
  agent: "idle",
  turn: "idle",
  childNotifications: [],
  receipts: {},
  nextId: 1,
};
const append = (state: RunState, item: RunItem): RunState => ({
  ...state,
  items: [...state.items, item.id],
  itemsById: { ...state.itemsById, [item.id]: item },
});
const idFor = (state: RunState, prefix: string): [string, number] => [
  `${prefix}-${state.nextId}`,
  state.nextId + 1,
];
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
    case "message_delta": {
      const id =
        event.message_id ??
        next.activeMessageId ??
        (next.nextId === 1 ? "assistant" : `assistant-${next.nextId}`);
      const old = next.messagesById[id];
      const chunks = old?.chunks ?? [];
      chunks.push(event.delta);
      const message: Message & { chunks: string[]; version: number } = {
        role: old?.role ?? "assistant",
        content: old?.content ?? [],
        chunks,
        version: (old?.version ?? 0) + 1,
      };
      if (!old) {
        next = {
          ...next,
          items: [...next.items, id],
          itemsById: { ...next.itemsById },
          messagesById: { ...next.messagesById },
          nextId: next.nextId + 1,
          activeMessageId: id,
        };
        next.itemsById[id] = {
          id,
          type: "message",
          message,
          version: 1,
          chunks,
        };
      }
      next.messagesById[id] = message;
      return next;
    }
    case "message_commit": {
      const id =
        event.message_id ??
        next.activeMessageId ??
        (next.nextId === 1 ? "assistant" : `assistant-${next.nextId}`);
      const old = next.messagesById[id];
      const message = {
        ...event.message,
        chunks: old?.chunks,
        version: (old?.version ?? 0) + 1,
      };
      const updated = {
        ...next,
        activeMessageId: undefined,
        nextId: old ? next.nextId : next.nextId + 1,
        messagesById: { ...next.messagesById, [id]: message },
      };
      return old
        ? {
            ...updated,
            itemsById: {
              ...updated.itemsById,
              [id]: {
                id,
                type: "message" as const,
                message,
                version: message.version,
                chunks: message.chunks,
              },
            },
          }
        : append(updated, {
            id,
            type: "message" as const,
            message,
            version: message.version,
            chunks: message.chunks,
          });
    }
    case "message_reset": {
      const messages = { ...next.messagesById };
      for (const key of Object.keys(messages))
        if (messages[key].chunks) delete messages[key];
      return { ...next, messagesById: messages };
    }
    case "retry":
      return next;
    case "tool_start": {
      const id = event.tool_call.id;
      const value = {
        tool_call: event.tool_call,
        outputs: [],
        version: 1,
        is_error: false,
        canceled: false,
      };
      const updated = {
        ...next,
        toolCallsById: { ...next.toolCallsById, [id]: value },
      };
      return append(updated, {
        id,
        type: "tool",
        tool_call: event.tool_call,
        outputs: value.outputs,
        version: 1,
      });
    }
    case "tool_output": {
      const old = next.toolCallsById[event.tool_call.id] ?? {
        tool_call: event.tool_call,
        outputs: [],
        version: 0,
        is_error: false,
        canceled: false,
      };
      old.outputs.push(event.output);
      const value = { ...old, version: old.version + 1 };
      return {
        ...next,
        toolCallsById: { ...next.toolCallsById, [event.tool_call.id]: value },
        itemsById: {
          ...next.itemsById,
          [event.tool_call.id]: {
            id: event.tool_call.id,
            type: "tool",
            tool_call: value.tool_call,
            outputs: value.outputs,
            version: value.version,
            result: value.result,
          },
        },
      };
    }
    case "tool_end": {
      const old = next.toolCallsById[event.tool_call.id] ?? {
        tool_call: event.tool_call,
        outputs: [],
        version: 0,
        is_error: false,
        canceled: false,
      };
      const result = event.tool_result;
      const value = {
        ...old,
        result,
        version: old.version + 1,
        is_error: result?.is_error ?? false,
        canceled: result?.is_canceled ?? false,
      };
      next.toolCallsById[event.tool_call.id] = value;
      const item = next.itemsById[event.tool_call.id];
      if (item && item.type === "tool") {
        item.outputs = value.outputs;
        item.version = value.version;
        item.result = result;
      }
      return { ...next };
    }
    case "approval_request":
      return append(
        {
          ...next,
          approvalsById: {
            ...next.approvalsById,
            [event.request_id]: { request: event, delegated: event.delegated },
          },
        },
        { id: event.request_id, type: "approval", request: event },
      );
    case "approval_end": {
      const old = next.approvalsById[event.request_id];
      return old
        ? {
            ...next,
            approvalsById: {
              ...next.approvalsById,
              [event.request_id]: { ...old, ended: event },
            },
            itemsById: {
              ...next.itemsById,
              [event.request_id]: {
                id: event.request_id,
                type: "approval",
                request: old.request,
                ended: event,
              },
            },
          }
        : next;
    }
    case "usage": {
      const usage = { ...next.usage };
      for (const [key, value] of Object.entries(event.usage))
        usage[key] = (usage[key] ?? 0) + value;
      return { ...next, usage };
    }
    case "user_message":
      return append(
        { ...next, userMessages: [...next.userMessages, event] },
        { id: `user-${next.nextId}`, type: "user", data: event },
      );
    case "error":
      return {
        ...next,
        agent: "idle",
        turn: "idle",
        errors: [...next.errors, event.error],
      };
    case "notification":
    case "unknown":
      return {
        ...next,
        childNotifications: [...next.childNotifications, event],
      };
  }
  throw new Error("unreachable run event");
}
