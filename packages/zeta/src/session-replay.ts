import type { RunEvent } from "@fulcrum/core";
import { backfillBackwardHistory, type BackwardHistoryPage } from "./backward-history.js";
import { call, deliver } from "./host.js";
import { parseJoinStatus, type EventParams, type HistoryValidator, type JoinStatus, type SessionReplayJoinResult } from "./wire.js";

export type ReplayJoinState =
  | { phase: "joining"; attempt: number }
  | { phase: "joined"; streamId: string; lastSeq: number }
  | { phase: "rejoining"; attempt: number }
  | { phase: "failed"; message: string; retryable: true }
  | { phase: "suspended" };
export type ReplayHistoryState =
  | { phase: "loading"; messages: number }
  | { phase: "complete"; messages: number }
  | { phase: "incomplete"; messages: number; reason: "timeout" | "rpc_error" | "stale_limit" };
export type SessionReplayState = {
  readonly replay: ReplayJoinState;
  readonly history: ReplayHistoryState;
  readonly approvals: { readonly incomplete: "observer" | "server_truncated" | null };
};
export type ReplayStore = {
  readonly getItem: (id: string) => unknown;
  readonly getOutline: () => readonly { id: string }[];
  readonly getState: () => unknown;
  resync(events: readonly RunEvent[]): void;
  beginHistory(): void;
  prepend(events: readonly RunEvent[]): void;
  endHistory(): void;
  dispatch(event: RunEvent): void;
};
export interface SessionReplayLease {
  readonly store: ReplayStore;
  readonly state: SessionReplayState;
  subscribeReplay(listener: () => void): () => void;
  retry(): void;
  retryHistory(): void;
  suspend(): void;
  release(): void;
}
export type ReplayMode = "legacy" | "sequenced";
export class ReplayOwnershipError extends Error {
  readonly name = "ReplayOwnershipError";
  constructor(readonly kind: "session_owned_by_other_mode") { super("session is owned by another replay mode"); }
}
export class SessionReplayError extends Error {
  readonly name = "SessionReplayError";
  constructor(readonly kind: "invalid_response", message = "session replay response is invalid") { super(message); }
}

type Request = (method: string, params: unknown, options: { signal: AbortSignal; timeoutMs: number }) => Promise<unknown>;
type Owner = {
  readonly session: string;
  readonly mode: ReplayMode;
  generation: number;
  leases: number;
  store?: ReplayStore;
  controller?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  wake?: () => void;
  streamId?: string;
  lastSeq: number;
  joining: boolean;
  suspended: boolean;
  released: boolean;
  buffer: EventParams[];
  retainedApprovalEnds: Map<string, RunEvent>;
  openApprovals: Set<string>;
  state: SessionReplayState;
  listeners: Set<() => void>;
  navigationSignal?: AbortSignal;
};

const RETRY_DELAYS = [0, 500, 1_000, 2_000, 4_000, 8_000] as const;
const staleEventSequence = (error: unknown) => {
  const rpc = error as { code?: unknown; data?: { code?: unknown } } | null;
  return rpc?.code === -32009 && rpc.data?.code === "stale_event_sequence";
};
const staleHistorySnapshot = (error: unknown) => {
  const rpc = error as { code?: unknown; data?: { code?: unknown } } | null;
  return rpc?.code === -32009 && rpc.data?.code === "stale_history_snapshot";
};
const abortError = (error: unknown) => (error as { name?: unknown } | null)?.name === "AbortError";
const safeInteger = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && (value as number) >= minimum;
const validator = (value: unknown): value is HistoryValidator => {
  const row = value as Record<string, unknown> | null;
  return Boolean(row && !Array.isArray(row) && safeInteger(row.end) && (row.entry_id === null || typeof row.entry_id === "string"));
};
const parseJoin = (value: unknown): SessionReplayJoinResult => {
  const row = value as Record<string, unknown> | null;
  const replay = row?.replay as Record<string, unknown> | null;
  const status = parseJoinStatus(row?.status);
  if (!row || Array.isArray(row) || !Array.isArray(row.messages) ||
      (row.next_before !== null && !safeInteger(row.next_before)) || !validator(row.history_validator) ||
      !replay || Array.isArray(replay) || typeof replay.stream_id !== "string" || replay.stream_id.length === 0 ||
      !safeInteger(replay.history_seq) || !status || typeof status.pending_approvals_truncated !== "boolean")
    throw new SessionReplayError("invalid_response");
  return { messages: row.messages, next_before: row.next_before as number | null, history_validator: row.history_validator,
    replay: { stream_id: replay.stream_id, history_seq: replay.history_seq },
    status: status as JoinStatus & { pending_approvals_truncated: boolean } };
};
const approvalId = (row: unknown) => {
  const value = row as Record<string, unknown> | null;
  return value?.event === "approval_request" || value?.event === "approval_end" ? (typeof value.request_id === "string" ? value.request_id : undefined) : undefined;
};
const statusEvent = (status: JoinStatus): RunEvent => status.state === "idle" ? { type: "run_end" } : { type: "run_start" };
type ApprovalRequestEvent = Extract<RunEvent, { type: "approval_request" }>;
const baselineApproval = (approval: JoinStatus["pending_approvals"][number]): ApprovalRequestEvent => ({
  type: "approval_request", request_id: approval.request_id, tool_call: approval.tool_call, delegated: approval.delegated,
  ...(approval.resolution_pending ? { state: "resolving" as const } : {}),
});

export function createReplayRegistry(deps: {
  readonly request: Request;
  readonly makeStore: (session: string) => ReplayStore;
  readonly commitStore: (session: string, store: ReplayStore) => void;
  readonly adaptHistory: (rows: readonly unknown[]) => RunEvent[];
  readonly adaptEvent: (params: EventParams) => RunEvent[];
  readonly stampEvent: (event: RunEvent, session: string) => RunEvent;
  readonly role: () => "controller" | "observer";
  readonly protocolViolation?: (message: string) => void;
}) {
  const owners = new Map<string, Owner>();
  let activeSequencedOwner: Owner | undefined;
  let closed = false;

  const active = (owner: Owner, generation: number) => !closed && !owner.released && owners.get(owner.session) === owner && owner.generation === generation;
  const publish = (owner: Owner, generation: number, state: SessionReplayState) => {
    if (!active(owner, generation)) return;
    owner.state = state;
    deliver(owner.listeners, undefined);
  };
  const cancel = (owner: Owner) => {
    owner.controller?.abort();
    owner.controller = undefined;
    if (owner.timer) clearTimeout(owner.timer);
    owner.timer = undefined;
    owner.wake?.();
    owner.wake = undefined;
    owner.joining = false;
    owner.streamId = undefined;
    owner.buffer = [];
    owner.retainedApprovalEnds.clear();
    owner.openApprovals.clear();
  };
  const acquire = (session: string, mode: ReplayMode) => {
    const existing = owners.get(session);
    if (existing && existing.mode !== mode) throw new ReplayOwnershipError("session_owned_by_other_mode");
    if (existing) {
      cancel(existing);
      existing.generation++;
      existing.suspended = false;
      return existing;
    }
    const owner: Owner = {
      session, mode, generation: 1, leases: 0, lastSeq: 0, joining: false, suspended: false, released: false,
      buffer: [], retainedApprovalEnds: new Map(), openApprovals: new Set(), listeners: new Set(),
      state: { replay: { phase: "joining", attempt: 1 }, history: { phase: "loading", messages: 0 }, approvals: { incomplete: null } },
    };
    owners.set(session, owner);
    return owner;
  };
  const releaseOwner = (owner: Owner) => {
    if (owner.leases > 0 || owners.get(owner.session) !== owner) return;
    cancel(owner);
    owner.released = true;
    owners.delete(owner.session);
    if (activeSequencedOwner === owner) activeSequencedOwner = undefined;
  };
  const suspend = (owner: Owner) => {
    const generation = owner.generation;
    cancel(owner);
    owner.suspended = true;
    if (activeSequencedOwner === owner) activeSequencedOwner = undefined;
    publish(owner, generation, { ...owner.state, replay: { phase: "suspended" } });
  };
  const transferSlot = (owner: Owner) => {
    if (activeSequencedOwner && activeSequencedOwner !== owner) suspend(activeSequencedOwner);
    activeSequencedOwner = owner;
  };
  const wait = (owner: Owner, generation: number, delay: number) => new Promise<void>((resolve) => {
    if (!delay || !active(owner, generation)) return resolve();
    owner.wake = resolve;
    owner.timer = setTimeout(() => { owner.timer = undefined; owner.wake = undefined; resolve(); }, delay);
  });
  const violation = (message: string) => call(() => deps.protocolViolation?.(message));
  const reconcilePage = (owner: Owner, rows: readonly unknown[], continuation: boolean) => {
    const events = deps.adaptHistory(rows);
    const output: RunEvent[] = [];
    for (const event of events) {
      if (event.type === "approval_request") {
        const retained = owner.retainedApprovalEnds.get(event.request_id);
        if (retained) {
          if (!continuation) {
            violation(`approval request ${event.request_id} arrived after its retained end`);
            continue;
          }
          output.push(event, retained);
          owner.retainedApprovalEnds.delete(event.request_id);
          continue;
        }
      }
      output.push(event);
    }
    return output;
  };
  const joinedEvents = (owner: Owner, result: SessionReplayJoinResult) => {
    const pageEvents = deps.adaptHistory(result.messages);
    const delivered = new Set(pageEvents.flatMap((event) => event.type === "user_message" && event.delivery_id ? [event.delivery_id] : []));
    const optimistic = owner.store?.getOutline().flatMap(({ id }) => {
      const item = owner.store?.getItem(id) as { type?: unknown; event?: RunEvent } | undefined;
      const event = item?.type === "user" ? item.event : undefined;
      return event?.type === "user_message" && event.intent && event.delivery_id && !delivered.has(event.delivery_id) ? [event] : [];
    }) ?? [];
    const baseline = result.status.pending_approvals.map(baselineApproval);
    const available = new Set(baseline.map((event) => event.request_id));
    const ended = new Set(pageEvents.flatMap((event) => event.type === "approval_end" ? [event.request_id] : []));
    const output: RunEvent[] = [statusEvent(result.status), ...baseline];
    for (const event of pageEvents) {
      if (event.type === "approval_request") available.add(event.request_id);
      if (event.type === "approval_end" && !available.has(event.request_id)) {
        owner.retainedApprovalEnds.set(event.request_id, event);
        continue;
      }
      output.push(event);
    }
    owner.openApprovals = new Set([...available].filter((id) => !ended.has(id)));
    output.push(...optimistic);
    return output;
  };
  const finishHistory = (owner: Owner, generation: number) => {
    if (!active(owner, generation)) return;
    if (owner.retainedApprovalEnds.size) violation("history completed with unmatched approval ends");
    owner.retainedApprovalEnds.clear();
    call(() => owner.store?.endHistory());
  };

  const startJoin = async (owner: Owner, rejoining: boolean, staleCycles = 0): Promise<void> => {
    const generation = owner.generation;
    transferSlot(owner);
    owner.joining = true;
    owner.streamId = undefined;
    for (let index = 0; index < RETRY_DELAYS.length; index++) {
      if (!active(owner, generation) || owner.suspended || activeSequencedOwner !== owner) return;
      await wait(owner, generation, RETRY_DELAYS[index]!);
      if (!active(owner, generation) || owner.suspended || activeSequencedOwner !== owner) return;
      publish(owner, generation, { ...owner.state, replay: { phase: rejoining ? "rejoining" : "joining", attempt: index + 1 } });
      const controller = new AbortController();
      owner.controller = controller;
      const navigation = owner.navigationSignal;
      const abort = () => controller.abort();
      navigation?.addEventListener("abort", abort, { once: true });
      try {
        const result = parseJoin(await deps.request("session_history_and_subscribe", { session_id: owner.session }, { signal: controller.signal, timeoutMs: 15_000 }));
        if (!active(owner, generation) || controller.signal.aborted || activeSequencedOwner !== owner) return;
        owner.controller = undefined;
        owner.streamId = result.replay.stream_id;
        owner.lastSeq = result.replay.history_seq;
        const candidate = deps.makeStore(owner.session);
        call(() => candidate.beginHistory());
        call(() => candidate.resync(joinedEvents(owner, result)));
        owner.store = candidate;
        deps.commitStore(owner.session, candidate);
        const incomplete = deps.role() === "observer" ? "observer" : result.status.pending_approvals_truncated ? "server_truncated" : null;
        if (result.status.pending_approvals_truncated) violation("replay join reported truncated pending approvals");
        owner.state = {
          replay: { phase: "joined", streamId: owner.streamId, lastSeq: owner.lastSeq },
          history: result.next_before === null ? { phase: "complete", messages: result.messages.length } : { phase: "loading", messages: result.messages.length },
          approvals: { incomplete },
        };
        owner.joining = false;
        publish(owner, generation, owner.state);
        const buffered = owner.buffer.splice(0);
        for (const frame of buffered) route(frame);
        const joinPage: BackwardHistoryPage = { messages: result.messages, nextBefore: result.next_before, validator: result.history_validator };
        if (joinPage.nextBefore === null) {
          finishHistory(owner, generation);
          return;
        }
        void backfill(owner, generation, joinPage, staleCycles);
        return;
      } catch (error) {
        navigation?.removeEventListener("abort", abort);
        owner.controller = undefined;
        if (!active(owner, generation) || controller.signal.aborted || abortError(error)) return;
        if (staleEventSequence(error) && index + 1 < RETRY_DELAYS.length) continue;
        publish(owner, generation, { ...owner.state, replay: { phase: "failed", message: "could not join live updates", retryable: true } });
        owner.joining = false;
        return;
      } finally {
        navigation?.removeEventListener("abort", abort);
      }
    }
  };
  const backfill = async (owner: Owner, generation: number, joinPage: BackwardHistoryPage, staleCycles: number) => {
    const controller = new AbortController();
    owner.controller = controller;
    let messages = joinPage.messages.length;
    try {
      await backfillBackwardHistory(joinPage, async (cursor, signal) => deps.request("session_history", {
        session_id: owner.session,
        before: cursor.before,
        history_validator: cursor.historyValidator,
      }, { signal, timeoutMs: 15_000 }), {
        signal: controller.signal,
        onPage(page) {
          if (!active(owner, generation) || activeSequencedOwner !== owner) return;
          const events = reconcilePage(owner, page.messages, true);
          call(() => owner.store?.prepend(events));
          messages += page.messages.length;
          publish(owner, generation, { ...owner.state, history: page.nextBefore === null ? { phase: "complete", messages } : { phase: "loading", messages } });
        },
      });
      if (active(owner, generation)) finishHistory(owner, generation);
    } catch (error) {
      if (!active(owner, generation) || controller.signal.aborted || abortError(error)) return;
      if (staleHistorySnapshot(error)) {
        if (staleCycles < 3) {
          cancel(owner);
          owner.generation++;
          void startJoin(owner, true, staleCycles + 1);
        } else {
          finishHistory(owner, generation);
          publish(owner, generation, { replay: { phase: "failed", message: "could not join live updates", retryable: true }, history: { phase: "incomplete", messages, reason: "stale_limit" }, approvals: owner.state.approvals });
        }
        return;
      }
      finishHistory(owner, generation);
      const timeout = (error as { name?: unknown } | null)?.name === "TimeoutError";
      publish(owner, generation, { ...owner.state, history: { phase: "incomplete", messages, reason: timeout ? "timeout" : "rpc_error" } });
    } finally {
      if (owner.controller === controller) owner.controller = undefined;
    }
  };
  const supersede = (owner: Owner, historyRetry = false) => {
    cancel(owner);
    owner.generation++;
    owner.suspended = false;
    if (historyRetry) owner.state = { ...owner.state, history: { phase: "loading", messages: 0 } };
    void startJoin(owner, true);
  };
  const openSessionReplay = async (session: string, options: { signal?: AbortSignal } = {}): Promise<SessionReplayLease> => {
    const owner = acquire(session, "sequenced");
    owner.navigationSignal = options.signal;
    owner.leases++;
    transferSlot(owner);
    const generation = owner.generation;
    await startJoin(owner, owner.store !== undefined);
    if (!owner.store) {
      owner.store = deps.makeStore(session);
      deps.commitStore(session, owner.store);
    }
    let released = false;
    return {
      get store() { return owner.store ?? deps.makeStore(session); },
      get state() { return owner.state; },
      subscribeReplay(listener) { owner.listeners.add(listener); return () => owner.listeners.delete(listener); },
      retry() { if (!released && active(owner, owner.generation)) supersede(owner); },
      retryHistory() { if (!released && active(owner, owner.generation)) supersede(owner, true); },
      suspend() { if (!released) suspend(owner); },
      release() {
        if (released) return;
        released = true;
        owner.leases--;
        if (owner.generation === generation || owner.leases === 0) releaseOwner(owner);
      },
    };
  };
  const route = (params: EventParams) => {
    const session = typeof params.session_id === "string" ? params.session_id : undefined;
    if (!session) return false;
    const owner = owners.get(session);
    if (!owner || owner.mode !== "sequenced") return false;
    if (params.event === "replay_stream_ended") {
      if (typeof params.stream_id === "string" && params.stream_id === owner.streamId && activeSequencedOwner === owner && !owner.joining)
        supersede(owner);
      return true;
    }
    if (owner.joining) {
      owner.buffer.push(params);
      return true;
    }
    if (activeSequencedOwner !== owner || owner.suspended || !owner.streamId) return true;
    if (typeof params.stream_id !== "string" || !safeInteger(params.seq, 1)) {
      supersede(owner);
      return true;
    }
    if (params.stream_id !== owner.streamId || params.seq <= owner.lastSeq) return true;
    if (params.seq !== owner.lastSeq + 1) {
      supersede(owner);
      return true;
    }
    const events = deps.adaptEvent(params).map((event) => deps.stampEvent(event, session));
    if (events.some((event) => event.type === "error" && event.error.code === "adapter_invalid_frame")) {
      supersede(owner);
      return true;
    }
    let dispatched = true;
    for (const event of events) {
      if (event.type === "approval_request") {
        if (owner.retainedApprovalEnds.has(event.request_id)) {
          violation(`approval request ${event.request_id} arrived after its retained end`);
          continue;
        }
        owner.openApprovals.add(event.request_id);
      }
      if (event.type === "approval_end") {
        if (!owner.openApprovals.has(event.request_id)) {
          if (deps.role() === "controller") violation(`approval end ${event.request_id} has no request`);
          continue;
        }
        owner.openApprovals.delete(event.request_id);
      }
      call(() => { try { owner.store?.dispatch(event); } catch (error) { dispatched = false; throw error; } });
    }
    if (!dispatched) {
      supersede(owner);
      return true;
    }
    owner.lastSeq = params.seq;
    publish(owner, owner.generation, { ...owner.state, replay: { phase: "joined", streamId: owner.streamId, lastSeq: owner.lastSeq } });
    return true;
  };

  return {
    owners,
    openSessionReplay,
    route,
    acquireLegacy(session: string) { const owner = acquire(session, "legacy"); owner.leases++; return owner.generation; },
    releaseLegacy(session: string, generation: number) {
      const owner = owners.get(session);
      if (owner?.mode !== "legacy") return;
      owner.leases = Math.max(0, owner.leases - 1);
      if (owner.generation === generation || owner.leases === 0) releaseOwner(owner);
    },
    mode(session: string) { return owners.get(session)?.mode; },
    generation(session: string) { return owners.get(session)?.generation; },
    retrySession(session: string) {
      const owner = owners.get(session);
      if (owner?.mode === "sequenced") return supersede(owner), true;
      return false;
    },
    prepareEvict(session: string) {
      const owner = owners.get(session);
      if (!owner) return true;
      if (owner.mode === "sequenced") return false;
      cancel(owner);
      owner.released = true;
      owners.delete(session);
      return true;
    },
    close() {
      closed = true;
      for (const owner of owners.values()) cancel(owner), owner.listeners.clear();
      owners.clear();
      activeSequencedOwner = undefined;
    },
  };
}
