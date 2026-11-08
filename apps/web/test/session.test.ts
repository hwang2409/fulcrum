import { expect, test } from "bun:test";
import { createClient, type Transport, type ZetaClient } from "@fulcrum/zeta";
import { ago, createSessions, sessionPresentation, sessionTitle, topLevel, type SessionMeta, type Sessions } from "../src/session";

type Handler = (params: Record<string, unknown>) => unknown;

/** A real zeta client over an in-memory transport; `handlers` answer requests by method. */
async function server(handlers: Record<string, Handler>, features = ["list_sessions_paging"]) {
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
      queueMicrotask(async () => {
        try {
          const result = method === "hello" ? { protocol_version: "1.2", capabilities: { features } } : await handlers[method]!(params);
          deliver(JSON.stringify({ jsonrpc: "2.0", id, result }));
        } catch (error) {
          deliver(JSON.stringify({ jsonrpc: "2.0", id, error: error as object }));
        }
      });
    },
  };
  const client = createClient(transport, (flush) => flush());
  await client.hello(features);
  const event = (params: Record<string, unknown>) => deliver(JSON.stringify({ jsonrpc: "2.0", method: "event", params }));
  return { client, calls, event, drop: () => close(1006) };
}

const present = (view: Sessions) => sessionPresentation(view.state.transition);
const meta = (id: string, updated: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({ session_id: id, created_at: updated, updated_at: updated, ...extra });
const sessions = [meta("a", "2026-11-01T10:00:00Z", { name: "alpha" }), meta("b", "2026-11-02T10:00:00Z", { first_message_preview: "fix the build" }), meta("c", "2026-11-03T10:00:00Z", { parent_session_id: "b" })];
const history: Record<string, unknown[]> = {
  a: [{ id: "a1", role: "user", content: [{ type: "text", text: "hello a" }], tool_result: null }],
  b: [
    { id: "b1", role: "user", content: [{ type: "text", text: "hello b" }], tool_result: null },
    { id: "b2", role: "assistant", content: [{ type: "text", text: "on it" }], tool_result: null },
  ],
  c: [
    { id: "c1", role: "assistant", content: [{ type: "tool_use", tool_call: { id: "tool-c", name: "bash", arguments: {} } }], tool_result: null },
    { id: "c2", role: "tool_result", content: [{ type: "text", text: "done" }], tool_result: { tool_call_id: "tool-c", content: "done", is_error: false } },
  ],
};

function source(client: ZetaClient | null) {
  const listeners = new Set<() => void>();
  return {
    client,
    state: { phase: "connected" },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    set(next: ZetaClient | null, phase = next ? "connected" : "dropped") {
      this.client = next;
      this.state = { phase };
      listeners.forEach((listener) => listener());
    },
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const waitFor = async (condition: () => boolean, message: string, timeoutMs = 2_000) => {
  const deadline = performance.now() + timeoutMs;
  while (!condition() && performance.now() < deadline) await tick();
  expect(condition(), message).toBe(true);
};

function handlers(active: string | null, extra: Record<string, Handler> = {}): Record<string, Handler> {
  let current = active;
  return {
    list_sessions: () => ({ sessions, next_offset: null }),
    status: () => ({ session: current ? meta(current, "x") : null, state: "idle", pending_approvals: current === "b" || current === "c" ? [{ request_id: "r1", tool_call: { id: "t9", name: "bash", arguments: { command: "rm -rf dist" } }, delegated: false }] : [] }),
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
  const store = sessionPresentation(state.transition).open!.lease.store;
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

test("a locally created session survives an older catalog snapshot", async () => {
  let release!: () => void;
  const catalog = new Promise<{ sessions: SessionMeta[]; next_offset: null }>((resolve) => { release = () => resolve({ sessions: [sessions[0]!], next_offset: null }); });
  const fake = await server({ ...handlers("b"), list_sessions: () => catalog, new_session: () => ({ session: meta("new", "z", { name: "new" }) }) });
  const view = createSessions(source(fake.client));
  await tick();
  void view.create();
  await tick();
  release();
  await tick();
  expect(view.state.sessions.map((item) => item.session_id)).toContain("new");
});

test("a newer catalog retires a locally created session", async () => {
  let release!: () => void;
  const first = new Promise<{ sessions: SessionMeta[]; next_offset: null }>((resolve) => { release = () => resolve({ sessions: [sessions[0]!], next_offset: null }); });
  let calls = 0;
  const fake = await server({ ...handlers("b"), list_sessions: () => calls++ === 0 ? first : { sessions: [sessions[0]!], next_offset: null }, new_session: () => ({ session: meta("new", "z", { name: "new" }) }) });
  const view = createSessions(source(fake.client));
  await tick();
  void view.create();
  await tick();
  release();
  await tick();
  expect(view.state.sessions.map((item) => item.session_id)).toContain("new");
  await view.refresh();
  expect(view.state.sessions.map((item) => item.session_id)).not.toContain("new");
});

test("a failed replacement restores the old active session and its readiness", async () => {
  const resumed: string[] = [];
  const selected: string[] = [];
  const fake = await server(handlers("b", { resume: (params) => { resumed.push(params.session_id as string); if (params.session_id === "a") { return { session: meta("a", "x") }; } return { session: meta("b", "x") }; }, session_history: (params) => { if (params.session_id === "a") throw { code: -32602, message: "session log is invalid at line 12" }; return { messages: [], next_offset: null }; } }));
  const view = createSessions(source(fake.client), { onSelect: (id) => selected.push(id) });
  await tick();
  view.select("a");
  await tick();
  expect(resumed).toEqual(["a", "b"]);
  expect(present(view).open?.id).toBe("b");
  expect(present(view).selected).toBe("b");
  expect(selected).toEqual(["a", "b"]);
  expect(present(view).openError?.message).toBe("session log is invalid at line 12");
});

const turn = "5ec6b9bb4c8c44d29bfa315da83a4190";
const endRow = (turnId = turn, reason = "completed") => ({ id: `end-${turnId}`, role: "system", event: "served_turn_end", data: { turn_id: turnId, reason } });
const pagedHistory = (rows: unknown[]): Handler => (params) => {
  const offset = params.offset as number;
  return { messages: rows.slice(offset, offset + 1), next_offset: offset + 1 < rows.length ? offset + 1 : null };
};

async function interruptedReconnect({ phase = "dropped", status, rows = history.b!, features = ["list_sessions_paging", "served_turn_end"], approval = false, waitForComplete = true, duringReplay, turnId = turn }: {
  phase?: string;
  status: Record<string, unknown>;
  rows?: unknown[];
  features?: string[];
  approval?: boolean;
  waitForComplete?: boolean;
  /** Runs once while the reopen waits for its second history page, so the session is still replaying. */
  duringReplay?: (event: (params: Record<string, unknown>) => void) => void;
  /** The interrupted turn's id; null when the page joined mid-turn and never saw its turn_start. */
  turnId?: string | null;
}) {
  const first = await server(handlers("b"), features);
  const connection = source(first.client);
  const view = createSessions(connection);
  await waitFor(() => !!present(view).open?.history.complete, "initial history did not complete");
  first.event({ event: "agent_start", session_id: "b" });
  if (turnId) first.event({ event: "turn_start", session_id: "b", data: { turn: 1, turn_id: turnId } });
  if (approval) first.event({ event: "approval_request", session_id: "b", request_id: "pending", tool_call: { id: "tool", name: "bash", arguments: {} }, delegated: false });
  expect(present(view).open?.lease.store.getState().agent).toBe("running");
  connection.set(null, phase);
  let replaying = duringReplay;
  const second: Awaited<ReturnType<typeof server>> = await server(handlers("b", {
    status: () => status,
    session_history: (params) => {
      if (params.offset === 1 && replaying) { replaying(second.event); replaying = undefined; }
      return pagedHistory(rows)(params);
    },
  }), features);
  connection.set(second.client);
  await waitFor(() => !!present(view).open && !present(view).open!.stale && (waitForComplete ? !!present(view).open!.history.complete : present(view).open!.lease.store.getState().agent === "running"), "reconnected session did not reach its expected state");
  return { view, connection, second };
}

test("ordinary disconnect takes the interrupted turn outcome from matching idle status", async () => {
  const { view } = await interruptedReconnect({ status: { session: meta("b", "x"), state: "idle", pending_approvals: [], last_turn_outcome: { turn_id: turn, reason: "disconnect" } } });
  expect(present(view).open?.lease.store.getState().endOutcome).toBe("disconnected");
  view.dispose();
});

test("overflow takes the interrupted turn outcome from matching idle status", async () => {
  const { view } = await interruptedReconnect({ phase: "overflow", status: { session: meta("b", "x"), state: "idle", pending_approvals: [], last_turn_outcome: { turn_id: turn, reason: "completed" } } });
  expect(present(view).open?.lease.store.getState().endOutcome).toBe("completed");
  view.dispose();
});

test("status names an interrupted turn before its later history page is released", async () => {
  let release!: () => void;
  const later = new Promise<{ messages: unknown[]; next_offset: null }>((resolve) => { release = () => resolve({ messages: [endRow()], next_offset: null }); });
  const first = await server(handlers("b"), ["list_sessions_paging", "served_turn_end"]);
  const connection = source(first.client);
  const view = createSessions(connection);
  await waitFor(() => !!present(view).open?.history.complete, "initial history did not complete");
  first.event({ event: "agent_start", session_id: "b" });
  first.event({ event: "turn_start", session_id: "b", data: { turn: 1, turn_id: turn } });
  connection.set(null, "overflow");
  const second = await server(handlers("b", {
    status: () => ({ session: meta("b", "x"), state: "idle", pending_approvals: [], last_turn_outcome: { turn_id: turn, reason: "error" } }),
    session_history: (params) => params.offset === 0 ? { messages: history.b!.slice(0, 1), next_offset: 1 } : later,
  }), ["list_sessions_paging", "served_turn_end"]);
  connection.set(second.client);
  await waitFor(() => !!present(view).open && !present(view).open!.stale, "first reconnected page was not published");
  expect(present(view).open?.history.complete).toBe(false);
  expect(present(view).open?.lease.store.getState().endOutcome).toBe("failed");
  release();
  await waitFor(() => !!present(view).open?.history.complete, "later page did not complete");
  expect(present(view).open?.lease.store.getState().endOutcome).toBe("failed");
  view.dispose();
});

test("status null falls back to matching history and missing facts become unknown", async () => {
  const fromHistory = await interruptedReconnect({ status: { session: meta("b", "x"), state: "idle", pending_approvals: [], last_turn_outcome: null }, rows: [...history.b!, endRow(turn, "user_stop")] });
  expect(present(fromHistory.view).open?.lease.store.getState().endOutcome).toBe("cancelled");
  fromHistory.view.dispose();

  const missing = await interruptedReconnect({ status: { session: meta("b", "x"), state: "idle", pending_approvals: [], last_turn_outcome: null } });
  expect(present(missing.view).open?.lease.store.getState().endOutcome).toBe("unknown");
  missing.view.dispose();
});

test("an omitted status field does not mark a fresh attach and uses history only for an interrupted turn", async () => {
  const fresh = await server(handlers("b"));
  const freshView = createSessions(source(fresh.client));
  await waitFor(() => !!present(freshView).open?.history.complete, "fresh history did not complete");
  expect(present(freshView).open?.lease.store.getState().endOutcome).toBeUndefined();
  freshView.dispose();

  const oldServer = await interruptedReconnect({ status: { session: meta("b", "x"), state: "idle", pending_approvals: [] }, rows: [...history.b!, endRow(turn, "error")], features: ["list_sessions_paging"] });
  expect(present(oldServer.view).open?.lease.store.getState().endOutcome).toBe("failed");
  oldServer.view.dispose();
});

test("running and tool status never applies the previous turn outcome", async () => {
  for (const state of ["running", "tool"] as const) {
    const result = await interruptedReconnect({ status: { session: meta("b", "x"), state, pending_approvals: [], last_turn_outcome: { turn_id: turn, reason: "completed" } }, waitForComplete: false });
    expect(present(result.view).open?.lease.store.getState().agent).toBe("running");
    expect(present(result.view).open?.lease.store.getState().endOutcome).toBeUndefined();
    result.view.dispose();
  }
});

test("status for another session is ignored", async () => {
  const fake = await server(handlers("a", { status: () => ({ session: meta("a", "x"), state: "idle", pending_approvals: [], last_turn_outcome: { turn_id: turn, reason: "completed" } }) }), ["list_sessions_paging", "served_turn_end"]);
  const view = createSessions(source(fake.client), { selected: "b" });
  await waitFor(() => !!present(view).open?.history.complete, "selected session did not open");
  expect(present(view).open?.id).toBe("b");
  expect(present(view).open?.lease.store.getState().endOutcome).toBeUndefined();
  view.dispose();
});

test("fresh observer-style attach shows the active session's latest status outcome", async () => {
  const fake = await server(handlers("b", { status: () => ({ session: meta("b", "x"), state: "idle", pending_approvals: [], last_turn_outcome: { turn_id: turn, reason: "completed" } }) }), ["list_sessions_paging", "served_turn_end"]);
  const view = createSessions(source(fake.client));
  await waitFor(() => !!present(view).open?.history.complete, "observer history did not complete");
  expect(present(view).open?.lease.store.getState().endOutcome).toBe("completed");
  view.dispose();
});

const laterTurn = "0000000000000000000000000000beef";
const idleStatus = (last_turn_outcome: unknown) => ({ session: meta("b", "x"), state: "idle", pending_approvals: [], last_turn_outcome });
const reopened = async (view: Sessions) => {
  view.select("a");
  await waitFor(() => present(view).open?.id === "a" && !!present(view).open?.history.complete, "other session did not open");
  view.select("b");
  await waitFor(() => present(view).open?.id === "b" && !!present(view).open?.history.complete, "interrupted session did not reopen");
  return present(view).open?.lease.store.getState().endOutcome;
};
const startLaterTurn = (event: (params: Record<string, unknown>) => void) => {
  event({ event: "agent_start", session_id: "b" });
  event({ event: "turn_start", session_id: "b", data: { turn: 2, turn_id: laterTurn } });
};

// The interrupted-turn marker means "outcome unknown until its next run starts". A later run clears it the same way
// whether it was seen live or replayed: that open names no outcome for it, and a reopen names it from status. Each row
// names the fact that decides it.
test.each([
  {
    name: "a live run after the interruption clears the marker",
    fact: "the live turn_start serves a later turn id; status then names that turn",
    async run() {
      const status: Record<string, unknown> = idleStatus(null);
      const rows = [...history.b!];
      const { view, second } = await interruptedReconnect({ status, rows });
      expect(present(view).open?.lease.store.getState().endOutcome).toBe("unknown");
      startLaterTurn(second.event);
      await waitFor(() => present(view).open?.lease.store.getState().agent === "running", "the later run did not start live");
      expect(present(view).open?.lease.store.getState().endOutcome).toBeUndefined();
      Object.assign(status, idleStatus({ turn_id: laterTurn, reason: "completed" }));
      rows.push(endRow(laterTurn));
      second.event({ event: "agent_end", session_id: "b" });
      return { view, live: undefined, reopened: await reopened(view) };
    },
    live: undefined,
    reopened: "completed",
  },
  {
    name: "a run that starts and ends inside the reopen's replay clears the marker",
    fact: "the turn_start replayed into servedTurn (#111) and the reconcile's idle status both name a later turn",
    async run() {
      const status: Record<string, unknown> = idleStatus({ turn_id: turn, reason: "disconnect" });
      const rows = [...history.b!, endRow(turn, "disconnect")];
      const { view } = await interruptedReconnect({
        status, rows,
        duringReplay(event) {
          startLaterTurn(event);
          rows.push(endRow(laterTurn));
          Object.assign(status, idleStatus({ turn_id: laterTurn, reason: "completed" }));
          event({ event: "agent_end", session_id: "b" });
        },
      });
      return { view, live: present(view).open?.lease.store.getState().endOutcome, reopened: await reopened(view) };
    },
    live: undefined,
    reopened: "completed",
  },
  {
    name: "a run replayed while status still names the interrupted turn clears the marker",
    fact: "the client's servedTurn records the turn_start that arrived during replay (#111); status lags",
    async run() {
      const status: Record<string, unknown> = idleStatus({ turn_id: turn, reason: "disconnect" });
      const rows = [...history.b!, endRow(turn, "disconnect")];
      const { view } = await interruptedReconnect({
        status, rows,
        duringReplay(event) {
          startLaterTurn(event);
          event({ event: "agent_end", session_id: "b" });
        },
      });
      const live = present(view).open?.lease.store.getState().endOutcome;
      rows.push(endRow(laterTurn));
      Object.assign(status, idleStatus({ turn_id: laterTurn, reason: "completed" }));
      return { view, live, reopened: await reopened(view) };
    },
    live: undefined,
    reopened: "completed",
  },
  {
    name: "a status naming a later turn clears the marker even when history ends at the interrupted turn",
    fact: "idle status last_turn_outcome names a later turn; history has not caught up",
    async run() {
      const { view } = await interruptedReconnect({ status: idleStatus({ turn_id: laterTurn, reason: "completed" }), rows: [...history.b!, endRow(turn, "error")] });
      return { view, live: present(view).open?.lease.store.getState().endOutcome, reopened: await reopened(view) };
    },
    live: undefined,
    reopened: "completed",
  },
  {
    name: "an interrupted turn whose id the page never saw takes its outcome from status",
    fact: "idle status last_turn_outcome; with no interrupted id it may name that very turn, so it is not a later one",
    async run() {
      const { view } = await interruptedReconnect({ status: idleStatus({ turn_id: laterTurn, reason: "user_stop" }), turnId: null });
      return { view, live: present(view).open?.lease.store.getState().endOutcome, reopened: await reopened(view) };
    },
    live: "cancelled",
    reopened: "cancelled",
  },
  {
    name: "an interruption with no later run keeps the marker",
    fact: "no served turn fact: status names no turn and history has no turn end",
    async run() {
      const { view } = await interruptedReconnect({ status: idleStatus(null) });
      return { view, live: present(view).open?.lease.store.getState().endOutcome, reopened: await reopened(view) };
    },
    live: "unknown",
    reopened: "unknown",
  },
  {
    name: "a run that starts during the replay and ends live clears the marker",
    fact: "the reconcile's status is running; the live end is then named by status last_turn_outcome",
    async run() {
      const status: Record<string, unknown> = idleStatus(null);
      const rows = [...history.b!];
      const { view, second } = await interruptedReconnect({
        status, rows,
        duringReplay(event) {
          startLaterTurn(event);
          Object.assign(status, { state: "running" });
        },
      });
      expect(present(view).open?.lease.store.getState().agent).toBe("running");
      Object.assign(status, idleStatus({ turn_id: laterTurn, reason: "completed" }));
      rows.push(endRow(laterTurn));
      second.event({ event: "agent_end", session_id: "b" });
      await waitFor(() => present(view).open?.lease.store.getState().agent === "idle", "the later run did not end live");
      return { view, live: present(view).open?.lease.store.getState().endOutcome, reopened: await reopened(view) };
    },
    live: undefined,
    reopened: "completed",
  },
  {
    name: "a reload with no interruption shows the latest outcome",
    fact: "idle status last_turn_outcome, with no interrupted turn",
    async run() {
      const fake = await server(handlers("b", { status: () => idleStatus({ turn_id: turn, reason: "completed" }) }), ["list_sessions_paging", "served_turn_end"]);
      const view = createSessions(source(fake.client));
      await waitFor(() => !!present(view).open?.history.complete, "history did not complete");
      return { view, live: present(view).open?.lease.store.getState().endOutcome, reopened: await reopened(view) };
    },
    live: "completed",
    reopened: "completed",
  },
])("interrupted-turn marker: $name ($fact)", async ({ run, live, reopened: expectedReopen }) => {
  const result = await run();
  expect(result.live).toBe(live);
  expect(result.reopened).toBe(expectedReopen);
  result.view.dispose();
});

test("a pending approval does not hide a turn aborted by disconnect", async () => {
  const { view } = await interruptedReconnect({ approval: true, status: { session: meta("b", "x"), state: "idle", pending_approvals: [], last_turn_outcome: { turn_id: turn, reason: "disconnect" } } });
  expect(present(view).open?.lease.store.getState().endOutcome).toBe("disconnected");
  view.dispose();
});

test("replay-transient running state does not erase an interrupted outcome", async () => {
  const replayRows = [
    { id: "start", role: "system", event: "agent_start" },
    ...history.b!,
    endRow(turn, "error"),
  ];
  const result = await interruptedReconnect({ status: { session: meta("b", "x"), state: "idle", pending_approvals: [], last_turn_outcome: null }, rows: replayRows });
  expect(present(result.view).open?.lease.store.getState().endOutcome).toBe("failed");
  result.view.select("a");
  await waitFor(() => present(result.view).open?.id === "a", "other session did not open");
  result.view.select("b");
  await waitFor(() => present(result.view).open?.id === "b" && !!present(result.view).open?.history.complete, "interrupted session did not reopen");
  expect(present(result.view).open?.lease.store.getState().endOutcome).toBe("failed");
  result.view.dispose();
});

test("a session that came back running reopens with its recorded turn outcome when status names none", async () => {
  const status = { session: meta("b", "x"), state: "running", pending_approvals: [], last_turn_outcome: null };
  const rows = [...history.b!];
  const result = await interruptedReconnect({ status, rows, waitForComplete: false });
  status.state = "idle";
  rows.push(endRow(turn, "completed"));
  result.second.event({ event: "agent_end", session_id: "b" });
  result.view.select("a");
  await waitFor(() => present(result.view).open?.id === "a", "other session did not open");
  result.view.select("b");
  await waitFor(() => present(result.view).open?.id === "b" && !!present(result.view).open?.history.complete, "session did not reopen");
  expect(present(result.view).open?.lease.store.getState().endOutcome).toBe("completed");
  result.view.dispose();
});

test("on connect opens the active session before requesting the catalog", async () => {
  let release!: () => void;
  const catalog = new Promise<{ sessions: SessionMeta[]; next_offset: null }>((resolve) => { release = () => resolve({ sessions, next_offset: null }); });
  const fake = await server({ ...handlers("b"), list_sessions: () => catalog });
  const view = createSessions(source(fake.client));
  await tick();
  expect(present(view).open?.id).toBe("b");
  expect(view.state.listLoading).toBe(true);
  expect(view.state.listReady).toBe(false);
  expect(fake.calls.map(([method]) => method).filter((method) => method !== "hello")).toEqual(["status", "session_history", "list_sessions", "session_history"]);
  release();
  await tick();
  expect(view.state.listLoading).toBe(false);
  expect(view.state.listReady).toBe(true);
  expect(view.state.sessions).toHaveLength(3);
});

test("on connect it opens the server's own session without resume, with every history page and its approval", async () => {
  const fake = await server(handlers("b"));
  const view = createSessions(source(fake.client));
  await tick();
  expect(present(view).selected).toBe("b");
  expect(view.state.server).toEqual({ id: "b", state: "idle", approvals: 1 });
  expect(kinds(view.state)).toEqual(["user", "approval", "message"]);
  expect(fake.calls.map(([method]) => method)).not.toContain("resume");
  expect(fake.calls.filter(([method]) => method === "session_history").map(([, params]) => params.offset)).toEqual([0, 1]);
});

test("the first history page makes the session usable while later pages load", async () => {
  let release!: () => void;
  const later = new Promise<{ messages: unknown[]; next_offset: null }>((resolve) => {
    release = () => resolve({ messages: [{ id: "late", role: "assistant", content: [{ type: "text", text: "later page" }], tool_result: null }], next_offset: null });
  });
  const fake = await server(handlers("b", { session_history: (params) => params.offset === 0
    ? { messages: [{ id: "first", role: "user", content: [{ type: "text", text: "first page" }], tool_result: null }], next_offset: 1 }
    : later }));
  const view = createSessions(source(fake.client));
  await tick();
  expect(present(view).open).toMatchObject({ id: "b", history: { messages: 1, complete: false } });
  expect(kinds(view.state)).toEqual(["user", "approval"]);
  release();
  await tick();
  expect(present(view).open?.history).toEqual({ messages: 2, complete: true });
  expect(kinds(view.state)).toEqual(["user", "approval", "message"]);
});

test("progressive history does not revive a completed approval before its ending page loads", async () => {
  let release!: () => void;
  const later = new Promise<{ messages: unknown[]; next_offset: null }>((resolve) => { release = () => resolve({ messages: [{ id: "end", role: "system", event: "approval_end", request_id: "old", data: { decision: "abort" } }], next_offset: null }); });
  const fake = await server(handlers("b", {
    status: () => ({ session: meta("b", "x"), state: "idle", pending_approvals: [] }),
    session_history: (params) => params.offset === 0
      ? { messages: [{ id: "start", role: "system", event: "approval_request", request_id: "old", tool_call: { id: "old-tool", name: "bash", arguments: {} }, delegated: false }], next_offset: 1 }
      : later,
  }));
  const view = createSessions(source(fake.client));
  await tick();
  expect(present(view).open?.lease.store.getItem("approval:old")).toBeUndefined();
  release();
  await tick();
  expect(present(view).open?.lease.store.getItem("approval:old")).toMatchObject({ type: "approval", ended: { decision: "abort" } });
});

test("a failed later page keeps its first-page approval and exposes the error", async () => {
  const approval = { request_id: "held", tool_call: { id: "held-tool", name: "bash", arguments: {} }, delegated: false };
  const fake = await server(handlers("b", {
    status: () => ({ session: meta("b", "x"), state: "tool", pending_approvals: [approval] }),
    session_history: (params) => {
      if (params.offset === 0) return { messages: [], next_offset: 1 };
      throw { code: -32000, message: "older history failed" };
    },
  }));
  const view = createSessions(source(fake.client));
  await tick();
  expect(present(view).open?.lease.store.getItem("approval:held")).toMatchObject({ type: "approval" });
  expect(present(view).openError?.message).toBe("older history failed");
});

test("selecting another session resumes it, releases the old one, and reports progress", async () => {
  const fake = await server(handlers("b"));
  const selected: string[] = [];
  const view = createSessions(source(fake.client), { onSelect: (id) => selected.push(id) });
  await tick();
  view.select("a");
  expect(present(view).opening).toEqual({ id: "a", messages: 0 });
  expect(present(view).open?.id).toBe("b");
  expect(present(view).opening).toEqual({ id: "a", messages: 0 });
  await tick();
  expect(selected).toEqual(["a"]);
  expect(present(view).open?.id).toBe("a");
  expect(kinds(view.state)).toEqual(["user"]);
  expect(fake.calls.some(([method, params]) => method === "resume" && params.session_id === "a")).toBe(true);
});

test("switching sessions cancels background history without replacing the new run", async () => {
  let release!: () => void;
  const later = new Promise<{ messages: unknown[]; next_offset: null }>((resolve) => { release = () => resolve({ messages: [], next_offset: null }); });
  const fake = await server(handlers("b", {
    session_history: (params) => {
      if (params.session_id === "b" && params.offset === 0) return { messages: [], next_offset: 1 };
      if (params.session_id === "b") return later;
      return { messages: [{ id: "a", role: "user", content: [{ type: "text", text: "new run" }], tool_result: null }], next_offset: null };
    },
  }));
  const view = createSessions(source(fake.client));
  await tick();
  expect(present(view).open?.id).toBe("b");
  view.select("a");
  await tick();
  expect(present(view).open?.id).toBe("a");
  release();
  await tick();
  expect(present(view).open?.id).toBe("a");
  expect(kinds(view.state)).toEqual(["user"]);
});

test("the newest selection wins when opens overlap", async () => {
  const fake = await server(handlers(null));
  const view = createSessions(source(fake.client));
  await tick();
  view.select("a");
  view.select("b");
  await tick();
  expect(present(view).open?.id).toBe("b");
  expect(present(view).selected).toBe("b");
});

test("a failed replacement keeps the previous run usable", async () => {
  const fake = await server(handlers("b", { resume: (params) => { if (params.session_id === "a") throw { code: -32602, message: "session log is invalid at line 12" }; return {}; } }));
  const view = createSessions(source(fake.client));
  await tick();
  view.select("a");
  await tick();
  expect(present(view).open?.id).toBe("b");
  expect(present(view).openError).toEqual({ id: "a", message: "session log is invalid at line 12", busy: false, restored: true });
  expect(present(view).opening).toBeNull();
});

test("a busy server is reported as busy and the selection stays", async () => {
  const fake = await server(handlers(null, { resume: () => { throw { code: -32004, message: "a turn is already running" }; } }));
  const view = createSessions(source(fake.client));
  await tick();
  view.select("a");
  await Bun.sleep(1_800);
  await tick();
  expect(present(view).openError).toEqual({ id: "a", message: "a turn is already running", busy: true });
  expect(present(view).selected).toBe("a");
});

test("a reconnect retires a backward walk before it can write the new generation", async () => {
  let release!: () => void;
  const held = new Promise((resolve) => { release = () => resolve({ messages: [{ id: "old", role: "user", content: [{ type: "text", text: "old generation" }], tool_result: null }], next_before: null, history_validator: { end: 2, entry_id: "old-new" } }); });
  const backward = ["list_sessions_paging", "session_history_backward"];
  const old = await server(handlers("a", { session_history: (params) => params.before === null
    ? { messages: [{ id: "old-new", role: "assistant", content: [{ type: "text", text: "old newest" }], tool_result: null }], next_before: 1, history_validator: { end: 2, entry_id: "old-new" } }
    : held }), backward);
  const fresh = await server(handlers("a", { session_history: (params) => ({ messages: [{ id: "fresh", role: "assistant", content: [{ type: "text", text: "fresh generation" }], tool_result: null }], next_before: null, history_validator: { end: 1, entry_id: "fresh" } }) }), backward);
  const connection = source(old.client);
  const view = createSessions(connection, { selected: "a" });
  await tick();
  connection.set(fresh.client);
  await tick();
  release();
  await tick();
  const run = present(view).open!;
  const messages = run.lease.store.getOutline().map(({ id }) => run.lease.store.getItem(id)).filter((item) => item?.type === "message");
  expect(messages.flatMap((item) => item?.type === "message" ? item.message.content.flatMap((block) => block.type === "text" ? [block.text] : []) : [])).toEqual(["fresh generation"]);
  view.dispose();
});

test("a drop keeps the old transcript as stale; the reconnect rebuilds it on a fresh store without duplicates", async () => {
  const first = await server(handlers("b"));
  const connection = source(first.client);
  const view = createSessions(connection);
  await tick();
  const before = present(view).open!.lease.store;
  connection.set(null);
  expect(present(view).open).toMatchObject({ id: "b", stale: true });
  const second = await server(handlers("b"));
  connection.set(second.client);
  await tick();
  expect(present(view).open).toMatchObject({ id: "b", stale: false });
  expect(present(view).open!.lease.store).not.toBe(before);
  expect(kinds(view.state)).toEqual(["user", "approval", "message"]);
  const pending = present(view).open!.lease.store.getItem("approval:r1");
  expect(pending?.type).toBe("approval");
  expect(pending && "ended" in pending ? pending.ended : undefined).toBeUndefined();
});

test("a reconnect after grace expiry replaces an in-flight catalog instead of staying loading", async () => {
  let releaseFirst!: () => void;
  const firstCatalog = new Promise<{ sessions: SessionMeta[]; next_offset: null }>((resolve) => {
    releaseFirst = () => resolve({ sessions: [meta("stale", "x")], next_offset: null });
  });
  const first = await server({ ...handlers("b"), list_sessions: () => firstCatalog });
  const connection = source(first.client);
  const view = createSessions(connection);
  await tick();
  expect(view.state.listLoading).toBe(true);

  connection.set(null);
  const secondSessions = [meta("after-grace", "y")];
  const second = await server({ ...handlers("b"), list_sessions: () => ({ sessions: secondSessions, next_offset: null }) });
  connection.set(second.client);
  await tick();

  expect(view.state.listLoading).toBe(false);
  expect(view.state.listReady).toBe(true);
  expect(view.state.listError).toBeNull();
  expect(view.state.sessions).toEqual(secondSessions);
  releaseFirst();
  await tick();
  expect(view.state.sessions).toEqual(secondSessions);
});

test("two reconnects retire both older in-flight catalogs", async () => {
  const releases: Array<() => void> = [];
  const pendingCatalog = (id: string) => new Promise<{ sessions: SessionMeta[]; next_offset: null }>((resolve) => {
    releases.push(() => resolve({ sessions: [meta(id, "x")], next_offset: null }));
  });
  const first = await server({ ...handlers("b"), list_sessions: () => pendingCatalog("first") });
  const connection = source(first.client);
  const view = createSessions(connection);
  await tick();

  connection.set(null);
  const second = await server({ ...handlers("b"), list_sessions: () => pendingCatalog("second") });
  connection.set(second.client);
  await tick();
  connection.set(null);
  const finalSessions = [meta("third", "z")];
  const third = await server({ ...handlers("b"), list_sessions: () => ({ sessions: finalSessions, next_offset: null }) });
  connection.set(third.client);
  await tick();

  expect(view.state.listLoading).toBe(false);
  expect(view.state.listReady).toBe(true);
  expect(view.state.sessions).toEqual(finalSessions);
  releases.forEach((release) => release());
  await tick();
  expect(view.state.sessions).toEqual(finalSessions);
});

test("a negotiated drop keeps the same approval row in reconnecting state across two drops", async () => {
  const features = ["list_sessions_paging", "approval_reconnect"];
  const first = await server(handlers("b"), features);
  const connection = source(first.client);
  const view = createSessions(connection);
  await tick();
  const row = present(view).open!.lease.store.getItem("approval:r1");

  connection.set(null);
  expect(present(view).open!.lease.store.getItem("approval:r1")).toMatchObject({
    id: "approval:r1", request: { state: "reconnecting", status: "reconnecting…" },
  });
  expect(present(view).open!.lease.store.getItem("approval:r1")).not.toBe(row);

  const second = await server(handlers("b"), features);
  connection.set(second.client);
  await waitFor(() => !!present(view).open && !present(view).open!.stale, "approval reconnect did not reopen");
  expect(present(view).open?.lease.store.getState().endOutcome).toBeUndefined();
  connection.set(null);
  expect(present(view).open!.lease.store.getItem("approval:r1")).toMatchObject({
    id: "approval:r1", request: { state: "reconnecting" },
  });
});

test("an old server drop keeps the legacy pending shape", async () => {
  const first = await server(handlers("b"), ["list_sessions_paging"]);
  const connection = source(first.client);
  const view = createSessions(connection);
  await tick();
  connection.set(null);
  const approval = present(view).open!.lease.store.getItem("approval:r1");
  expect(approval?.type === "approval" && approval.request.type === "approval_request" ? approval.request.state : "missing").toBeUndefined();
});

test("a fresh idle snapshot removes a formerly pending approval", async () => {
  const first = await server(handlers("b"));
  const connection = source(first.client);
  const view = createSessions(connection);
  await tick();
  connection.set(null);
  expect(present(view).open!.lease.store.getItem("approval:r1")).toMatchObject({ type: "approval" });
  const second = await server(handlers("b", { status: () => ({ session: meta("b", "x"), state: "idle", pending_approvals: [] }) }));
  connection.set(second.client);
  await tick();
  expect(present(view).open!.lease.store.getItem("approval:r1")).toBeUndefined();
});

test("advertised approval history trusts the fresh snapshot", async () => {
  const first = await server(handlers("c"), ["list_sessions_paging", "approval_history"]);
  const connection = source(first.client);
  const view = createSessions(connection);
  await tick();
  connection.set(null);
  const second = await server(handlers("c", { status: () => ({ session: meta("c", "x"), state: "idle", pending_approvals: [] }) }), ["list_sessions_paging", "approval_history"]);
  connection.set(second.client);
  await tick();
  expect(present(view).open!.lease.store.getItem("approval:r1")).toBeUndefined();
});

test("a running open stays snapshot-only until idle, then reloads one complete message", async () => {
  let statusCalls = 0;
  let historyCalls = 0;
  let emit: ((params: Record<string, unknown>) => void) | null = null;
  const fake = await server(handlers("b", {
    status: () => ({ session: meta("b", "x"), state: ++statusCalls < 2 ? "running" : "idle", pending_approvals: [] }),
    session_history: () => {
      historyCalls++;
      if (historyCalls === 1) queueMicrotask(() => {
        emit?.({ event: "assistant_delta", session_id: "b", delta: " duplicated tail", kind: "assistant" });
        emit?.({ event: "assistant_message", session_id: "b", message: { role: "assistant", content: [{ type: "text", text: "partial duplicated tail" }] } });
      });
      return { messages: [{ id: "m", role: "assistant", content: [{ type: "text", text: historyCalls === 1 ? "partial" : "complete" }], tool_result: null }], next_offset: null };
    },
  }));
  emit = fake.event;
  const view = createSessions(source(fake.client));
  await tick();
  expect(present(view).open?.syncing).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 550));
  const messages = present(view).open!.lease.store.getOutline().map(({ id }) => present(view).open!.lease.store.getItem(id)).filter((item) => item?.type === "message");
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ type: "message", message: { content: [{ type: "text", text: "complete" }] } });
  expect(present(view).open?.syncing).toBe(false);
});

test("snapshot-only mode discovers an approval that starts after history loads", async () => {
  let statusCalls = 0;
  const fake = await server(handlers("b", {
    status: () => ({
      session: meta("b", "x"),
      state: ++statusCalls >= 2 ? "tool" : "running",
      pending_approvals: statusCalls >= 2 ? [{ request_id: "late", tool_call: { id: "late-tool", name: "bash", arguments: { command: "bun test" } }, delegated: false }] : [],
    }),
  }));
  const connection = source(fake.client);
  const view = createSessions(connection);
  await new Promise((resolve) => setTimeout(resolve, 550));
  expect(present(view).open!.lease.store.getItem("approval:late")).toMatchObject({ type: "approval", request: { request_id: "late" } });
  connection.set(null);
});

test("live events after the open land in the open store", async () => {
  const fake = await server(handlers("b"));
  const view = createSessions(source(fake.client));
  await tick();
  fake.event({ event: "assistant_delta", session_id: "b", delta: "streaming", kind: "assistant" });
  expect(kinds(view.state)).toEqual(["user", "approval", "message", "message"]);
});

// zeta's `new_session` answers `{ session: <full metadata> }` and makes it the server's session (server.py).
test("create starts a session with new_session, lists it, and opens it without resume", async () => {
  let current: string | null = null;
  const created = meta("new-1", "2026-11-04T10:00:00Z", { name: "", cwd: "/tmp/project", model: "qwen3.6:35b" });
  const fake = await server(handlers(null, {
    new_session: () => { current = created.session_id; return { session: created }; },
    list_sessions: () => ({ sessions: current ? [created, ...sessions] : sessions, next_offset: null }),
    status: () => ({ session: current ? created : null, state: "idle", pending_approvals: [] }),
    session_history: () => ({ messages: [], next_offset: null }),
  }));
  const selected: string[] = [];
  const view = createSessions(source(fake.client), { onSelect: (id) => selected.push(id) });
  await tick();
  await view.create();
  await tick();
  expect(fake.calls.find(([method]) => method === "new_session")).toEqual(["new_session", {}]);
  expect(fake.calls.map(([method]) => method)).not.toContain("resume");
  expect(view.state.sessions.map((session) => session.session_id)).toContain("new-1");
  expect(present(view).open?.id).toBe("new-1");
  expect(present(view).selected).toBe("new-1");
  expect(selected).toEqual(["new-1"]);
  expect(view.state.createError).toBeNull();
});

test("a failed create keeps the current session and says why", async () => {
  const fake = await server(handlers("b", { new_session: () => { throw { code: -32004, message: "a turn is already running" }; } }));
  const view = createSessions(source(fake.client));
  await tick();
  await view.create();
  expect(view.state.createError).toBe("a turn is already running");
  expect(present(view).open?.id).toBe("b");
});

test("selecting a session cancels create without showing an error", async () => {
  const fake = await server(handlers("b", { new_session: () => new Promise(() => {}) }));
  const view = createSessions(source(fake.client));
  await tick();
  void view.create();
  await tick();
  view.select("a");
  await tick();
  expect(view.state.createError).toBeNull();
  expect(present(view).selected).toBe("a");
  expect(fake.calls.filter(([method]) => method === "new_session")).toHaveLength(1);
});
