import { expect, test } from "bun:test";
import { createRunStore } from "@fulcrum/core";
import { fromZetaEvent, fromZetaHistory } from "../src/index.js";

// Shapes from zeta's `session_history` (src/zeta/server/ergonomics.py): tool_use arguments are emptied and results are bounded.
const rows = [
  { id: "e1", role: "user", content: [{ type: "text", text: "list files" }, { type: "attachment", name: "shot.png", size: 12 }], tool_result: null },
  { id: "e2", role: "assistant", content: [{ type: "thinking", text: "" }, { type: "text", text: "running ls" }, { type: "tool_use", tool_call: { id: "t1", name: "bash", arguments: {} } }], tool_result: null },
  { id: "e3", role: "tool_result", content: [{ type: "text", text: "a\nb" }], tool_result: { tool_call_id: "t1", content: "a\nb", is_error: false, content_blocks: [], structured_content: null } },
  { id: "e4", role: "assistant", content: [{ type: "text", text: "done" }], tool_result: null, failed_turn: { code: "backend_error", message: "provider failed", provider_error: true } },
  { id: "e5", role: "system", content: [{ type: "text", text: "agent finished" }], tool_result: null, notification: { notification_id: "n1", kind: "agent_completion" } },
];

test("maps history rows into one ordered transcript", () => {
  const store = createRunStore((flush) => flush());
  for (const event of fromZetaHistory(rows)) store.dispatch(event);
  expect(store.getOutline().map((entry) => entry.kind)).toEqual(["user", "message", "tool", "message", "error", "notification"]);
  const tool = store.getItem(store.getOutline()[2]!.id);
  expect(tool).toMatchObject({ type: "tool", active: false, output: "", result: { content: "a\nb" }, tool_call: { name: "bash" } });
  const message = store.getItem(store.getOutline()[1]!.id);
  expect(message).toMatchObject({ type: "message", message: { content: [{ type: "text", text: "running ls" }] } });
});

test("a repeated page replaces messages by id instead of adding rows", () => {
  const store = createRunStore((flush) => flush());
  const assistant = fromZetaHistory([rows[3]]).filter((event) => event.type === "message_commit");
  for (const event of [...assistant, ...assistant]) store.dispatch(event);
  expect(store.getOutline()).toHaveLength(1);
});

test("maps approval lifecycle history rows through the live adapter", () => {
  const events = fromZetaHistory([
    { id: "a1", role: "system", event: "approval_request", request_id: "r1", tool_call: { id: "t1", name: "bash", arguments: {} }, delegated: false },
    { id: "a2", role: "system", event: "approval_end", request_id: "r1", data: { decision: "abort", reason: "timeout" } },
  ]);
  expect(events).toEqual([
    { type: "approval_request", request_id: "r1", tool_call: { id: "t1", name: "bash", arguments: {} }, delegated: false },
    { type: "approval_end", request_id: "r1", decision: "abort", data: { decision: "abort", reason: "timeout" } },
  ]);
});

test("history and live approval events share one reducer item", () => {
  const store = createRunStore((flush) => flush());
  const request = { type: "approval_request" as const, request_id: "r1", tool_call: { id: "t1", name: "bash", arguments: {} }, delegated: false };
  for (const event of [...fromZetaHistory([{ id: "a1", role: "system", event: "approval_request", ...request }]), request]) store.dispatch(event);
  expect(store.getOutline()).toEqual([{ id: "approval:r1", kind: "approval" }]);
});

test("one invalid row becomes an error and the rest still map", () => {
  const events = fromZetaHistory([{ id: "x", role: "assistant", content: "nope" }, rows[0]]);
  expect(events.map((event) => event.type)).toEqual(["error", "user_message"]);
});

// zeta's decisions on the wire: `ApprovalDecision` (src/zeta/core/approval.py) is allow | deny | ask, and an aborted
// approval says abort. tests/test_server.py `test_session_history_matches_live_approval_lifecycle` asserts
// data.decision is "allow" | "deny" | "abort" both live and in session_history (abort also carries reason turn_canceled).
test("zeta's allow/deny/abort decisions reach fulcrum as its one vocabulary, live and from history", () => {
  const wire = { allow: "approve", deny: "deny", abort: "abort" } as const;
  for (const [decision, expected] of Object.entries(wire)) {
    const data = decision === "abort" ? { decision, reason: "turn_canceled" } : { decision };
    const live = fromZetaEvent({ event: "approval_end", session_id: "s", request_id: "call-1", tool_call: { id: "call-1", name: "read", arguments: { path: "input.txt" } }, data });
    const history = fromZetaHistory([{ id: "a2", role: "system", event: "approval_end", request_id: "call-1", tool_call: { id: "call-1", name: "read", arguments: {} }, data, ...(decision === "abort" ? { reason: "turn_canceled" } : {}) }]);
    for (const [event] of [live, history]) expect(event).toMatchObject({ type: "approval_end", request_id: "call-1", decision: expected });
  }
  // "ask" is not an ending; an unknown value has no decision rather than a guessed one.
  expect(fromZetaEvent({ event: "approval_end", session_id: "s", request_id: "r", data: { decision: "ask" } })[0]).not.toHaveProperty("decision");
  for (const inherited of ["constructor", "toString", "__proto__"])
    expect(fromZetaEvent({ event: "approval_end", session_id: "s", request_id: "r", data: { decision: inherited } })[0]).not.toHaveProperty("decision");
});

// A real `session_history` response from zeta e3195058 (`zeta serve`, ollama qwen3.6:35b, fresh ZETA_HOME): two bash
// calls, both approved. History empties tool_use arguments and drops structured_content; bash's result text is
// "stdout:\n" + stdout + "\nstderr:\n" + stderr (src/zeta/tools/bash/__init__.py), and is_error is set by a nonzero exit.
test("reopened bash cards get the live view: command from the approval, split stdout/stderr, exit 0 when it passed", async () => {
  const rows = await Bun.file(new URL("./fixtures/history-bash.json", import.meta.url)).json();
  const store = createRunStore((flush) => flush());
  for (const event of fromZetaHistory(rows)) store.dispatch(event);
  const tools = store.getOutline().filter((entry) => entry.kind === "tool").map(({ id }) => store.getItem(id));
  expect(tools.map((item) => item?.type === "tool" ? item.view : undefined)).toEqual([
    { kind: "shell", command: "printf 'alpha\\nbeta\\n'; echo warn-line >&2", stdout: "alpha\nbeta\n", stderr: "warn-line\n", exitCode: 0 },
    // A failed call's exit code is not in history (zeta keeps only is_error), so none is guessed.
    { kind: "shell", command: "ls /nonexistent-dir-xyz", stdout: "", stderr: "ls: /nonexistent-dir-xyz: No such file or directory\n" },
  ]);
});

test("bash text that is not zeta's stdout/stderr shape stays raw output", () => {
  const call = { id: "t1", name: "bash", arguments: { command: "sleep 9" } };
  for (const content of ["tool execution canceled", "[timed out after 1s; process group killed]\nstdout:\n\nstderr:\n", "stdout:\nonly"]) {
    const [end] = fromZetaHistory([
      { id: "a", role: "assistant", content: [{ type: "tool_use", tool_call: call }], tool_result: null },
      { id: "r", role: "tool_result", content: [], tool_result: { tool_call_id: "t1", content, is_error: true, content_blocks: [], structured_content: null } },
    ]).slice(-1);
    expect(end).toMatchObject({ type: "tool_end", view: { kind: "shell", command: "sleep 9" } });
    expect((end as { view: object }).view).not.toHaveProperty("stdout");
  }
});

test("a bash result whose call has no arguments in history still gets the split shell view", () => {
  const events = fromZetaHistory([
    { id: "a", role: "assistant", content: [{ type: "tool_use", tool_call: { id: "t1", name: "bash", arguments: {} } }], tool_result: null },
    { id: "r", role: "tool_result", content: [], tool_result: { tool_call_id: "t1", content: "stdout:\nplayground\nweb\n\nstderr:\n", is_error: false, content_blocks: [], structured_content: null } },
  ]);
  expect(events.at(-1)).toMatchObject({ type: "tool_end", view: { kind: "shell", command: "", stdout: "playground\nweb\n", stderr: "", exitCode: 0 } });
});
