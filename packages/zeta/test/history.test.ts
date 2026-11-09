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

test("history image stubs keep metadata without inventing a zero-byte size", () => {
  const [event] = fromZetaHistory([{ id: "t1", role: "tool_result", content: [], tool_result: { tool_call_id: "call", content: "", is_error: false, content_blocks: [{ type: "image", mimeType: "image/png", width: 3, height: 2, data_omitted: true }] } }]);
  expect(event).toMatchObject({ type: "tool_end", tool_result: { blocks: [{ type: "image", mediaType: "image/png", width: 3, height: 2 }] } });
  expect(event).not.toHaveProperty("tool_result.blocks[0].size");
});

test("maps negotiated history image stubs to generic lazy images without storing bytes", () => {
  const events = fromZetaHistory([
    { id: "m1", role: "user", content: [{ type: "attachment", name: "shot.png", size: 12, handle: "opaque-message" }], tool_result: null },
    { id: "t1", role: "tool_result", content: [], tool_result: { tool_call_id: "call", content: "", is_error: false, content_blocks: [{ type: "image", mimeType: "image/png", size: 9, width: 3, height: 2, data_omitted: true, handle: "opaque-tool" }] } },
  ]);
  expect(events).toMatchObject([
    { type: "user_message", attachments: [{ type: "image", filename: "shot.png", size: 12, source: { kind: "lazy", key: "opaque-message" } }] },
    { type: "tool_end", tool_result: { blocks: [{ type: "image", mediaType: "image/png", size: 9, width: 3, height: 2, source: { kind: "lazy", key: "opaque-tool" } }] } },
  ]);
  expect(JSON.stringify(events)).not.toContain("data:");
});

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

test("child holds use the same readable notification in live and history", () => {
  // Frame shape from zeta 1bef23e0 src/zeta/agent/conversation_channel.py:336-353 and event_contract.py:93-110.
  const data = {
    notification_id: "hold-1",
    origin: "notification",
    kind: "child_hold",
    child_instance_id: "child-1",
    child_session_path: "/tmp/child",
    description: "worker",
    status: "held",
    reason: "rate_limit",
    until: "2030-01-02T03:04:05+00:00",
    provider: "anthropic",
    account: "secret-account",
    retry_after: 1234,
    text: "child child-1 is held by a provider rate limit on secret-account until 2030-01-02T03:04:05+00:00.",
  };
  const live = fromZetaEvent({ event: "child_hold", session_id: "parent", data });
  const history = fromZetaHistory([{ id: "hold-1", role: "system", content: [{ type: "text", text: data.text }], tool_result: null, notification: data }]);
  expect(live).toEqual(history);
  const liveStore = createRunStore((flush) => flush());
  const historyStore = createRunStore((flush) => flush());
  for (const event of live) liveStore.dispatch(event);
  for (const event of history) historyStore.dispatch(event);
  expect(liveStore.getState()).toEqual(historyStore.getState());
  const item = liveStore.getItem(liveStore.getOutline()[0]!.id);
  const readableDeadline = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(data.until));
  expect(item).toMatchObject({ event: { type: "notification", data: { kind: "child_hold", text: `child worker waits for a provider rate limit until ${readableDeadline}` } } });
  expect(JSON.stringify(item)).not.toContain("secret-account");
});

test("child hold copy omits missing or invalid deadlines", () => {
  for (const until of [undefined, "not-a-date"]) {
    const [event] = fromZetaEvent({ event: "child_hold", data: { kind: "child_hold", description: "worker", reason: "subscription_limit", ...(until === undefined ? {} : { until }) } });
    expect(event).toMatchObject({ type: "notification", data: { text: "child worker waits for a subscription limit" } });
    expect((event as { type: "notification"; data: Record<string, unknown> }).data.text).not.toContain("Invalid Date");
  }
});

test("legacy child hold receipts remain notifications", () => {
  expect(fromZetaEvent({ event: "sub_agent_receipt", data: { ...{ kind: "child_hold", notification_id: "hold-1" }, description: "worker", reason: "rate_limit", until: "2030-01-02T03:04:05+00:00", text: "held" } })[0]).toMatchObject({ type: "notification", data: { kind: "child_hold" } });
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

test("live events and history rows project the same tool turn", () => {
  const call = { id: "t1", name: "bash", arguments: { command: "printf ok" } };
  const result = { tool_call_id: "t1", content: "stdout:\\nok\\nstderr:\\n", is_error: false, content_blocks: [], structured_content: { exit_code: 0, stdout: "ok", stderr: "", stdout_truncated: false, stderr_truncated: false, cwd_after: "/tmp" }, structured_content_truncated: false };
  const live = [...fromZetaEvent({ event: "tool_start", tool_call: call }), ...fromZetaEvent({ event: "tool_end", tool_call: call, tool_result: result })];
  const history = fromZetaHistory([
    { id: "a", role: "assistant", content: [{ type: "tool_use", tool_call: call }], tool_result: null },
    { id: "r", role: "tool_result", content: [], tool_result: result },
  ]);
  expect(history.map(({ type, tool_call, view, tool_result }) => ({ type, tool_call, view, tool_result }))).toEqual(live.map(({ type, tool_call, view, tool_result }) => ({ type, tool_call, view, tool_result })));
});

test("history fidelity preserves arguments, structured bash results, and truncation flags", () => {
  const events = fromZetaHistory([
    { id: "a", role: "assistant", content: [{ type: "tool_use", tool_call: { id: "t1", name: "bash", arguments: { command: "false", cwd: "/tmp" }, arguments_truncated: true } }], tool_result: null },
    { id: "r", role: "tool_result", content: [], tool_result: { tool_call_id: "t1", content: "stdout:\\n\\nstderr:\\nfailed\\n", is_error: true, content_blocks: [], structured_content: { exit_code: 2, stdout: "", stderr: "failed\\n", stdout_truncated: false, stderr_truncated: true, cwd_after: "/tmp" }, structured_content_truncated: true } },
  ]);
  expect(events[0]).toMatchObject({ type: "tool_start", tool_call: { arguments: { command: "false", cwd: "/tmp" }, meta: { argumentsTruncated: true } } });
  expect(events[1]).toMatchObject({ type: "tool_end", view: { kind: "shell", command: "false", exitCode: 2, stdout: "", stderr: "failed\\n", cwd: "/tmp" }, tool_result: { truncated: true } });
});

test("with fidelity, the tool_use call is the record: an approval row's call does not replace it", () => {
  // zeta docs/serve-protocol.md:1296-1297: fidelity history keeps the stored, bounded arguments and arguments_truncated.
  const stored = { id: "t1", name: "bash", arguments: { command: "cat big.txt" }, arguments_truncated: true };
  const approved = { id: "t1", name: "bash", arguments: { command: "cat big.txt", note: "from the approval" } };
  const events = fromZetaHistory([
    { id: "a", role: "assistant", content: [{ type: "tool_use", tool_call: stored }], tool_result: null },
    { id: "q", role: "system", event: "approval_request", request_id: "t1", tool_call: approved, delegated: false },
    { id: "r", role: "tool_result", content: [], tool_result: { tool_call_id: "t1", content: "stdout:\nok\nstderr:\n", is_error: false, content_blocks: [], structured_content: null } },
  ]);
  expect(events.at(-1)).toMatchObject({ type: "tool_end", tool_call: { arguments: { command: "cat big.txt" }, meta: { argumentsTruncated: true } } });
  expect((events.at(-1) as { tool_call: { arguments: object } }).tool_call.arguments).not.toHaveProperty("note");
});

test("a real live dropped steer keeps its text and terminal reason", async () => {
  const fixture = await Bun.file(new URL("./fixtures/history-steer-delivery.json", import.meta.url)).json();
  const store = createRunStore((flush) => flush());
  for (const wire of fixture.dropped.liveEvents) for (const event of fromZetaEvent(wire)) store.dispatch(event);
  const steer = store.getOutline().map(({ id }) => store.getItem(id)).find((item) => item?.type === "user" && item.event.type === "user_message" && item.event.delivery_id === "dropped-steer");
  expect(steer).toMatchObject({ event: { text: "this steer must be dropped", delivery_status: "dropped", delivery_reason: "abort" } });
  expect(store.getOutline().filter((item) => item.kind === "notification")).toHaveLength(0);
});

test("fidelity dropped-steer history restores the original text and not-delivered state", () => {
  const [user, status] = fromZetaHistory([{
    id: "drop-1", role: "system", event: "delivery_status", delivery_id: "dropped-steer", method: "steer", status: "dropped",
    content: [{ type: "text", text: "please stop after this command" }], reason: "turn_end",
  }]);
  expect(user).toEqual({ type: "user_message", text: "please stop after this command", mode: "steer", delivery_id: "dropped-steer", delivery_status: "dropped", delivery_reason: "turn_end" });
  expect(status).toEqual({ type: "delivery_status", delivery_id: "dropped-steer", method: "steer", status: "dropped", content: "please stop after this command", reason: "turn_end" });
});

const dropRow = (deliveryId: string, content: string, reason?: string) => ({ id: `drop-${deliveryId}`, role: "system", event: "delivery_status", delivery_id: deliveryId, method: "steer", status: "dropped", content: [{ type: "text", text: content }], ...(reason === undefined ? {} : { reason }) });
const userRow = (id: string, content: string, deliveryId?: string) => ({ id, role: "user", content: [{ type: "text", text: content }], tool_result: null, ...(deliveryId === undefined ? {} : { delivery_id: deliveryId }) });
const historyUsers = (rows: unknown[]) => {
  const store = createRunStore((flush) => flush());
  for (const event of fromZetaHistory(rows)) store.dispatch(event);
  const items = store.getOutline().map(({ id }) => store.getItem(id));
  return {
    users: items.flatMap((item) => item?.type === "user" && item.event.type === "user_message" ? [{ text: item.event.text, status: item.event.delivery_status }] : []),
    notices: items.filter((item) => item?.type === "notification").length,
  };
};

test("a turn-end drop whose text the client resent reloads as one delivered row, as it looked live", () => {
  expect(historyUsers([dropRow("id-2", "also check x", "turn_end"), userRow("u3", "also check x", "id-3")])).toEqual({ users: [{ text: "also check x", status: undefined }], notices: 0 });
});

test("several turn-end drops fold into their resends in order, across the resent turn's rows", () => {
  expect(historyUsers([
    dropRow("id-2", "first", "turn_end"), dropRow("id-3", "second", "turn_end"),
    userRow("u4", "first", "id-4"),
    { id: "a4", role: "assistant", content: [{ type: "text", text: "working" }], tool_result: null },
    userRow("u5", "second", "id-5"),
  ])).toEqual({ users: [{ text: "first", status: undefined }, { text: "second", status: undefined }], notices: 0 });
});

test("a steer dropped twice (its resend raced a new turn and was dropped again) reloads as one delivered row", () => {
  // Turn 1 drops A and B; A's resend starts turn 2; B's resend gets -32004, goes out as a steer, and turn 2 drops it too.
  expect(historyUsers([
    userRow("u1", "start", "id-1"),
    dropRow("id-2", "A", "turn_end"), dropRow("id-3", "B", "turn_end"),
    userRow("u4", "A", "id-4"),
    { id: "a4", role: "assistant", content: [{ type: "text", text: "done" }], tool_result: null },
    dropRow("id-5", "B", "turn_end"),
    userRow("u6", "B", "id-6"),
    userRow("u7", "next", "id-7"),
  ]).users).toEqual([
    { text: "start", status: undefined }, { text: "A", status: undefined }, { text: "B", status: undefined }, { text: "next", status: undefined },
  ]);
});

test("a turn-end drop that nothing resent stays one not-delivered row, even before a later unrelated message", () => {
  expect(historyUsers([dropRow("id-2", "also check x", "turn_end")])).toEqual({ users: [{ text: "also check x", status: "dropped" }], notices: 0 });
  expect(historyUsers([dropRow("id-2", "also check x", "turn_end"), userRow("u3", "something else", "id-3"), userRow("u4", "also check x", "id-4")]).users)
    .toEqual([{ text: "also check x", status: "dropped" }, { text: "something else", status: undefined }, { text: "also check x", status: undefined }]);
});

test("a drop the user's stop caused stays not delivered, even when the same text was sent again", () => {
  expect(historyUsers([dropRow("id-2", "cancel this", "abort"), userRow("u3", "cancel this", "id-3")]).users)
    .toEqual([{ text: "cancel this", status: "dropped" }, { text: "cancel this", status: undefined }]);
});

test("a legacy dropped row without a reason keeps its compact status row", () => {
  expect(historyUsers([dropRow("id-2", "steer dropped")])).toEqual({ users: [], notices: 1 });
});

test("legacy dropped-steer history keeps its compact status row without inventing text", async () => {
  const fixture = await Bun.file(new URL("./fixtures/history-steer-delivery.json", import.meta.url)).json();
  const store = createRunStore((flush) => flush());
  for (const event of fromZetaHistory(fixture.dropped.historyRows)) store.dispatch(event);
  const notices = store.getOutline().filter((item) => item.kind === "notification").map(({ id }) => store.getItem(id));
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ event: { data: { type: "delivery_status", status: "dropped", content: "steer dropped: abort", reason: "abort" } } });
  expect(store.getOutline().map(({ id }) => store.getItem(id)).some((item) => item?.type === "user" && item.event.type === "user_message" && item.event.delivery_id === "dropped-steer")).toBe(false);
});

test("real delivered-steer history joins its user row without an extra status row", async () => {
  const fixture = await Bun.file(new URL("./fixtures/history-steer-delivery.json", import.meta.url)).json();
  const store = createRunStore((flush) => flush());
  for (const event of fromZetaHistory(fixture.delivered.historyRows)) store.dispatch(event);
  const steer = store.getOutline().map(({ id }) => store.getItem(id)).filter((item) => item?.type === "user" && item.event.type === "user_message" && item.event.delivery_id === "delivered-steer");
  expect(steer).toHaveLength(1);
  expect(steer[0]).toMatchObject({ event: { text: "After the tool finishes, include the word STEERED.", delivery_status: "delivered" } });
  expect(store.getOutline().filter((item) => item.kind === "notification")).toHaveLength(0);
});

test("oversized history groups become compact notices", () => {
  expect(fromZetaHistory([{ id: "g", role: "system", event: "history_group_truncated", content: [{ type: "text", text: "[history group too large; truncated]" }] }])).toEqual([
    { type: "history_truncated", text: "[history group too large; truncated]" },
  ]);
});

test("a bash call with no arguments in history keeps the generic card until zeta keeps arguments (GAPS #3)", () => {
  const events = fromZetaHistory([
    { id: "a", role: "assistant", content: [{ type: "tool_use", tool_call: { id: "t1", name: "bash", arguments: {} } }], tool_result: null },
    { id: "r", role: "tool_result", content: [], tool_result: { tool_call_id: "t1", content: "stdout:\nplayground\nweb\n\nstderr:\n", is_error: false, content_blocks: [], structured_content: null } },
  ]);
  expect(events.at(-1)).not.toHaveProperty("view");
});
