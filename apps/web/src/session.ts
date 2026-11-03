import { fromZetaEvent, fromZetaHistory, type SessionLease, type ZetaClient } from "@fulcrum/zeta";
import type { RunEvent } from "@fulcrum/core";

/** The `SessionMetadata` fields this app reads from `list_sessions` (zeta docs/serve-protocol.md). */
export type SessionMeta = {
  session_id: string;
  name?: string;
  first_message_preview?: string;
  created_at: string;
  updated_at: string;
  provider?: string;
  model?: string;
  cwd?: string;
  parent_session_id?: string | null;
};

export type ServerStatus = {
  session: SessionMeta | null;
  state: "idle" | "running" | "tool";
  pending_approvals: Array<{ request_id: string; tool_call: unknown; delegated: boolean; agent_instance_id?: string }>;
};

export const PAGE_SIZE = 100;

/** The name, else the first prompt, else where it ran and a short id, so untitled rows still differ. */
export const sessionTitle = (session: SessionMeta) =>
  session.name?.trim() || session.first_message_preview?.trim() ||
  (session.cwd ? `${session.cwd.split("/").filter(Boolean).at(-1) ?? "/"} · ${session.session_id.slice(0, 8)}` : "untitled session");

/** "now", "4m", "3h", "2d", then a short date. Short, because the list is narrow and scanned, not read. */
export function ago(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d`;
  return new Date(then).toLocaleDateString("en", { month: "short", day: "numeric", ...(new Date(then).getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }) });
}

/** Newest first. Child sessions (workers a session started) are left out; the parent row stands for them. */
export const topLevel = (sessions: readonly SessionMeta[]) =>
  sessions.filter((session) => !session.parent_session_id).sort((a, b) => b.updated_at.localeCompare(a.updated_at));

export async function listSessions(client: ZetaClient, offset = 0): Promise<{ sessions: SessionMeta[]; nextOffset: number | null }> {
  const paged = client.features.includes("list_sessions_paging");
  const result = (await client.request("list_sessions", paged ? { offset, limit: PAGE_SIZE } : {}, { timeoutMs: 15_000 })) as { sessions?: SessionMeta[]; next_offset?: number | null };
  return { sessions: result.sessions ?? [], nextOffset: paged ? result.next_offset ?? null : null };
}

export const getStatus = (client: ZetaClient) => client.request("status", {}, { timeoutMs: 15_000 }) as Promise<ServerStatus>;

export type OpenProgress = (messages: number) => void;

/**
 * Makes `id` the server's session and rebuilds it on a fresh store: every `session_history` page, then pending
 * approvals from `status`, then the live events that arrived meanwhile. `resume` is skipped when the session is
 * already the server's: zeta's resume ends pending approvals.
 */
export async function openSession(client: ZetaClient, id: string, progress?: OpenProgress): Promise<SessionLease> {
  return client.replay(id, async () => {
    const before = await getStatus(client);
    if (before.session?.session_id !== id) await client.request("resume", { session_id: id }, { timeoutMs: 30_000 });
    const rows: unknown[] = [];
    for (let offset: number | null = 0; offset !== null; ) {
      const page = (await client.request("session_history", { session_id: id, offset }, { timeoutMs: 15_000 })) as { messages?: unknown[]; next_offset?: number | null };
      rows.push(...(page.messages ?? []));
      progress?.(rows.length);
      offset = page.next_offset ?? null;
    }
    const status = await getStatus(client);
    const events: RunEvent[] = fromZetaHistory(rows);
    for (const approval of status.pending_approvals ?? [])
      events.push(...fromZetaEvent({ event: "approval_request", session_id: id, ...approval }));
    // History has no "turn ended" marker: an idle server means no call from history still runs.
    if (status.state === "idle") events.push({ type: "run_end" });
    else events.push({ type: "run_start" });
    return events;
  });
}

/** Zeta answers `resume` with -32004 while another session's turn runs. */
export const isBusyError = (error: unknown) => (error as { code?: unknown } | null)?.code === -32004;

export type SessionsState = {
  sessions: SessionMeta[];
  nextOffset: number | null;
  listError: string | null;
  /** The server's own session from `status` and what it is doing. */
  server: { id: string | null; state: ServerStatus["state"]; approvals: number } | null;
  selected: string | null;
  /** The rebuilt session on screen. After a drop it stays until a reconnect replaces it; `stale` marks that. */
  open: { id: string; lease: SessionLease; stale: boolean } | null;
  opening: { id: string; messages: number } | null;
  openError: { id: string; message: string; busy: boolean } | null;
};

type Source = { readonly client: ZetaClient | null; subscribe(listener: () => void): () => void };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Session list and selection over a connection. On every connect it reloads the list and reopens the selected
 * session, or the server's own session when nothing is selected. The newest `select` wins; leases of abandoned
 * opens are released.
 */
export function createSessions(connection: Source, { selected = null, onSelect }: { selected?: string | null; onSelect?: (id: string) => void } = {}) {
  let state: SessionsState = { sessions: [], nextOffset: null, listError: null, server: null, selected, open: null, opening: null, openError: null };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<SessionsState>) => { state = { ...state, ...patch }; listeners.forEach((listener) => listener()); };
  let client: ZetaClient | null = null;
  let openGeneration = 0;
  const live = (target: ZetaClient) => client === target;

  const refresh = async () => {
    const target = client;
    if (!target) return;
    try {
      const [list, status] = await Promise.all([listSessions(target), getStatus(target)]);
      if (!live(target)) return;
      set({
        sessions: list.sessions,
        nextOffset: list.nextOffset,
        listError: null,
        server: { id: status.session?.session_id ?? null, state: status.state, approvals: status.pending_approvals?.length ?? 0 },
      });
    } catch (error) {
      if (live(target)) set({ listError: message(error) });
    }
  };

  const open = async (id: string) => {
    const target = client;
    const mine = ++openGeneration;
    set({ selected: id, opening: { id, messages: 0 }, openError: null });
    if (!target) return;
    // The view moves off the old session now, so its lease goes before the new store is built.
    if (state.open && state.open.id !== id) { state.open.lease.release(); set({ open: null }); }
    try {
      const lease = await openSession(target, id, (messages) => { if (mine === openGeneration) set({ opening: { id, messages } }); });
      if (mine !== openGeneration || !live(target)) return lease.release();
      state.open?.lease.release();
      set({ open: { id, lease, stale: false }, opening: null });
      void refresh();
    } catch (error) {
      if (mine !== openGeneration || !live(target)) return;
      set({ opening: null, openError: { id, message: message(error), busy: isBusyError(error) } });
    }
  };

  const onConnection = () => {
    if (connection.client === client) return;
    client = connection.client;
    if (!client) {
      openGeneration++;
      if (state.open) set({ open: { ...state.open, stale: true }, opening: null });
      return;
    }
    void (async () => {
      const target = client!;
      await refresh();
      if (!live(target)) return;
      const id = state.selected ?? state.server?.id ?? null;
      if (id) void open(id);
    })();
  };
  const unsubscribe = connection.subscribe(onConnection);
  onConnection();

  return {
    get state() { return state; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    select(id: string) {
      if (id === state.selected && (state.opening?.id === id || (state.open?.id === id && !state.open.stale))) return;
      onSelect?.(id);
      void open(id);
    },
    refresh,
    async loadMore() {
      const target = client;
      if (!target || state.nextOffset === null) return;
      try {
        const page = await listSessions(target, state.nextOffset);
        if (live(target)) set({ sessions: [...state.sessions, ...page.sessions], nextOffset: page.nextOffset });
      } catch (error) {
        if (live(target)) set({ listError: message(error) });
      }
    },
    dispose() {
      unsubscribe();
      openGeneration++;
      state.open?.lease.release();
    },
  };
}
export type Sessions = ReturnType<typeof createSessions>;
