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
  const result = (await client.request("list_sessions", paged ? { offset, limit: PAGE_SIZE } : {})) as { sessions?: SessionMeta[]; next_offset?: number | null };
  return { sessions: result.sessions ?? [], nextOffset: paged ? result.next_offset ?? null : null };
}

export const getStatus = (client: ZetaClient, signal?: AbortSignal) => client.request("status", {}, { timeoutMs: 15_000, signal }) as Promise<ServerStatus>;

export type OpenProgress = (messages: number, complete: boolean) => void;
export type OpenResult = { lease: SessionLease; syncing: boolean; complete: Promise<{ lease?: SessionLease; syncing: boolean }> };

type HistoryPage = { messages?: unknown[]; next_offset?: number | null };
const snapshotEvents = (id: string, rows: unknown[], status: ServerStatus): RunEvent[] => {
  const events = fromZetaHistory(rows);
  for (const approval of status.pending_approvals ?? [])
    events.push(...fromZetaEvent({ event: "approval_request", session_id: id, ...approval }));
  events.push({ type: status.state === "idle" ? "run_end" : "run_start" });
  return events;
};
const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(Object.assign(new Error("request aborted"), { name: "AbortError" }));
  const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error("request aborted"), { name: "AbortError" })); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
});

/** Opens the first history page immediately. Older pages continue in the same quarantined snapshot. */
export async function openSession(client: ZetaClient, id: string, progress?: OpenProgress, signal?: AbortSignal): Promise<OpenResult> {
  if (client.features.includes("session_replay_seq")) throw new Error("session_replay_seq needs the sequence replay coordinator");
  let rows: unknown[] = [];
  let nextOffset: number | null = null;
  let initialStatus!: ServerStatus;
  const lease = await client.replay(id, async () => {
    const before = await getStatus(client, signal);
    if (before.session?.session_id !== id) await client.request("resume", { session_id: id }, { timeoutMs: 30_000, signal });
    const page = await client.request("session_history", { session_id: id, offset: 0 }, { timeoutMs: 15_000, signal }) as HistoryPage;
    rows = page.messages ?? [];
    nextOffset = page.next_offset ?? null;
    initialStatus = await getStatus(client, signal);
    progress?.(rows.length, nextOffset === null);
    return [...fromZetaHistory(rows), { type: initialStatus.state === "idle" ? "run_end" as const : "run_start" as const }];
  }, true);

  const complete = (async (): Promise<{ lease?: SessionLease; syncing: boolean }> => {
    const laterEvents: RunEvent[] = [];
    let pages = 0;
    for (let offset: number | null = nextOffset; offset !== null; ) {
      const page = await client.request("session_history", { session_id: id, offset }, { timeoutMs: 15_000, signal }) as HistoryPage;
      const pageRows = page.messages ?? [];
      rows.push(...pageRows);
      laterEvents.push(...fromZetaHistory(pageRows));
      offset = page.next_offset ?? null;
      pages++;
      if (offset === null || pages % 25 === 0) progress?.(rows.length, offset === null);
    }
    for (const event of laterEvents) lease.store.dispatch(event);
    let status = await getStatus(client, signal);
    for (const event of snapshotEvents(id, [], status)) lease.store.dispatch(event);
    if (status.state === "idle") {
      client.finishReplay(id);
      return { syncing: false };
    }
    let pending = JSON.stringify(status.pending_approvals ?? []);
    while (status.state !== "idle") {
      await wait(500, signal);
      status = await getStatus(client, signal);
      const nextPending = JSON.stringify(status.pending_approvals ?? []);
      if (nextPending !== pending) {
        for (const event of snapshotEvents(id, [], status)) if (event.type === "approval_request") lease.store.dispatch(event);
        pending = nextPending;
      }
    }
    const finalRows: unknown[] = [];
    for (let offset: number | null = 0; offset !== null; ) {
      const page = await client.request("session_history", { session_id: id, offset }, { timeoutMs: 15_000, signal }) as HistoryPage;
      finalRows.push(...(page.messages ?? []));
      offset = page.next_offset ?? null;
    }
    const finalStatus = await getStatus(client, signal);
    const finalLease = await client.replay(id, async () => snapshotEvents(id, finalRows, finalStatus));
    return { lease: finalLease, syncing: false };
  })();
  return { lease, syncing: initialStatus.state !== "idle", complete };
}

/** Zeta answers `resume` with -32004 while another session's turn runs. */
export const isBusyError = (error: unknown) => (error as { code?: unknown } | null)?.code === -32004;

export type SessionsState = {
  sessions: SessionMeta[];
  nextOffset: number | null;
  listError: string | null;
  listLoading: boolean;
  listSlow: boolean;
  listReady: boolean;
  /** The server's own session from `status` and what it is doing. */
  server: { id: string | null; state: ServerStatus["state"]; approvals: number } | null;
  selected: string | null;
  /** The rebuilt session on screen. After a drop it stays until a reconnect replaces it; `stale` marks that. */
  open: { id: string; lease: SessionLease; stale: boolean; history: { messages: number; complete: boolean }; syncing: boolean } | null;
  opening: { id: string; messages: number } | null;
  openError: { id: string; message: string; busy: boolean; restored?: boolean } | null;
  /** A `new_session` in flight, and why the last one failed. */
  creating: boolean;
  createError: string | null;
};

type Source = { readonly client: ZetaClient | null; subscribe(listener: () => void): () => void };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Session list and selection over a connection. On every connect it reloads the list and reopens the selected
 * session, or the server's own session when nothing is selected. The newest `select` wins; leases of abandoned
 * opens are released.
 */
export function createSessions(connection: Source, { selected = null, onSelect }: { selected?: string | null; onSelect?: (id: string) => void } = {}) {
  let state: SessionsState = { sessions: [], nextOffset: null, listError: null, listLoading: false, listSlow: false, listReady: false, server: null, selected, open: null, opening: null, openError: null, creating: false, createError: null };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<SessionsState>) => { state = { ...state, ...patch }; listeners.forEach((listener) => listener()); };
  let client: ZetaClient | null = null;
  let openGeneration = 0;
  let openAbort: AbortController | null = null;
  const live = (target: ZetaClient) => client === target;

  let listInFlight: Promise<void> | null = null;
  const localSessions = new Map<string, { session: SessionMeta; createdGeneration: number }>();
  let listGeneration = 0;
  let listSlowTimer: ReturnType<typeof setTimeout> | null = null;
  const refresh = async () => {
    if (listInFlight) return listInFlight;
    const target = client;
    if (!target) return;
    const generation = ++listGeneration;
    set({ listLoading: true, listSlow: false, listError: null, listReady: false });
    listSlowTimer = setTimeout(() => { if (live(target)) set({ listSlow: true }); }, 5_000);
    listInFlight = (async () => {
      try {
        const list = await listSessions(target);
        if (!live(target)) return;
        const visible = new Map(list.sessions.map((session) => [session.session_id, session]));
        for (const [id, local] of localSessions) {
          if (local.createdGeneration < generation) localSessions.delete(id);
          else if (!visible.has(id)) visible.set(id, local.session);
        }
        set({ sessions: [...visible.values()], nextOffset: list.nextOffset, listError: null, listLoading: false, listSlow: false, listReady: true });
      } catch (error) {
        if (live(target)) set({ listLoading: false, listSlow: false, listError: message(error) });
      } finally {
        if (listSlowTimer !== null) clearTimeout(listSlowTimer);
        listSlowTimer = null;
        listInFlight = null;
      }
    })();
    return listInFlight;
  };

  const open = async (id: string) => {
    const target = client;
    const mine = ++openGeneration;
    openAbort?.abort();
    const abort = new AbortController();
    openAbort = abort;
    set({ selected: id, opening: { id, messages: 0 }, openError: null });
    if (!target) return;
    const previousId = state.open?.id !== id ? state.open?.id : null;
    try {
      let history = { messages: 0, complete: false };
      const opened = await openSession(target, id, (messages, complete) => {
        history = { messages, complete };
        if (mine !== openGeneration) return;
        if (state.open?.id === id) set({ open: { ...state.open, history } });
        else set({ opening: { id, messages } });
      }, abort.signal);
      const { lease } = opened;
      if (mine !== openGeneration || !live(target)) return lease.release();
      state.open?.lease.release();
      set({ open: { id, lease, stale: false, history, syncing: opened.syncing }, opening: null });
      void opened.complete.then((result) => {
        if (mine !== openGeneration || !live(target)) return result.lease?.release();
        if (result.lease) {
          state.open?.lease.release();
          set({ open: { id, lease: result.lease, stale: false, history: { ...history, complete: true }, syncing: result.syncing } });
        } else if (state.open?.id === id) set({ open: { ...state.open, history: { ...history, complete: true }, syncing: result.syncing } });
      }).catch((error) => {
        if (mine === openGeneration && live(target) && (error as { name?: string }).name !== "AbortError")
          set({ openError: { id, message: message(error), busy: isBusyError(error) } });
      });
    } catch (error) {
      if (mine !== openGeneration || !live(target)) return;
      let restored = false;
      if (previousId) {
        try {
          await target.request("resume", { session_id: previousId }, { timeoutMs: 30_000 });
          restored = true;
        } catch { /* keep the retained run read-only with an explicit reopen action */ }
      }
      if (mine !== openGeneration || !live(target)) return;
      if (restored && previousId) onSelect?.(previousId);
      set({ ...(restored && previousId ? { selected: previousId } : {}), opening: null, openError: { id, message: message(error), busy: isBusyError(error), ...(restored ? { restored: true } : {}) } });
    }
  };

  const onConnection = () => {
    if (connection.client === client) return;
    client = connection.client;
    if (!client) {
      openGeneration++;
      openAbort?.abort();
      if (state.open) set({ open: { ...state.open, stale: true }, opening: null });
      return;
    }
    set({ listReady: false, listError: null });
    void (async () => {
      const target = client!;
      try {
        const status = await getStatus(target);
        if (!live(target)) return;
        set({ server: { id: status.session?.session_id ?? null, state: status.state, approvals: status.pending_approvals?.length ?? 0 } });
        const id = state.selected ?? status.session?.session_id ?? null;
        void refresh();
        if (id) {
          await open(id);
          if (!live(target)) return;
        }
      } catch (error) {
        if (live(target)) set({ openError: { id: state.selected ?? "", message: message(error), busy: isBusyError(error) } });
      }
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
    dismissOpenError() { set({ openError: null }); },
    /** Starts a session with zeta's `new_session` (which makes it the server's own), then opens it. */
    async create() {
      const target = client;
      if (!target || state.creating) return;
      set({ creating: true, createError: null });
      try {
        const { session } = (await target.request("new_session", {}, { timeoutMs: 30_000 })) as { session: SessionMeta };
        if (!live(target)) return set({ creating: false });
        localSessions.set(session.session_id, { session, createdGeneration: listGeneration });
        set({ creating: false, sessions: [session, ...state.sessions.filter((item) => item.session_id !== session.session_id)] });
        onSelect?.(session.session_id);
        await open(session.session_id);
        void refresh();
      } catch (error) {
        set({ creating: false, createError: live(target) ? message(error) : null });
      }
    },
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
      if (listSlowTimer !== null) clearTimeout(listSlowTimer);
      listSlowTimer = null;
      openGeneration++;
      openAbort?.abort();
      state.open?.lease.release();
    },
  };
}
export type Sessions = ReturnType<typeof createSessions>;
