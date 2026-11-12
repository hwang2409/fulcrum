import { createRunStore } from "@fulcrum/core";
import { fromZetaHistory } from "./adapter.js";
import { BackwardHistoryError, openBackwardHistory, type BackwardHistoryCursor } from "./backward-history.js";
import type { RequestOptions, SessionLease, ZetaClient } from "./client.js";
import { call } from "./host.js";
import { record } from "./validation.js";

export const CHILD_RUNS_FEATURE = "child_runs" as const;
export const CHILD_RUN_HISTORY_FEATURE = "child_run_history" as const;

export type KnownChildRunStatus = "running" | "idle" | "finishing" | "completed" | "failed" | "canceled";
export type ChildRunStatus =
  | { readonly kind: "known"; readonly value: KnownChildRunStatus }
  | { readonly kind: "unknown"; readonly value: string };

export type ChildRunKey = {
  readonly sessionId: string;
  readonly runId: string;
};

export type ChildRunHistoryErrorKind =
  | "not_negotiated"
  | "invalid_request"
  | "owner_not_active"
  | "not_found"
  | "corrupt_transcript"
  | "history_kept_changing";

export class ChildRunHistoryError extends Error {
  readonly name = "ChildRunHistoryError";
  constructor(readonly kind: ChildRunHistoryErrorKind, message: string, readonly cause?: unknown) {
    super(message);
  }
}

export type ChildRunHistoryProgress = {
  readonly messages: number;
  readonly complete: boolean;
  readonly restart: number;
};
export type OpenChildRunOptions = {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ChildRunHistoryProgress) => void;
};
export type OpenChildRunResult = {
  readonly lease: SessionLease;
  readonly complete: Promise<void>;
};

export type ChildRunRow = {
  readonly runId: string;
  readonly sessionId: string;
  readonly parentRunId: string | null;
  readonly description: string;
  readonly agentType: string;
  readonly status: ChildRunStatus;
  readonly acceptsFollowUps: boolean;
  readonly turnsUsed: number;
  readonly toolCount: number;
  readonly currentStep: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly elapsedSeconds: number;
};

export type ChildRunsUnavailable = {
  readonly kind: "unavailable";
  readonly feature: typeof CHILD_RUNS_FEATURE;
};

export type ChildRunsMalformed = { readonly kind: "malformed" };
export type ChildRunPage = {
  readonly kind: "page";
  readonly runs: readonly ChildRunRow[];
  readonly nextOffset?: number;
  readonly invalidRows: number;
};
export type ChildRunListResult = ChildRunPage | ChildRunsMalformed | ChildRunsUnavailable;
export type ChildRunSendResult =
  | { readonly kind: "accepted"; readonly runId: string }
  | ChildRunsMalformed
  | ChildRunsUnavailable;

export interface ChildRunClient {
  readonly features: readonly string[];
  request(method: string, params?: Record<string, unknown>, options?: RequestOptions): Promise<unknown>;
}

export type ListChildRunsOptions = RequestOptions & {
  readonly offset?: number;
  readonly limit?: number;
};

const knownStatuses = new Set<KnownChildRunStatus>(["running", "idle", "finishing", "completed", "failed", "canceled"]);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const duration = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function parseStatus(value: unknown): ChildRunStatus | null {
  if (!nonempty(value)) return null;
  return knownStatuses.has(value as KnownChildRunStatus)
    ? { kind: "known", value: value as KnownChildRunStatus }
    : { kind: "unknown", value };
}

function parseRow(value: unknown): ChildRunRow | null {
  const row = record(value);
  const status = parseStatus(row?.status);
  if (!row || !nonempty(row.run_id) || !nonempty(row.session_id) ||
      row.parent_run_id !== null && !nonempty(row.parent_run_id) ||
      typeof row.description !== "string" || typeof row.agent_type !== "string" || !status ||
      typeof row.accepts_follow_ups !== "boolean" || !count(row.turns_used) || !count(row.tool_count) ||
      typeof row.current_step !== "string" || typeof row.started_at !== "string" ||
      row.finished_at !== undefined && row.finished_at !== null && typeof row.finished_at !== "string" ||
      !duration(row.elapsed_seconds)) return null;
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    parentRunId: row.parent_run_id,
    description: row.description,
    agentType: row.agent_type,
    status,
    acceptsFollowUps: row.accepts_follow_ups,
    turnsUsed: row.turns_used,
    toolCount: row.tool_count,
    currentStep: row.current_step,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    elapsedSeconds: row.elapsed_seconds,
  };
}

function parseList(value: unknown, offset: number): ChildRunListResult {
  const envelope = record(value);
  if (!envelope || !Array.isArray(envelope.runs)) return { kind: "malformed" };
  const nextOffset = envelope.next_offset;
  if (nextOffset !== undefined && (!Number.isSafeInteger(nextOffset) || (nextOffset as number) <= offset)) return { kind: "malformed" };
  const runs: ChildRunRow[] = [];
  for (const value of envelope.runs) {
    const row = parseRow(value);
    if (row) runs.push(row);
  }
  return {
    kind: "page",
    runs,
    ...(nextOffset === undefined ? {} : { nextOffset: nextOffset as number }),
    invalidRows: envelope.runs.length - runs.length,
  };
}

const unavailable = (): ChildRunsUnavailable => ({ kind: "unavailable", feature: CHILD_RUNS_FEATURE });
const negotiated = (client: ChildRunClient) => client.features.includes(CHILD_RUNS_FEATURE);

/** Lists one validated child-run page. Paging and refresh policy remain with the caller. */
export function listChildRuns(
  client: ChildRunClient,
  sessionId: string,
  options?: ListChildRunsOptions,
): Promise<ChildRunListResult> {
  if (!negotiated(client)) return Promise.resolve(unavailable());
  const { offset = 0, limit, ...requestOptions } = options ?? {};
  if (!nonempty(sessionId) || !count(offset) || limit !== undefined && (!count(limit) || limit < 1 || limit > 100)) {
    return Promise.resolve({ kind: "malformed" });
  }
  return client.request("child_run_list", {
    session_id: sessionId,
    ...(options?.offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
  }, requestOptions).then((value) => parseList(value, offset));
}

/** Queues one child follow-up. It never retries because each request represents one user action. */
export function sendChildRun(
  client: ChildRunClient,
  key: ChildRunKey,
  text: string,
  options?: RequestOptions,
): Promise<ChildRunSendResult> {
  if (!negotiated(client)) return Promise.resolve(unavailable());
  if (!nonempty(key.sessionId) || !nonempty(key.runId) || !nonempty(text)) return Promise.resolve({ kind: "malformed" });
  return client.request("child_run_send", {
    session_id: key.sessionId,
    run_id: key.runId,
    text,
  }, options).then((value) => {
    const result = record(value);
    return result?.accepted === true && result.run_id === key.runId
      ? { kind: "accepted", runId: key.runId }
      : { kind: "malformed" };
  });
}

type ChildHistoryEntry = {
  readonly store: ReturnType<typeof createRunStore>;
  readonly controller: AbortController;
  readonly progress: Set<(progress: ChildRunHistoryProgress) => void>;
  holders: number;
  opening: Promise<Omit<OpenChildRunResult, "lease">>;
};
const childHistory = new WeakMap<ZetaClient, Map<string, Map<string, ChildHistoryEntry>>>();

const historyError = (kind: ChildRunHistoryErrorKind, message: string, cause?: unknown) =>
  new ChildRunHistoryError(kind, message, cause);
const mappedHistoryError = (error: unknown): never => {
  if (error instanceof ChildRunHistoryError || (error as { name?: unknown }).name === "AbortError") throw error;
  if (error instanceof BackwardHistoryError && error.kind === "history_kept_changing")
    throw historyError("history_kept_changing", "history kept changing; retry", error.cause ?? error);
  const rpc = error as { code?: unknown; data?: { code?: unknown } } | null;
  if (rpc?.code === -32601) throw historyError("not_negotiated", "child run history was not negotiated", error);
  if (rpc?.code === -32602) throw historyError("invalid_request", "child run history request was invalid", error);
  if (rpc?.code === -32003) throw historyError("owner_not_active", "child run owner is not active", error);
  if (rpc?.code === -32012 && rpc.data?.code === "child_run_not_found")
    throw historyError("not_found", "child run was not found", error);
  if (rpc?.code === -32000 && rpc.data?.code === "corrupt_transcript")
    throw historyError("corrupt_transcript", "child run transcript is corrupt", error);
  throw error;
};
const abortReason = (signal: AbortSignal) => signal.reason ?? Object.assign(new Error("request aborted"), { name: "AbortError" });

export function childRunHistoryUnavailable(client: ZetaClient): string | undefined {
  return client.features.includes(CHILD_RUN_HISTORY_FEATURE) ? undefined : "child run history is unavailable";
}

function entryMap(client: ZetaClient, sessionId: string) {
  let owners = childHistory.get(client);
  if (!owners) childHistory.set(client, owners = new Map());
  let runs = owners.get(sessionId);
  if (!runs) owners.set(sessionId, runs = new Map());
  return runs;
}

function deleteChildHistoryEntry(
  client: ZetaClient,
  key: ChildRunKey,
  entry: ChildHistoryEntry,
  runs: Map<string, ChildHistoryEntry>,
) {
  if (runs.get(key.runId) !== entry) return;
  runs.delete(key.runId);
  if (runs.size > 0) return;
  const owners = childHistory.get(client);
  owners?.delete(key.sessionId);
  if (owners?.size === 0) childHistory.delete(client);
}

function createChildHistoryEntry(
  client: ZetaClient,
  key: ChildRunKey,
  runs: Map<string, ChildHistoryEntry>,
): ChildHistoryEntry {
  const store = createRunStore();
  const controller = new AbortController();
  const entry: ChildHistoryEntry = { store, controller, progress: new Set(), holders: 0, opening: undefined as never };
  store.beginHistory();
  entry.opening = (async () => {
    const request = async (cursor: BackwardHistoryCursor, signal: AbortSignal) => {
      try {
        return await client.request("child_run_history", {
          session_id: key.sessionId,
          run_id: key.runId,
          before: cursor.before,
          ...(cursor.historyValidator ? { history_validator: cursor.historyValidator } : {}),
        }, { signal });
      } catch (error) {
        return mappedHistoryError(error);
      }
    };
    try {
      const opened = await openBackwardHistory(request, {
        signal: controller.signal,
        onSnapshot(snapshot) {
          const events = fromZetaHistory(snapshot.cause === "older" ? snapshot.pageRows : snapshot.rows);
          if (snapshot.cause === "older") store.prepend(events);
          else store.resync(events);
          const progress = { messages: snapshot.rows.length, complete: snapshot.complete, restart: snapshot.restart };
          for (const listener of entry.progress) call(() => listener(progress));
        },
      });
      const complete = opened.complete.then(() => undefined, mappedHistoryError).finally(() => store.endHistory());
      return { complete };
    } catch (error) {
      store.endHistory();
      return mappedHistoryError(error);
    }
  })();
  entry.opening.catch(() => {
    if (entry.holders === 0 && runs.get(key.runId) === entry) {
      deleteChildHistoryEntry(client, key, entry, runs);
      store.dispose();
    }
  });
  return entry;
}

/** Opens one durable child transcript. The resolved lease is shared until its final holder releases it. */
export async function openChildRun(
  client: ZetaClient,
  key: ChildRunKey,
  options: OpenChildRunOptions = {},
): Promise<OpenChildRunResult> {
  if (childRunHistoryUnavailable(client)) throw historyError("not_negotiated", "child run history was not negotiated");
  if (!nonempty(key.sessionId) || !nonempty(key.runId)) throw historyError("invalid_request", "child run identity is invalid");
  if (options.signal?.aborted) throw abortReason(options.signal);

  const runs = entryMap(client, key.sessionId);
  const entry = runs.get(key.runId) ?? createChildHistoryEntry(client, key, runs);
  runs.set(key.runId, entry);
  const progress = options.onProgress ? (value: ChildRunHistoryProgress) => options.onProgress!(value) : undefined;
  if (progress) entry.progress.add(progress);
  entry.holders++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (progress) entry.progress.delete(progress);
    entry.holders--;
    if (entry.holders !== 0 || runs.get(key.runId) !== entry) return;
    deleteChildHistoryEntry(client, key, entry, runs);
    entry.controller.abort();
    entry.store.dispose();
  };
  let onAbort: (() => void) | undefined;
  try {
    const opened = options.signal ? await Promise.race([
      entry.opening,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(abortReason(options.signal!));
        options.signal!.addEventListener("abort", onAbort, { once: true });
      }),
    ]) : await entry.opening;
    return { lease: { store: entry.store, release }, complete: opened.complete };
  } catch (error) {
    release();
    throw error;
  } finally {
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
  }
}
