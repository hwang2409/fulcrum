import type { RunEvent } from "@fulcrum/core";
import { servedTurnOutcome } from "./adapter.js";
import { backfillBackwardHistory, type BackwardHistoryPage } from "./backward-history.js";
import type { SessionLease, SessionStore } from "./client.js";
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
  readonly approvals: { readonly incomplete: "server_truncated" | null };
};
export interface SessionReplayLease extends SessionLease {
  readonly state: SessionReplayState;
  subscribeReplay(listener: () => void): () => void;
  retry(): void;
  retryHistory(): void;
  suspend(): void;
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

type Request = (method: string, params: Record<string, unknown>, options: { signal: AbortSignal; timeoutMs: number }) => Promise<unknown>;
type Load = (signal: AbortSignal) => Promise<RunEvent[]>;
type Recovery = { canceled: boolean; controller?: AbortController; timer?: ReturnType<typeof setTimeout>; wake?: () => void };
/** One legacy generation: its loader, its quarantine, and its pending load or recovery. */
type Legacy = { readonly load: Load; quarantined: boolean; revision: number; loadController?: AbortController; recovery?: Recovery };
type Owner = {
  readonly session: string;
  readonly mode: ReplayMode;
  generation: number;
  leases: number;
  store?: SessionStore;
  legacy?: Legacy;
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
  navigationCleanup?: () => void;
};

// Join retries and legacy store recovery share one schedule: 15.5 s of waiting over six attempts.
const RETRY_DELAYS = [0, 500, 1_000, 2_000, 4_000, 8_000] as const;
const STALE_CYCLES = 3;
const PAGE_TIMEOUT_MS = 15_000;
const JOIN_FAILED = { phase: "failed", message: "could not join live updates", retryable: true } as const;
const rpcCode = (error: unknown, code: string) => {
  const rpc = error as { code?: unknown; data?: { code?: unknown } } | null;
  return rpc?.code === -32009 && rpc.data?.code === code;
};
const abortError = () => Object.assign(new Error("request aborted"), { name: "AbortError" });
const isAbort = (error: unknown) => (error as { name?: unknown } | null)?.name === "AbortError";
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
// The joined page's newest served_turn_end names the idle snapshot's outcome, when it ends the turn this client last saw.
const newestServedTurn = (rows: readonly unknown[]) => {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index] as { event?: unknown; data?: { turn_id?: unknown } } | null;
    if (row?.event === "served_turn_end") return typeof row.data?.turn_id === "string" ? row.data.turn_id : undefined;
  }
};
const statusEvent = (status: JoinStatus, rows: readonly unknown[], knownTurn: string | undefined): RunEvent => {
  if (status.state !== "idle") return { type: "run_start" };
  const turn = knownTurn ?? newestServedTurn(rows);
  const outcome = turn === undefined ? undefined : servedTurnOutcome(rows, turn);
  return outcome ? { type: "run_end", outcome } : { type: "run_end" };
};
type ApprovalRequestEvent = Extract<RunEvent, { type: "approval_request" }>;
const baselineApproval = (approval: JoinStatus["pending_approvals"][number]): ApprovalRequestEvent => ({
  type: "approval_request", request_id: approval.request_id, tool_call: approval.tool_call, delegated: approval.delegated,
  ...(approval.resolution_pending ? { state: "resolving" as const } : {}),
});

/**
 * The one replay authority per session. Legacy `replay` and sequenced `openSessionReplay` acquire the same owner, so
 * only one mode and one generation can write a session's replay store; every async step checks its generation.
 */
export function createReplayRegistry(deps: {
  readonly request: Request;
  readonly makeStore: (session: string) => SessionStore;
  /** Makes `store` the session's cached store with `holders` view holders. */
  readonly commitStore: (session: string, store: SessionStore, holders: number) => void;
  readonly releaseHolder: (session: string, store: SessionStore) => void;
  readonly evictStore: (session: string) => void;
  readonly servedTurn: (session: string) => string | undefined;
  readonly adaptHistory: (rows: readonly unknown[]) => RunEvent[];
  readonly adaptEvent: (params: EventParams) => RunEvent[];
  readonly stampEvent: (event: RunEvent, session: string) => RunEvent;
  readonly protocolViolation: (message: string) => void;
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
  const cancelRecovery = (legacy: Legacy) => {
    const recovery = legacy.recovery;
    if (!recovery) return;
    recovery.canceled = true;
    recovery.controller?.abort();
    if (recovery.timer) clearTimeout(recovery.timer);
    recovery.wake?.();
    legacy.recovery = undefined;
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
    if (owner.legacy) {
      owner.legacy.loadController?.abort();
      owner.legacy.loadController = undefined;
      cancelRecovery(owner.legacy);
    }
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
  const detach = (owner: Owner) => {
    cancel(owner);
    owner.navigationCleanup?.();
    owner.navigationCleanup = undefined;
    owner.released = true;
    owners.delete(owner.session);
    if (activeSequencedOwner === owner) activeSequencedOwner = undefined;
  };
  /** Drops one lease; the last one releases the owner unless another owner has replaced it. */
  const releaseLease = (owner: Owner) => {
    owner.leases = Math.max(0, owner.leases - 1);
    if (owner.leases === 0 && owners.get(owner.session) === owner) detach(owner);
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
  const violation = (message: string) => call(() => deps.protocolViolation(message));

  // Legacy mode: `replay`, `replayRevision`, `finishReplay`, and store recovery for one generation.
  const replayLegacy = async (session: string, load: Load, keepQuarantined = false): Promise<SessionLease> => {
    if (!owners.has(session)) deps.evictStore(session);
    const owner = acquire(session, "legacy");
    owner.leases++;
    const generation = owner.generation;
    const controller = new AbortController();
    const legacy: Legacy = { load, quarantined: true, revision: 0, loadController: controller };
    owner.legacy = legacy;
    try {
      const history = await load(controller.signal); // host code: outside; README row "load(signal)"
      if (controller.signal.aborted || !active(owner, generation)) throw abortError();
      const store = deps.makeStore(session);
      owner.store = store;
      deps.commitStore(session, store, 1);
      let released = false;
      const lease = { store, release() {
        if (released) return;
        released = true;
        deps.releaseHolder(session, store);
        releaseLease(owner);
      } };
      for (const event of history) call(() => store.dispatch(event));
      if (!keepQuarantined) endQuarantine(legacy);
      return lease;
    } catch (error) {
      if (owner.legacy === legacy) owner.legacy = undefined;
      releaseLease(owner);
      throw error;
    }
  };
  const endQuarantine = (legacy: Legacy) => {
    legacy.quarantined = false;
    legacy.revision = 0;
    legacy.loadController = undefined;
  };
  const legacyOf = (session: string) => {
    const owner = owners.get(session);
    return owner?.mode === "legacy" ? owner.legacy : undefined;
  };
  const waitForRecovery = (recovery: Recovery, delay: number) => new Promise<void>((resolve) => {
    recovery.wake = resolve;
    recovery.timer = setTimeout(resolve, delay);
  });
  const recoverLegacy = async (owner: Owner, legacy: Legacy, target: SessionStore) => {
    cancelRecovery(legacy);
    const recovery: Recovery = { canceled: false };
    legacy.recovery = recovery;
    legacy.quarantined = true;
    let failure: unknown;
    try {
      for (const delay of RETRY_DELAYS) {
        if (delay) {
          await waitForRecovery(recovery, delay);
          recovery.wake = undefined;
          recovery.timer = undefined;
        }
        if (recovery.canceled) return;
        try {
          const controller = new AbortController();
          recovery.controller = controller;
          // A throw, or a value that cannot be iterated, is a load failure here, not a listener error.
          const history = [...await legacy.load(controller.signal)]; // host code: outside; README row "load(signal)"
          recovery.controller = undefined;
          if (recovery.canceled || owner.store !== target) return;
          call(() => target.resync(history));
          legacy.quarantined = false;
          return;
        } catch (error) {
          if (recovery.canceled) return;
          recovery.controller = undefined;
          failure = error;
        }
      }
      if (owner.store === target) call(() => target.resyncFailed(failure));
      throw failure;
    } finally {
      recovery.controller?.abort();
      if (legacy.recovery === recovery) legacy.recovery = undefined;
    }
  };

  // Sequenced mode.
  const reconcilePage = (owner: Owner, rows: readonly unknown[]) => {
    const output: RunEvent[] = [];
    for (const event of deps.adaptHistory(rows)) {
      output.push(event);
      const retained = event.type === "approval_request" ? owner.retainedApprovalEnds.get(event.request_id) : undefined;
      if (event.type !== "approval_request" || !retained) continue;
      output.push(retained);
      owner.retainedApprovalEnds.delete(event.request_id);
    }
    return output;
  };
  const joinedEvents = (owner: Owner, result: SessionReplayJoinResult) => {
    const pageEvents = deps.adaptHistory(result.messages);
    const delivered = new Set(pageEvents.flatMap((event) => event.type === "user_message" && event.delivery_id ? [event.delivery_id] : []));
    const store = owner.store;
    const optimistic = store?.getOutline().flatMap(({ id }) => {
      const item = store.getItem(id);
      const event = item?.type === "user" ? item.event : undefined;
      return event?.type === "user_message" && event.intent && event.delivery_id && !delivered.has(event.delivery_id) ? [event] : [];
    }) ?? [];
    const baseline = result.status.pending_approvals.map(baselineApproval);
    const available = new Set(baseline.map((event) => event.request_id));
    const ended = new Set(pageEvents.flatMap((event) => event.type === "approval_end" ? [event.request_id] : []));
    const output: RunEvent[] = [statusEvent(result.status, result.messages, deps.servedTurn(owner.session)), ...baseline];
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
  /** Installs a validated join: newest history, status baseline, and stream frontier in one store commit. */
  const commitJoin = (owner: Owner, generation: number, result: SessionReplayJoinResult, staleCycles: number) => {
    owner.streamId = result.replay.stream_id;
    owner.lastSeq = result.replay.history_seq;
    const candidate = deps.makeStore(owner.session);
    call(() => candidate.beginHistory());
    call(() => candidate.resync(joinedEvents(owner, result)));
    owner.store = candidate;
    deps.commitStore(owner.session, candidate, 0);
    const truncated = result.status.pending_approvals_truncated;
    if (truncated) violation("replay join reported truncated pending approvals");
    owner.joining = false;
    const messages = result.messages.length;
    publish(owner, generation, {
      replay: { phase: "joined", streamId: owner.streamId, lastSeq: owner.lastSeq },
      history: result.next_before === null ? { phase: "complete", messages } : { phase: "loading", messages },
      approvals: { incomplete: truncated ? "server_truncated" : null },
    });
    for (const frame of owner.buffer.splice(0)) route(frame);
    if (!active(owner, generation)) return;
    if (result.next_before === null) return finishHistory(owner, generation);
    void backfill(owner, generation, { messages: result.messages, nextBefore: result.next_before, validator: result.history_validator }, staleCycles);
  };
  const startJoin = async (owner: Owner, rejoining: boolean, staleCycles = 0): Promise<void> => {
    const generation = owner.generation;
    const current = () => active(owner, generation) && !owner.suspended && activeSequencedOwner === owner;
    transferSlot(owner);
    owner.joining = true;
    owner.streamId = undefined;
    for (let index = 0; index < RETRY_DELAYS.length; index++) {
      if (!current()) return;
      await wait(owner, generation, RETRY_DELAYS[index]!);
      if (!current()) return;
      publish(owner, generation, { ...owner.state, replay: { phase: rejoining ? "rejoining" : "joining", attempt: index + 1 } });
      const controller = new AbortController();
      owner.controller = controller;
      const navigation = owner.navigationSignal;
      const abort = () => controller.abort();
      navigation?.addEventListener("abort", abort, { once: true });
      try {
        const result = parseJoin(await deps.request("session_history_and_subscribe", { session_id: owner.session }, { signal: controller.signal, timeoutMs: PAGE_TIMEOUT_MS }));
        if (!current() || controller.signal.aborted) return;
        owner.controller = undefined;
        return commitJoin(owner, generation, result, staleCycles);
      } catch (error) {
        if (owner.controller === controller) owner.controller = undefined;
        if (!active(owner, generation) || controller.signal.aborted || isAbort(error)) return;
        if (rpcCode(error, "stale_event_sequence") && index + 1 < RETRY_DELAYS.length) continue;
        owner.joining = false;
        owner.buffer = [];
        publish(owner, generation, { ...owner.state, replay: JOIN_FAILED });
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
      await backfillBackwardHistory(joinPage, (cursor, signal) => deps.request("session_history", {
        session_id: owner.session,
        before: cursor.before,
        history_validator: cursor.historyValidator,
      }, { signal, timeoutMs: PAGE_TIMEOUT_MS }), {
        signal: controller.signal,
        onPage(page) {
          if (!active(owner, generation) || activeSequencedOwner !== owner) return;
          const events = reconcilePage(owner, page.messages);
          call(() => owner.store?.prepend(events));
          messages += page.messages.length;
          publish(owner, generation, { ...owner.state, history: page.nextBefore === null ? { phase: "complete", messages } : { phase: "loading", messages } });
        },
      });
      finishHistory(owner, generation);
    } catch (error) {
      if (!active(owner, generation) || controller.signal.aborted || isAbort(error)) return;
      if (rpcCode(error, "stale_history_snapshot")) {
        if (staleCycles < STALE_CYCLES) return supersede(owner, staleCycles + 1);
        // The stale budget is spent: retire the stream so state and routing agree that live updates stopped.
        finishHistory(owner, generation);
        cancel(owner);
        publish(owner, generation, { replay: JOIN_FAILED, history: { phase: "incomplete", messages, reason: "stale_limit" }, approvals: owner.state.approvals });
        return;
      }
      finishHistory(owner, generation);
      const timeout = (error as { name?: unknown } | null)?.name === "TimeoutError";
      publish(owner, generation, { ...owner.state, history: { phase: "incomplete", messages, reason: timeout ? "timeout" : "rpc_error" } });
    } finally {
      if (owner.controller === controller) owner.controller = undefined;
    }
  };
  /** Starts a fresh atomic join in a new generation of the same owner; the committed store stays readable. */
  const supersede = (owner: Owner, staleCycles = 0, historyRetry = false) => {
    cancel(owner);
    owner.generation++;
    owner.suspended = false;
    if (historyRetry) owner.state = { ...owner.state, history: { phase: "loading", messages: 0 } };
    void startJoin(owner, true, staleCycles);
  };
  const openSessionReplay = async (session: string, options: { signal?: AbortSignal } = {}): Promise<SessionReplayLease> => {
    if (options.signal?.aborted) throw abortError();
    const owner = acquire(session, "sequenced");
    owner.navigationCleanup?.();
    owner.navigationSignal = options.signal;
    if (options.signal) {
      const onAbort = () => { if (owners.get(session) === owner) suspend(owner); };
      options.signal.addEventListener("abort", onAbort, { once: true });
      owner.navigationCleanup = () => options.signal?.removeEventListener("abort", onAbort);
    }
    owner.leases++;
    await startJoin(owner, owner.store !== undefined);
    if (!owner.store) {
      owner.store = deps.makeStore(session);
      deps.commitStore(session, owner.store, 0);
    }
    let released = false;
    const live = () => !released && active(owner, owner.generation);
    return {
      get store() { return owner.store!; },
      get state() { return owner.state; },
      subscribeReplay(listener) { owner.listeners.add(listener); return () => owner.listeners.delete(listener); },
      retry() { if (live()) supersede(owner); },
      retryHistory() { if (live()) supersede(owner, 0, true); },
      suspend() { if (live()) suspend(owner); },
      release() {
        if (released) return;
        released = true;
        releaseLease(owner);
      },
    };
  };
  /** Drops tail approval events the owner already knows are closed, and records the rest. */
  const filterTailApprovals = (owner: Owner, events: readonly RunEvent[]) => events.filter((event) => {
    if (event.type === "approval_request") {
      if (owner.retainedApprovalEnds.has(event.request_id)) {
        violation(`approval request ${event.request_id} arrived after its retained end`);
        return false;
      }
      owner.openApprovals.add(event.request_id);
    }
    // Valid for either role: after a zeta restart a durable approval can be missing from the join baseline.
    if (event.type === "approval_end") return owner.openApprovals.delete(event.request_id);
    return true;
  });
  const routeSequenced = (owner: Owner, params: EventParams) => {
    // One join at a time: every frame, a stream end too, waits for the join in flight and then meets its stream id.
    if (owner.joining) return void owner.buffer.push(params);
    const streamId = owner.streamId;
    if (activeSequencedOwner !== owner || owner.suspended || streamId === undefined) return;
    if (params.event === "replay_stream_ended") {
      if (params.stream_id === streamId) supersede(owner);
      return;
    }
    if (typeof params.stream_id !== "string" || !safeInteger(params.seq, 1)) return supersede(owner);
    if (params.stream_id !== streamId || params.seq <= owner.lastSeq) return;
    if (params.seq !== owner.lastSeq + 1) return supersede(owner);
    const events = deps.adaptEvent(params).map((event) => deps.stampEvent(event, owner.session));
    if (events.some((event) => event.type === "error" && event.error.code === "adapter_invalid_frame")) return supersede(owner);
    const generation = owner.generation;
    let dispatched = true;
    for (const event of filterTailApprovals(owner, events))
      call(() => { try { owner.store?.dispatch(event); } catch (error) { dispatched = false; throw error; } });
    // A store failure can already have started a new generation through its recovery hook.
    if (!active(owner, generation) || owner.streamId !== streamId) return;
    if (!dispatched) return supersede(owner);
    owner.lastSeq = params.seq;
    publish(owner, generation, { ...owner.state, replay: { phase: "joined", streamId, lastSeq: owner.lastSeq } });
  };
  /** Takes an owned session's frame. Returns false when the frame should use ordinary routing. */
  const route = (params: EventParams) => {
    const owner = typeof params.session_id === "string" ? owners.get(params.session_id) : undefined;
    if (!owner) return false;
    if (owner.mode === "sequenced") {
      routeSequenced(owner, params);
      return true;
    }
    if (!owner.legacy?.quarantined) return false;
    owner.legacy.revision++;
    return true;
  };

  return {
    openSessionReplay,
    route,
    replay: replayLegacy,
    replayRevision: (session: string) => legacyOf(session)?.revision ?? 0,
    /** Opens live routing only if no event arrived after `revision` was captured. */
    finishReplay(session: string, revision: number) {
      const legacy = legacyOf(session);
      if (!legacy?.quarantined || legacy.revision !== revision) return false;
      endQuarantine(legacy);
      return true;
    },
    owned: (session: string) => owners.has(session),
    /** Recovers the owner of `store` by mode. Returns undefined when no owner holds that store. */
    recover(session: string, store?: SessionStore): Promise<void> | undefined {
      const owner = owners.get(session);
      if (!owner?.store || (store && owner.store !== store)) return undefined;
      if (owner.mode === "sequenced") return void supersede(owner), Promise.resolve();
      return owner.legacy ? recoverLegacy(owner, owner.legacy, owner.store) : undefined;
    },
    prepareEvict(session: string) {
      const owner = owners.get(session);
      if (!owner) return true;
      if (owner.mode === "sequenced") return false;
      detach(owner);
      return true;
    },
    close() {
      closed = true;
      for (const owner of owners.values()) cancel(owner), owner.navigationCleanup?.(), owner.listeners.clear();
      owners.clear();
      activeSequencedOwner = undefined;
    },
  };
}
