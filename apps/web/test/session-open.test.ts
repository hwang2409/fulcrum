import { expect, test } from "bun:test";
import { createClient, type Transport } from "@fulcrum/zeta";
import { openSession } from "../src/session";

type Json = Record<string, any>;
type Handler = (method: string, params: Json, event: (params: Json) => void) => unknown;

async function server(handler: Handler) {
  let receive!: (text: string) => void;
  const calls: Array<[string, Json]> = [];
  const transport: Transport = {
    onMessage(callback) { receive = callback; },
    onClose() {},
    close() {},
    send(text) {
      const { id, method, params = {} } = JSON.parse(text);
      calls.push([method, params]);
      queueMicrotask(async () => {
        const event = (value: Json) => receive(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { session_id: "s", ...value } }));
        try {
          const result = method === "hello"
            ? { protocol_version: "1.2", capabilities: { features: ["delivery_id", "user_message_event", "user_message_delivery_id"] } }
            : await handler(method, params, event);
          receive(JSON.stringify({ jsonrpc: "2.0", id, result }));
        } catch (error) {
          receive(JSON.stringify({ jsonrpc: "2.0", id, error }));
        }
      });
    },
  };
  const client = createClient(transport, (flush) => flush());
  await client.hello([]);
  return { client, calls };
}

const row = (id: string, role: "user" | "assistant", text: string) => ({ id, role, content: [{ type: "text", text }], tool_result: null });
const items = (store: ReturnType<typeof createClient>["store"]) => store.getOutline().map(({ id }) => store.getItem(id));
const texts = (store: ReturnType<typeof createClient>["store"]) => items(store).flatMap((item) => {
  if (item?.type === "message") return [item.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("")];
  if (item?.type === "user" && item.event.type === "user_message") return [item.event.text];
  return [];
});
const idleStatus = { session: { session_id: "s", created_at: "", updated_at: "" }, state: "idle", pending_approvals: [] } as const;

// Review 3's exact loss: both events arrive in the ambiguous first-page window and are absent from that page.
test("an idle replay replaces quarantined live events with one fresh full snapshot", async () => {
  let historyCalls = 0;
  const fake = await server((method, _params, event) => {
    if (method === "status") return idleStatus;
    if (method === "session_history") {
      historyCalls++;
      if (historyCalls === 1) {
        event({ event: "assistant_delta", delta: "lost-during-history", kind: "assistant" });
        event({ event: "user_message", message: { role: "user", content: [{ type: "text", text: "lost-steer" }] }, delivery_id: "delivery-1" });
        return { messages: [row("old", "user", "old")], next_offset: null };
      }
      return { messages: [row("old", "user", "old"), row("assistant", "assistant", "lost-during-history"), row("steer", "user", "lost-steer")], next_offset: null };
    }
    throw new Error(method);
  });

  const opened = await openSession(fake.client, "s");
  await opened.complete;

  expect(texts(opened.lease.store)).toEqual(["old", "lost-during-history", "lost-steer"]);
  expect(fake.calls.filter(([method, params]) => method === "session_history" && params.offset === 0)).toHaveLength(2);
});

test("a quarantined event on a later page forces the same final snapshot", async () => {
  let round = 0;
  const fake = await server((method, params, event) => {
    if (method === "status") return idleStatus;
    if (method !== "session_history") throw new Error(method);
    if (params.offset === 0) round++;
    if (round === 1 && params.offset === 1) {
      event({ event: "assistant_delta", delta: "during-page-one", kind: "assistant" });
      return { messages: [row("older", "user", "older")], next_offset: null };
    }
    if (round === 1) return { messages: [row("old", "user", "old")], next_offset: 1 };
    return { messages: [row("old", "user", "old"), row("assistant", "assistant", "during-page-one"), row("older", "user", "older")], next_offset: null };
  });

  const opened = await openSession(fake.client, "s");
  await opened.complete;

  expect(texts(opened.lease.store)).toEqual(["old", "during-page-one", "older"]);
  expect(round).toBe(2);
});

test("events during every final snapshot stop at the bound and leave the last snapshot stable", async () => {
  let historyCalls = 0;
  const fake = await server((method, _params, event) => {
    if (method === "status") return idleStatus;
    if (method !== "session_history") throw new Error(method);
    historyCalls++;
    event({ event: "assistant_delta", delta: `during-snapshot-${historyCalls}`, kind: "assistant" });
    return { messages: [row("old", "user", "old"), row("complete", "assistant", `snapshot-${historyCalls}`)], next_offset: null };
  });

  const opened = await openSession(fake.client, "s");
  await opened.complete;

  expect(texts(opened.lease.store)).toEqual(["old", "snapshot-4"]);
  expect(historyCalls).toBe(4);
});

test("the first snapshot exposes an actionable approval while page one is held", async () => {
  let release!: () => void;
  const held = new Promise<unknown>((resolve) => { release = () => resolve({ messages: [], next_offset: null }); });
  const approval = { request_id: "approval-late", tool_call: { id: "tool-late", name: "bash", arguments: {} }, delegated: false };
  let statusCalls = 0;
  const fake = await server((method, params) => {
    if (method === "status") return ++statusCalls === 1 ? { ...idleStatus, state: "tool", pending_approvals: [approval] } : idleStatus;
    if (method === "session_history") return params.offset === 0 ? { messages: [row("old", "user", "old")], next_offset: 1 } : held;
    if (method === "approve") return { accepted: true };
    throw new Error(method);
  });

  const opened = await openSession(fake.client, "s");
  expect(items(opened.lease.store).filter((item) => item?.type === "approval")).toHaveLength(1);
  await expect(fake.client.request("approve", { request_id: "approval-late" })).resolves.toEqual({ accepted: true });
  release();
  await opened.complete;
});

test("a later-page failure keeps the approval visible for the caller to show with the error", async () => {
  const approval = { request_id: "approval-late", tool_call: { id: "tool-late", name: "bash", arguments: {} }, delegated: false };
  const fake = await server((method, params) => {
    if (method === "status") return { ...idleStatus, state: "tool", pending_approvals: [approval] };
    if (method === "session_history" && params.offset === 0) return { messages: [], next_offset: 1 };
    if (method === "session_history") throw { code: -32000, message: "page one failed" };
    throw new Error(method);
  });

  const opened = await openSession(fake.client, "s");
  await expect(opened.complete).rejects.toThrow("page one failed");
  expect(items(opened.lease.store).filter((item) => item?.type === "approval")).toHaveLength(1);
});

test("evicting during progressive paging aborts completion before the held request replies", async () => {
  let release!: () => void;
  const held = new Promise<unknown>((resolve) => { release = () => resolve({ messages: [row("late", "user", "late")], next_offset: null }); });
  const fake = await server((method, params) => {
    if (method === "status") return idleStatus;
    if (method === "session_history") return params.offset === 0 ? { messages: [], next_offset: 1 } : held;
    throw new Error(method);
  });

  const opened = await openSession(fake.client, "s");
  await Promise.resolve();
  expect(fake.client.evictSession("s")).toBe(true);
  await expect(opened.complete).rejects.toThrow("request aborted");
  release();
  await Promise.resolve();
  expect(fake.calls.filter(([method]) => method === "session_history")).toHaveLength(2);
});

test("session_replay_seq stops at the future sequence coordinator seam", async () => {
  await expect(openSession({ features: ["session_replay_seq"] } as ReturnType<typeof createClient>, "s1")).rejects.toThrow("session_replay_seq needs the sequence replay coordinator");
});
