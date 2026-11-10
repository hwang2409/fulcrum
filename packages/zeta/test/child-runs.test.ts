import { expect, test } from "bun:test";
import {
  CHILD_RUNS_FEATURE,
  listChildRuns,
  sendChildRun,
  type ChildRunClient,
  type ZetaClient,
} from "../src/index.js";

// Zeta docs/serve-protocol.md:748-767 and src/zeta/core/child_runs.py:352-383 define this row and both replies.
const row = {
  run_id: "child-1",
  session_id: "owner-1",
  parent_run_id: null,
  description: "inspect the change",
  agent_type: "reviewer",
  status: "running",
  accepts_follow_ups: true,
  turns_used: 2,
  tool_count: 7,
  current_step: "reading tests",
  started_at: "2026-11-09T00:00:00Z",
  finished_at: null,
  elapsed_seconds: 12.5,
};

const clientFor = (reply: unknown, features: readonly string[] = [CHILD_RUNS_FEATURE]) => {
  const calls: Array<[string, Record<string, unknown>, unknown]> = [];
  const client: ChildRunClient = {
    features,
    request(method, params, options) {
      calls.push([method, params ?? {}, options]);
      return Promise.resolve(reply);
    },
  };
  return { client, calls };
};

// Zeta docs/serve-protocol.md:753-760 defines the row fields; status values come from src/zeta/agent/types.py.
test("maps child rows and preserves known and additive statuses", async () => {
  const statuses = ["running", "idle", "finishing", "completed", "failed", "canceled"] as const;
  for (const status of statuses) {
    const { client } = clientFor({ runs: [{ ...row, status }] });
    const result = await listChildRuns(client, "owner-1");
    expect(result).toMatchObject({ kind: "page", invalidRows: 0, runs: [{ status: { kind: "known", value: status } }] });
  }

  const { client } = clientFor({ runs: [{ ...row, status: "paused" }] });
  await expect(listChildRuns(client, "owner-1")).resolves.toMatchObject({
    kind: "page",
    invalidRows: 0,
    runs: [{ runId: "child-1", sessionId: "owner-1", status: { kind: "unknown", value: "paused" } }],
  });
});

test("normalizes optional finished_at and maps each wire field once", async () => {
  for (const finished of [undefined, null, "2026-11-09T00:01:00Z"] as const) {
    const wire = { ...row, finished_at: finished };
    if (finished === undefined) delete (wire as { finished_at?: unknown }).finished_at;
    const { client } = clientFor({ runs: [wire] });
    await expect(listChildRuns(client, "owner-1")).resolves.toEqual({
      kind: "page",
      runs: [{
        runId: "child-1",
        sessionId: "owner-1",
        parentRunId: null,
        description: "inspect the change",
        agentType: "reviewer",
        status: { kind: "known", value: "running" },
        acceptsFollowUps: true,
        turnsUsed: 2,
        toolCount: 7,
        currentStep: "reading tests",
        startedAt: "2026-11-09T00:00:00Z",
        finishedAt: finished ?? null,
        elapsedSeconds: 12.5,
      }],
      invalidRows: 0,
    });
  }
});

test("rejects malformed envelopes and invalid or nonadvancing cursors", async () => {
  for (const reply of [null, {}, { runs: null }, { runs: [], next_offset: -1 }, { runs: [], next_offset: 0 }, { runs: [], next_offset: 1.5 }]) {
    const { client } = clientFor(reply);
    await expect(listChildRuns(client, "owner-1", { offset: 0 })).resolves.toEqual({ kind: "malformed" });
  }
  const { client } = clientFor({ runs: [] });
  await expect(listChildRuns(client, "owner-1", { offset: 12 })).resolves.toEqual({ kind: "page", runs: [], invalidRows: 0 });
});

test("keeps valid rows and counts malformed rows only inside a valid array", async () => {
  const malformedFields = [
    ["run_id", ""], ["session_id", 4], ["parent_run_id", undefined], ["description", 4], ["agent_type", 4],
    ["status", ""], ["status", 4], ["accepts_follow_ups", "yes"], ["turns_used", -1], ["turns_used", 1.5],
    ["tool_count", -1], ["tool_count", Infinity], ["current_step", 4], ["started_at", null], ["finished_at", 4],
    ["elapsed_seconds", -1], ["elapsed_seconds", Infinity],
  ] as const;
  for (const [field, invalid] of malformedFields) {
    const { client } = clientFor({ runs: [{ ...row, [field]: invalid }, row] });
    await expect(listChildRuns(client, "owner-1")).resolves.toMatchObject({
      kind: "page",
      runs: [{ runId: "child-1" }],
      invalidRows: 1,
    });
  }
});

test("feature and input validation send no request", async () => {
  const unavailable = clientFor({ runs: [row] }, []);
  await expect(listChildRuns(unavailable.client, "owner-1")).resolves.toEqual({ kind: "unavailable", feature: "child_runs" });
  await expect(sendChildRun(unavailable.client, { sessionId: "owner-1", runId: "child-1" }, "continue")).resolves.toEqual({ kind: "unavailable", feature: "child_runs" });
  expect(unavailable.calls).toHaveLength(0);

  for (const [sessionId, options] of [["", undefined], ["owner-1", { offset: -1 }], ["owner-1", { offset: 1.5 }], ["owner-1", { limit: 0 }], ["owner-1", { limit: 101 }], ["owner-1", { limit: 1.5 }]] as const) {
    const invalid = clientFor({ runs: [row] });
    await expect(listChildRuns(invalid.client, sessionId, options)).resolves.toEqual({ kind: "malformed" });
    expect(invalid.calls).toHaveLength(0);
  }
  for (const [key, text] of [[{ sessionId: "", runId: "child-1" }, "continue"], [{ sessionId: "owner-1", runId: "" }, "continue"], [{ sessionId: "owner-1", runId: "child-1" }, ""]] as const) {
    const invalid = clientFor({ accepted: true, run_id: "child-1" });
    await expect(sendChildRun(invalid.client, key, text)).resolves.toEqual({ kind: "malformed" });
    expect(invalid.calls).toHaveLength(0);
  }
});

// Zeta src/zeta/server/handlers/child_runs.py:31-82 validates these exact params and success bodies.
test("sends exact list and send requests without retrying", async () => {
  const list = clientFor({ runs: [row], next_offset: 12 });
  const listOptions = { offset: 2, limit: 10, timeoutMs: 250 };
  await expect(listChildRuns(list.client, "owner-1", listOptions)).resolves.toMatchObject({ kind: "page", nextOffset: 12 });
  expect(list.calls).toEqual([["child_run_list", { session_id: "owner-1", offset: 2, limit: 10 }, { timeoutMs: 250 }]]);

  const send = clientFor({ accepted: true, run_id: "child-1" });
  const sendOptions = { timeoutMs: 250 };
  await expect(sendChildRun(send.client, { sessionId: "owner-1", runId: "child-1" }, "continue", sendOptions)).resolves.toEqual({ kind: "accepted", runId: "child-1" });
  expect(send.calls).toEqual([["child_run_send", { session_id: "owner-1", run_id: "child-1", text: "continue" }, sendOptions]]);

  const mismatched = clientFor({ accepted: true, run_id: "other" });
  await expect(sendChildRun(mismatched.client, { sessionId: "owner-1", runId: "child-1" }, "continue")).resolves.toEqual({ kind: "malformed" });
  expect(mismatched.calls).toHaveLength(1);
});

type ZetaClientSatisfiesChildRunClient = ZetaClient extends ChildRunClient ? true : false;
const zetaClientSatisfiesChildRunClient: ZetaClientSatisfiesChildRunClient = true;
void zetaClientSatisfiesChildRunClient;
