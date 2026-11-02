import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { createRunStore, initialState, reduce, type RunState } from "@fulcrum/core";
import {
  createClient,
  fromZetaEvent,
  type EventParams,
  type Transport,
} from "../src/index.js";
import { eventTypes } from "../src/event-types.js";

interface Frame {
  jsonrpc: "2.0";
  method: "event";
  params: EventParams;
}

const fixtureDir = new URL("./fixtures/", import.meta.url);
const fixtures = Object.fromEntries(
  readdirSync(fixtureDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => [
      name,
      readFileSync(new URL(name, fixtureDir), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Frame),
    ]),
);

const freshState = (): RunState => structuredClone(initialState);

function replay(name: string) {
  const sessions = new Map<string, RunState>();
  for (const frame of fixtures[name]) {
    const id = frame.params.session_id ?? "default";
    let state = sessions.get(id) ?? freshState();
    for (const event of fromZetaEvent(frame.params)) state = reduce(state, event);
    sessions.set(id, state);
  }
  return sessions;
}


const materialize = (state: RunState) => {
  const clone = structuredClone(state);
  for (const message of Object.values(clone.messagesById)) {
    if (message.chunks) message.chunks = [message.chunks.join("")];
  }
  for (const tool of Object.values(clone.toolCallsById)) {
    tool.outputs = [tool.outputs.join("")];
  }
  for (const item of Object.values(clone.itemsById)) {
    if (item.type === "message" && item.chunks) item.chunks = [item.chunks.join("")];
    if (item.type === "tool") item.outputs = [item.outputs.join("")];
  }
  return clone;
};

const replayEveryFixture = (assertState: (state: RunState) => void) => {
  for (const frames of Object.values(fixtures)) {
    const stores = new Map<string, ReturnType<typeof createRunStore>>();
    for (const frame of frames) {
      const id = frame.params.session_id ?? "default";
      const store = stores.get(id) ?? createRunStore(freshState());
      stores.set(id, store);
      for (const event of fromZetaEvent(frame.params)) {
        store.dispatch(event);
        assertState(store.getState());
      }
    }
  }
};

test("published snapshots never change", () => {
  const snapshots: Array<{ state: RunState; clone: RunState }> = [];
  replayEveryFixture((state) => snapshots.push({ state, clone: materialize(state) }));
  for (const snapshot of snapshots) expect(materialize(snapshot.state)).toEqual(snapshot.clone);
});

test("timeline ids are unique and all resolve", () => {
  replayEveryFixture((state) => {
    expect(new Set(state.items).size).toBe(state.items.length);
    for (const id of state.items) expect(state.itemsById[id]).toBeDefined();
  });
});

test("approval and its tool execution stay distinct in the timeline", () => {
  const state = replay("approval-then-tool.jsonl").get("approval-tool")!;
  expect(state.items).toHaveLength(2);
  expect(state.items.map((id) => state.itemsById[id].type)).toEqual(["approval", "tool"]);
});

const contentText = (state: RunState, itemId: string) => {
  const item = state.itemsById[itemId];
  if (item?.type !== "message") return "";
  return item.message.content
    .filter((block) => block.type === "text")
    .map((block) => String(block.text))
    .join("");
};

const eventsByType = (state: RunState, type: "error" | "notification" | "unknown") =>
  state.items
    .map((id) => state.itemsById[id])
    .filter((item) => item.type === type)
    .map((item) => item.event);

const deliberateUnknown = new Set([
  "memory_updated",
  "compaction_start",
  "compaction_end",
  "account_limit",
  "account_state_unknown",
]);

test("every event name in event_contract.py is mapped explicitly", () => {
  const frames = fixtures["all-events.jsonl"];
  expect(new Set(frames.map((frame) => frame.params.event))).toEqual(new Set(Object.keys(eventTypes)));

  for (const frame of frames) {
    const [event] = fromZetaEvent(frame.params);
    expect(event.type).toBe(eventTypes[frame.params.event]);
    if (event.type === "unknown") expect(deliberateUnknown.has(frame.params.event)).toBe(true);
  }

  expect(replay("all-events.jsonl").get("all")).toBeDefined();
});

test("simple streaming turn commits one assistant message", () => {
  const state = replay("simple.jsonl").get("simple")!;
  expect(state.items.filter((id) => state.itemsById[id]?.type === "message")).toHaveLength(1);
  expect(contentText(state, state.items[0])).toBe("hi there");
  expect(state.itemsById[state.items[0]].type).toBe("message");
  expect(state.messagesById.assistant.chunks).toBeUndefined();
});

test("two assistant turns keep two distinct messages in order", () => {
  const state = replay("two-turns.jsonl").get("turns")!;
  const messageIds = state.items.filter((id) => state.itemsById[id]?.type === "message");
  expect(messageIds).toHaveLength(2);
  expect(messageIds[0]).not.toBe(messageIds[1]);
  expect(messageIds.map((id) => contentText(state, id))).toEqual(["one", "two"]);
});

test("tool call start/output/end with error result", () => {
  const state = replay("tool.jsonl").get("tool")!;
  expect(state.items).toEqual(["tool:tool-call-1"]);
  expect(state.toolCallsById["tool-call-1"].outputs).toEqual(["permission denied"]);
  expect(state.toolCallsById["tool-call-1"].is_error).toBe(true);
  expect(state.toolCallsById["tool-call-1"].result?.content).toBe("permission denied");
});

test("approval request then approval end", () => {
  const state = replay("approval.jsonl").get("approval")!;
  expect(state.items).toEqual(["approval:tool-call-1"]);
  expect(state.approvalsById["tool-call-1"].delegated).toBe(false);
  expect(state.approvalsById["tool-call-1"].ended?.type).toBe("approval_end");
});

test("turn_aborted leaves turn and agent idle", () => {
  const state = replay("terminal.jsonl").get("aborted")!;
  expect(state.agent).toBe("idle");
  expect(state.turn).toBe("idle");
  const event = eventsByType(state, "error").at(-1);
  expect(event?.type === "error" ? event.error.code : undefined).toBe("turn_aborted");
});

test("max_turns error then agent_end leaves run idle", () => {
  const state = replay("terminal.jsonl").get("max-turns")!;
  expect(state.agent).toBe("idle");
  expect(state.turn).toBe("idle");
  const event = eventsByType(state, "error").at(-1);
  expect(event?.type === "error" ? event.error : undefined).toEqual({ code: "max_turns", message: "maximum turns reached: 1" });
});

test("reconnect replay of the same notification_id is deduped", () => {
  const state = replay("notifications.jsonl").get("notify")!;
  const receipts = eventsByType(state, "notification");
  expect(receipts).toHaveLength(1);
  expect(state.receipts["same-id"]).toBe(true);
});

test("two interleaved sessions do not touch each other's state", async () => {
  let receive!: (text: string) => void;
  const transport: Transport = {
    send() {},
    onMessage(callback) { receive = callback; },
    onClose() {},
    close() {},
  };
  const client = createClient(transport);
  for (const frame of fixtures["sessions.jsonl"]) receive(JSON.stringify(frame));

  const alpha = client.stores.get("alpha")!.getState();
  const beta = client.stores.get("beta")!.getState();
  expect(alpha.items.map((id) => contentText(alpha, id))).toEqual(["alpha"]);
  expect(beta.items.map((id) => contentText(beta, id))).toEqual(["beta"]);
  expect(alpha).not.toBe(beta);
  expect(alpha.messagesById).not.toBe(beta.messagesById);
});

test("unknown future event keeps the full wire payload", () => {
  const state = replay("notifications.jsonl").get("notify")!;
  const event = eventsByType(state, "unknown").find(
    (candidate) => candidate.type === "unknown" && candidate.name === "future_event",
  );
  expect(event?.type).toBe("unknown");
  if (event?.type === "unknown") {
    expect(event.data).toMatchObject({
      event: "future_event",
      session_id: "notify",
      message: "keep me",
      data: { nested: { value: 1 } },
    });
  }
});

test("memory_updated keeps its top-level message", () => {
  const state = replay("notifications.jsonl").get("notify")!;
  const event = eventsByType(state, "unknown").find(
    (candidate) => candidate.type === "unknown" && candidate.name === "memory_updated",
  );
  expect(event?.type).toBe("unknown");
  if (event?.type === "unknown") expect(event.data.message).toBe("memory saved");
});
