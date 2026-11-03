import { expect, test } from "bun:test";
import { createClient, type Transport, type ZetaClient } from "@fulcrum/zeta";
import { ago, createSessions, sessionTitle, topLevel, type SessionMeta } from "../src/session";

type Handler = (params: Record<string, unknown>) => unknown;

/** A real zeta client over an in-memory transport; `handlers` answer requests by method. */
async function server(handlers: Record<string, Handler>) {
  let deliver!: (text: string) => void;
  let close!: (code?: number) => void;
  const calls: Array<[string, Record<string, unknown>]> = [];
  const transport: Transport = {
    onMessage(callback) { deliver = callback; },
    onClose(callback) { close = callback; },
    close() {},
    send(text) {
      const { id, method, params } = JSON.parse(text);
      calls.push([method, params]);
      queueMicrotask(() => {
        try {
          const result = method === "hello" ? { protocol_version: "1.2", capabilities: { features: ["list_sessions_paging"] } } : handlers[method]!(params);
          deliver(JSON.stringify({ jsonrpc: "2.0", id, result }));
        } catch (error) {
          deliver(JSON.stringify({ jsonrpc: "2.0", id, error: error as object }));
        }
      });
    },
  };
  const client = createClient(transport, (flush) => flush());
  await client.hello(["list_sessions_paging"]);
  const event = (params: Record<string, unknown>) => deliver(JSON.stringify({ jsonrpc: "2.0", method: "event", params }));
  return { client, calls, event, drop: () => close(1006) };
}

const meta = (id: string, updated: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({ session_id: id, created_at: updated, updated_at: updated, ...extra });
const sessions = [meta("a", "2026-11-01T10:00:00Z", { name: "alpha" }), meta("b", "2026-11-02T10:00:00Z", { first_message_preview: "fix the build" }), meta("c", "2026-11-03T10:00:00Z", { parent_session_id: "b" })];
const history: Record<string, unknown[]> = {
  a: [{ id: "a1", role: "user", content: [{ type: "text", text: "hello a" }], tool_result: null }],
  b: [
    { id: "b1", role: "user", content: [{ type: "text", text: "hello b" }], tool_result: null },
    { id: "b2", role: "assistant", content: [{ type: "text", text: "on it" }], tool_result: null },
  ],
};

function source(client: ZetaClient | null) {
  const listeners = new Set<() => void>();
  return {
    client,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    set(next: ZetaClient | null) { this.client = next; listeners.forEach((listener) => listener()); },
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function handlers(active: string | null, extra: Record<string, Handler> = {}): Record<string, Handler> {
  let current = active;
  return {
    list_sessions: () => ({ sessions, next_offset: null }),
    status: () => ({ session: current ? meta(current, "x") : null, state: "idle", pending_approvals: current === "b" ? [{ request_id: "r1", tool_call: { id: "t9", name: "bash", arguments: { command: "rm -rf dist" } }, delegated: false }] : [] }),
    resume: (params) => { current = params.session_id as string; return { session: meta(current, "x") }; },
    session_history: (params) => {
      const rows = history[params.session_id as string] ?? [];
      const offset = params.offset as number;
      return { messages: rows.slice(offset, offset + 1), next_offset: offset + 1 < rows.length ? offset + 1 : null };
    },
    ...extra,
  };
}
const kinds = (state: ReturnType<typeof createSessions>["state"]) => {
  const store = state.open!.lease.store;
  return store.getOutline().map(({ kind }) => kind);
};

test("titles, times, and the top-level list", () => {
  expect(sessions.map(sessionTitle)).toEqual(["alpha", "fix the build", "untitled session"]);
  expect(sessionTitle(meta("0123456789", "x", { cwd: "/Users/dev/me/fun/fulcrum" }))).toBe("fulcrum · 01234567");
  const now = Date.parse("2026-11-02T12:00:00Z");
  expect(["2026-11-02T11:59:30Z", "2026-11-02T11:15:00Z", "2026-11-02T07:00:00Z", "2026-10-30T12:00:00Z", "2026-10-01T12:00:00Z", "2025-10-01T12:00:00Z"].map((iso) => ago(iso, now)))
    .toEqual(["now", "45m", "5h", "3d", "Oct 1", "Oct 1, 2025"]);
  expect(topLevel(sessions).map((session) => session.session_id)).toEqual(["b", "a"]);
});

test("on connect it opens the server's own session without resume, with every history page and its approval", async () => {
  const fake = await server(handlers("b"));
  const view = createSessions(source(fake.client));
  await tick();
  expect(view.state.selected).toBe("b");
  expect(view.state.server).toEqual({ id: "b", state: "idle", approvals: 1 });
  expect(kinds(view.state)).toEqual(["user", "message", "approval"]);
  expect(fake.calls.map(([method]) => method)).not.toContain("resume");
  expect(fake.calls.filter(([method]) => method === "session_history").map(([, params]) => params.offset)).toEqual([0, 1]);
});

test("selecting another session resumes it, releases the old one, and reports progress", async () => {
  const fake = await server(handlers("b"));
  const selected: string[] = [];
  const view = createSessions(source(fake.client), { onSelect: (id) => selected.push(id) });
  await tick();
  view.select("a");
  expect(view.state.opening).toEqual({ id: "a", messages: 0 });
  expect(view.state.open).toBeNull();
  await tick();
  expect(selected).toEqual(["a"]);
  expect(view.state.open?.id).toBe("a");
  expect(kinds(view.state)).toEqual(["user"]);
  expect(fake.calls.some(([method, params]) => method === "resume" && params.session_id === "a")).toBe(true);
});

test("the newest selection wins when opens overlap", async () => {
  const fake = await server(handlers(null));
  const view = createSessions(source(fake.client));
  await tick();
  view.select("a");
  view.select("b");
  await tick();
  expect(view.state.open?.id).toBe("b");
  expect(view.state.selected).toBe("b");
});

test("a busy server is reported as busy and the selection stays", async () => {
  const fake = await server(handlers(null, { resume: () => { throw { code: -32004, message: "a turn is already running" }; } }));
  const view = createSessions(source(fake.client));
  await tick();
  view.select("a");
  await tick();
  expect(view.state.openError).toEqual({ id: "a", message: "a turn is already running", busy: true });
  expect(view.state.selected).toBe("a");
});

test("a drop keeps the old transcript as stale; the reconnect rebuilds it on a fresh store without duplicates", async () => {
  const first = await server(handlers("b"));
  const connection = source(first.client);
  const view = createSessions(connection);
  await tick();
  const before = view.state.open!.lease.store;
  connection.set(null);
  expect(view.state.open).toMatchObject({ id: "b", stale: true });
  const second = await server(handlers("b"));
  connection.set(second.client);
  await tick();
  expect(view.state.open).toMatchObject({ id: "b", stale: false });
  expect(view.state.open!.lease.store).not.toBe(before);
  expect(kinds(view.state)).toEqual(["user", "message", "approval"]);
  const pending = view.state.open!.lease.store.getItem("approval:r1");
  expect(pending?.type).toBe("approval");
  expect(pending && "ended" in pending ? pending.ended : undefined).toBeUndefined();
});

test("a dropped approval is not guessed when history has no tool rows", async () => {
  const first = await server(handlers("b"));
  const connection = source(first.client);
  const view = createSessions(connection);
  await tick();
  connection.set(null);
  expect(view.state.open!.lease.store.getItem("approval:r1")).toMatchObject({ type: "approval" });
  const second = await server(handlers("b", { status: () => ({ session: meta("b", "x"), state: "idle", pending_approvals: [] }) }));
  connection.set(second.client);
  await tick();
  const ended = view.state.open!.lease.store.getItem("approval:r1");
  expect(ended?.type).toBe("approval");
  expect(ended && "ended" in ended ? ended.ended : undefined).toBeUndefined();
});

test("live events after the open land in the open store", async () => {
  const fake = await server(handlers("b"));
  const view = createSessions(source(fake.client));
  await tick();
  fake.event({ event: "assistant_delta", session_id: "b", delta: "streaming", kind: "assistant" });
  expect(kinds(view.state)).toEqual(["user", "message", "approval", "message"]);
});
