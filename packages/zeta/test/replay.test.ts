import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { createRunStore, type RunItem } from "@fulcrum/core";
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
type Store = ReturnType<typeof createRunStore>;

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

function replay(name: string) {
  const sessions = new Map<string, Store>();
  for (const frame of fixtures[name]) {
    const id = frame.params.session_id ?? "default";
    const store = sessions.get(id) ?? createRunStore(() => {});
    sessions.set(id, store);
    for (const event of fromZetaEvent(frame.params)) store.dispatch(event);
  }
  return sessions;
}

const replayEveryFixture = (assertStore: (store: Store) => void) => {
  for (const frames of Object.values(fixtures)) {
    const stores = new Map<string, Store>();
    for (const frame of frames) {
      const id = frame.params.session_id ?? "default";
      const store = stores.get(id) ?? createRunStore(() => {});
      stores.set(id, store);
      for (const event of fromZetaEvent(frame.params)) {
        store.dispatch(event);
        store.getState();
        assertStore(store);
      }
    }
  }
};

const items = (store: Store) =>
  store.getOutline().map(({ id }) => store.getItem(id)!);
const contentText = (item: RunItem | undefined) => {
  if (item?.type !== "message") return "";
  if (item.text !== undefined) return item.text;
  return item.message.content
    .filter((block) => block.type === "text")
    .map((block) => String(block.text))
    .join("");
};
const eventsByType = (
  store: Store,
  type: "error" | "notification" | "unknown",
) =>
  items(store)
    .filter((item) => item.type === type)
    .map((item) => ("event" in item ? item.event : undefined))
    .filter((event) => event !== undefined);

test("published snapshots never change", () => {
  const snapshots: Array<{
    state: ReturnType<Store["getState"]>;
    stateClone: ReturnType<Store["getState"]>;
    entities: RunItem[];
    entityClones: RunItem[];
  }> = [];
  replayEveryFixture((store) => {
    const state = store.getState();
    const entities = items(store);
    snapshots.push({
      state,
      stateClone: structuredClone(state),
      entities,
      entityClones: structuredClone(entities),
    });
  });
  for (const snapshot of snapshots) {
    expect(structuredClone(snapshot.state)).toEqual(snapshot.stateClone);
    expect(structuredClone(snapshot.entities)).toEqual(snapshot.entityClones);
  }
});

test("timeline ids are unique and all resolve", () => {
  replayEveryFixture((store) => {
    const outline = store.getOutline();
    expect(new Set(outline.map(({ id }) => id)).size).toBe(outline.length);
    for (const { id } of outline) expect(store.getItem(id)).toBeDefined();
  });
});

test("approval and its tool execution stay distinct in the timeline", () => {
  const store = replay("approval-then-tool.jsonl").get("approval-tool")!;
  expect(store.getOutline()).toHaveLength(2);
  expect(items(store).map(({ type }) => type)).toEqual(["approval", "tool"]);
});

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
  const store = replay("simple.jsonl").get("simple")!;
  const messages = items(store).filter(({ type }) => type === "message");
  expect(messages).toHaveLength(1);
  expect(contentText(messages[0])).toBe("hi there");
  const item = store.getItem("message:assistant");
  expect(item?.type === "message" ? item.text : undefined).toBeUndefined();
});

test("two assistant turns keep two distinct messages in order", () => {
  const store = replay("two-turns.jsonl").get("turns")!;
  const messages = items(store).filter(({ type }) => type === "message");
  expect(messages).toHaveLength(2);
  expect(messages[0]!.id).not.toBe(messages[1]!.id);
  expect(messages.map(contentText)).toEqual(["one", "two"]);
});

test("tool call start/output/end with error result", () => {
  const store = replay("tool.jsonl").get("tool")!;
  expect(store.getOutline()).toEqual([{ id: "tool:tool-call-1", kind: "tool" }]);
  const item = store.getItem("tool:tool-call-1");
  expect(item?.type === "tool" ? item.output : undefined).toBe("permission denied");
  expect(item?.type === "tool" ? item.is_error : undefined).toBe(true);
  expect(item?.type === "tool" ? item.result?.content : undefined).toBe("permission denied");
});

test("approval request then approval end", () => {
  const store = replay("approval.jsonl").get("approval")!;
  expect(store.getOutline()).toEqual([{ id: "approval:tool-call-1", kind: "approval" }]);
  const item = store.getItem("approval:tool-call-1");
  expect(item?.type === "approval" && item.request.type === "approval_request" ? item.request.delegated : undefined).toBe(false);
  expect(item?.type === "approval" ? item.ended?.type : undefined).toBe("approval_end");
});

test("a delta after turn_aborted starts a new message", () => {
  const store = replay("terminal.jsonl").get("aborted")!;
  const messages = items(store).filter(({ type }) => type === "message");
  expect(messages.map(contentText)).toEqual(["old", "new"]);
  expect(store.getState().agent).toBe("running");
  expect(store.getState().turn).toBe("running");
  const event = eventsByType(store, "error").at(-1);
  expect(event?.type === "error" ? event.error.code : undefined).toBe("turn_aborted");
});

test("a delta after a terminal error starts a new message", () => {
  const store = replay("terminal.jsonl").get("max-turns")!;
  const messages = items(store).filter(({ type }) => type === "message");
  expect(messages.map(contentText)).toEqual(["old", "new"]);
  expect(store.getState().agent).toBe("running");
  expect(store.getState().turn).toBe("running");
  const event = eventsByType(store, "error").at(-1);
  expect(event?.type === "error" ? event.error : undefined).toEqual({ code: "max_turns", message: "maximum turns reached: 1" });
});

test("reconnect replay of the same child notification_id is deduped", () => {
  const store = replay("notifications.jsonl").get("notify")!;
  expect(items(store).filter((item) => item.type === "sub_agent")).toHaveLength(1);
  expect(store.getState().receipts["same-id"]).toBe(true);
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
  const alpha = client.stores.get("alpha")!;
  const beta = client.stores.get("beta")!;
  expect(items(alpha).map(contentText)).toEqual(["alpha"]);
  expect(items(beta).map(contentText)).toEqual(["beta"]);
  expect(alpha.getState()).not.toBe(beta.getState());
  expect(alpha.getItem("message:assistant")).not.toBe(beta.getItem("message:assistant"));
});

test("a store for a session without events receives later events", () => {
  let receive!: (text: string) => void;
  const transport: Transport = {
    send() {},
    onMessage(callback) { receive = callback; },
    close() {},
  };
  const client = createClient(transport);
  const store = client.forSession("simple");
  receive(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { event: "assistant_delta", session_id: "simple", delta: "hi", kind: "assistant" } }));
  expect(client.forSession("simple")).toBe(store);
  expect(store.getOutline()).toHaveLength(1);
});

test("unknown future event keeps the full wire payload", () => {
  const store = replay("notifications.jsonl").get("notify")!;
  const event = eventsByType(store, "unknown").find(
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
  const store = replay("notifications.jsonl").get("notify")!;
  const event = eventsByType(store, "unknown").find(
    (candidate) => candidate.type === "unknown" && candidate.name === "memory_updated",
  );
  expect(event?.type).toBe("unknown");
  if (event?.type === "unknown") expect(event.data.message).toBe("memory saved");
});
