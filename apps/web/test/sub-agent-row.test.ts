import { expect, test } from "bun:test";
import { createRunStore, type RunEvent } from "@fulcrum/core";
import { subAgentRow } from "@fulcrum/react";
import { fromZetaEvent, fromZetaHistory } from "@fulcrum/zeta";

// One finished child, in every order zeta 352442dc can deliver it, reads as one row: its outcome, its task, and the
// child's reply (not its task, and not the last step its progress left). Shapes: child_run_lifecycle.py history rows,
// conversation_channel.py completion data, history_projection.py notification rows.
type Outcome = "completed" | "canceled" | "failed";
const child = (status: string, extra: Record<string, unknown> = {}) => ({
  run_id: "p:1", session_id: "p", parent_run_id: null, description: "count lines", agent_type: "run", status,
  accepts_follow_ups: true, turns_used: 1, tool_count: 0, current_step: "turn 1: thinking",
  started_at: "2026-11-20T10:00:00+00:00", finished_at: null, elapsed_seconds: 0, ...extra,
});
const ended = (outcome: Outcome) => child(outcome, { finished_at: "2026-11-20T10:01:15+00:00", elapsed_seconds: 75 });
const receipt = (outcome: Outcome) => ({
  kind: "agent_completion", notification_id: "n1", child_instance_id: "p:1", child_session_path: "/s/p/agents/1",
  description: "count lines", status: outcome === "failed" ? "error" : outcome,
  text: `child reply 0 · 1 turns · 75.0s · 0 tool calls · error=${outcome === "failed"} · canceled=${outcome === "canceled"}`,
});

const live = {
  started: () => ({ event: "child_started", session_id: "p", run_id: "p:1", sequence: 1, stream_id: "s", seq: 1, child: child("running") }),
  progress: () => ({ event: "child_progress", session_id: "p", run_id: "p:1", sequence: 1, revision: 2, stream_id: "s", seq: 2, child: child("running") }),
  ended: (outcome: Outcome) => ({ event: "child_ended", session_id: "p", run_id: "p:1", sequence: 2, stream_id: "s", seq: 3, child: ended(outcome) }),
  receipt: (outcome: Outcome) => ({ event: "sub_agent_receipt", session_id: "p", data: receipt(outcome) }),
};
const history = {
  started: () => ({ id: "e1", role: "system", event: "child_started", session_id: "p", run_id: "p:1", sequence: 1, child: child("running") }),
  progress: () => ({ event: "child_progress", session_id: "p", run_id: "p:1", sequence: 1, revision: 2, child: child("running") }),
  ended: (outcome: Outcome) => ({ id: "e3:child_ended", role: "system", event: "child_ended", session_id: "p", run_id: "p:1", sequence: 2, child: ended(outcome) }),
  receipt: (outcome: Outcome) => {
    const { notification_id: _id, ...notification } = receipt(outcome);
    return { id: "n1", role: "system", content: [{ type: "text", text: notification.text }], tool_result: null, notification };
  },
};

const fromLive = (events: unknown[]) => events.flatMap((event) => fromZetaEvent(event));
const sequences: Record<string, (outcome: Outcome) => RunEvent[]> = {
  "live: started, progress, ended, receipt": (o) => fromLive([live.started(), live.progress(), live.ended(o), live.receipt(o)]),
  "live: started, progress, receipt, ended": (o) => fromLive([live.started(), live.progress(), live.receipt(o), live.ended(o)]),
  "live: a late progress after the end": (o) => fromLive([live.started(), live.ended(o), live.receipt(o), live.progress()]),
  "history: ended, then the receipt": (o) => fromZetaHistory([history.started(), history.progress(), history.ended(o), history.receipt(o)]),
  "history: the receipt, then ended": (o) => fromZetaHistory([history.started(), history.progress(), history.receipt(o), history.ended(o)]),
  "reload after live: history replayed onto the live row": (o) => [
    ...fromLive([live.started(), live.progress(), live.ended(o), live.receipt(o)]),
    ...fromZetaHistory([history.started(), history.progress(), history.ended(o), history.receipt(o)]),
  ],
};
const expected: Record<Outcome, string> = { completed: "done", canceled: "canceled", failed: "failed" };

const rowOf = (events: RunEvent[]) => {
  const store = createRunStore((flush) => flush());
  for (const event of events) store.dispatch(event);
  const items = store.getOutline().map(({ id }) => store.getItem(id)).filter((item) => item?.type === "sub_agent");
  expect(items).toHaveLength(1);
  const { status, task, activity, title } = subAgentRow(items[0] as Parameters<typeof subAgentRow>[0], null, 0);
  return { status, task, activity, title };
};

test.each(Object.keys(sequences).flatMap((name) => (["completed", "canceled", "failed"] as const).map((outcome) => [name, outcome] as const)))(
  "a finished child reads as one row with its reply: %s (%s)",
  (name, outcome) => {
    const events = sequences[name]!(outcome);
    const row = rowOf(events);
    expect(row).toEqual({
      status: expected[outcome], task: "count lines", activity: "child reply 0",
      title: "run\ncount lines\n1m 15s · 0 tools\nchild reply 0\ndetails unavailable",
    });
    // Every event delivered twice (a reconnect replay) reads the same.
    expect(rowOf(events.flatMap((event) => [event, event]))).toEqual(row);
  },
);

test("a receipt alone (a server without child_run_events) reads as the task and the reply", () => {
  expect(rowOf(fromLive([live.receipt("completed")]))).toMatchObject({ status: "done", task: "count lines", activity: "child reply 0" });
  expect(rowOf(fromLive([live.started(), live.progress()]))).toMatchObject({ status: "running", activity: "turn 1: thinking" });
});

// A question notice puts a fixed label in `description` and the task in `agent_description`
// (conversation_channel.py child_question, _step_delivery.py child_question_withdrawn).
const question = (withdrawn: boolean) => ({
  kind: withdrawn ? "child_question_withdrawn" : "child_question", child_instance_id: "p:1", question_id: "q1",
  description: withdrawn ? "child question withdrawn" : "child question", agent_description: "count lines",
  status: withdrawn ? "withdrawn" : "pending",
  ...(withdrawn ? { text: "question withdrawn: child canceled" } : { question: "which dir?", text: "child p:1 asks: which dir?" }),
});
const liveQuestion = (withdrawn: boolean) => ({ event: "sub_agent_receipt", session_id: "p", data: { notification_id: withdrawn ? "n3" : "n2", ...question(withdrawn) } });
const historyQuestion = (withdrawn: boolean) => {
  const notification = question(withdrawn);
  return { id: withdrawn ? "n3" : "n2", role: "system", content: [{ type: "text", text: notification.text }], tool_result: null, notification };
};
const waiting: Record<string, () => RunEvent[]> = {
  "live: started, question": () => fromLive([live.started(), liveQuestion(false)]),
  "live: started, question, withdrawn": () => fromLive([live.started(), liveQuestion(false), liveQuestion(true)]),
  // _notifications.py `append_child_question` writes no agent_description.
  "live: started, question without agent_description": () => {
    const { agent_description: _task, ...data } = liveQuestion(false).data;
    return fromLive([live.started(), { event: "sub_agent_receipt", session_id: "p", data }]);
  },
  "live: question alone": () => fromLive([liveQuestion(false)]),
  "live: withdrawn alone": () => fromLive([liveQuestion(true)]),
  "history: started, question": () => fromZetaHistory([history.started(), historyQuestion(false)]),
  "history: started, question, withdrawn": () => fromZetaHistory([history.started(), historyQuestion(false), historyQuestion(true)]),
  "history: question alone": () => fromZetaHistory([historyQuestion(false)]),
  "history: withdrawn alone": () => fromZetaHistory([historyQuestion(true)]),
};
test.each(Object.keys(waiting))("a child's question keeps its task, not the notice label: %s", (name) => {
  const withdrawn = name.includes("withdrawn");
  expect(rowOf(waiting[name]!())).toMatchObject({ status: withdrawn ? "running" : "needs input", task: "count lines" });
});
