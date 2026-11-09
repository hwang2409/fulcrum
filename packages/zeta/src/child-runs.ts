import type { RequestOptions } from "./client.js";

export const CHILD_RUNS_FEATURE = "child_runs" as const;

export type KnownChildRunStatus = "running" | "idle" | "finishing" | "completed" | "failed" | "canceled";
export type ChildRunStatus =
  | { readonly kind: "known"; readonly value: KnownChildRunStatus }
  | { readonly kind: "unknown"; readonly value: string };

export type ChildRunKey = {
  readonly sessionId: string;
  readonly runId: string;
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
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
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
  const row = object(value);
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
  const envelope = object(value);
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
    const result = object(value);
    return result?.accepted === true && result.run_id === key.runId
      ? { kind: "accepted", runId: key.runId }
      : { kind: "malformed" };
  });
}
