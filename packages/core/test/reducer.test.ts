import { expect, test } from "bun:test";
import {
  createRunStore,
  RECEIPT_LIMIT,
  type RunEvent,
  type RunItem,
} from "../src/index.js";
import { appendText } from "../src/stream.js";

const message = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const toolCall = { id: "tool-1", name: "read", arguments: { path: "README.md" } };

const replay = (events: RunEvent[]) => {
  const store = createRunStore(() => {});
  for (const event of events) {
    store.dispatch(event);
    store.getState();
  }
  return store;
};
const itemText = (item: RunItem | undefined) => {
  if (item?.type !== "message") return "";
  return (
    item.text ??
    item.message.content
      .filter((block) => block.type === "text")
      .map((block) => String(block.text))
      .join("")
  );
};

test("append branches from one entity independently", () => {
  const append = (prior: RunItem | undefined, delta: string) =>
    appendText<RunItem>(
      {
        id: "message:assistant",
        type: "message",
        message: { role: "assistant", content: [] },
        version: prior?.type === "message" ? prior.version + 1 : 1,
        active: true,
      },
      prior,
      "text",
      () => (prior?.type === "message" ? prior.text ?? "" : ""),
      delta,
    );
  const a = append(undefined, "a");
  const ab = append(a, "b");
  const ac = append(a, "c");

  expect(itemText(a)).toBe("a");
  expect(itemText(ab)).toBe("ab");
  expect(itemText(ac)).toBe("ac");
});

test("all event paths replay through the store", () => {
  const events: RunEvent[] = [
    { type: "run_start" },
    { type: "turn_start" },
    { type: "message_start" },
    { type: "message_delta", delta: "draft" },
    { type: "message_commit", message: message("done") },
    { type: "message_delta", delta: "discard" },
    { type: "message_reset" },
    { type: "retry" },
    { type: "tool_start", tool_call: toolCall },
    { type: "tool_input", tool_call: toolCall, input: "{\"path\":" },
    { type: "tool_output", tool_call: toolCall, output: "output" },
    {
      type: "tool_end",
      tool_call: toolCall,
      tool_result: { tool_call_id: toolCall.id, content: "output", is_error: false },
    },
    { type: "approval_request", request_id: "approval-1", tool_call: toolCall, delegated: false },
    { type: "approval_end", request_id: "approval-1" },
    { type: "usage", usage: { input_tokens: 1 } },
    { type: "user_message", text: "hello", mode: "normal" },
    { type: "notification", notification_id: "receipt-1" },
    { type: "sub_agent", childRunId: "child-1", status: "running", summary: "working" },
    { type: "unknown", name: "future", data: {} },
    { type: "error", error: { code: "failed", message: "failed" } },
    { type: "turn_end" },
    { type: "run_end" },
  ];
  const store = replay(events);
  expect(store.getOutline()).toHaveLength(7); // the resolved approval folds into its tool's row
  expect(store.getState().agent).toBe("idle");
});

test("a dropped delivery without a message becomes one text-omitted user row", () => {
  const store = replay([{
    type: "delivery_status",
    delivery_id: "dropped-steer",
    method: "steer",
    status: "dropped",
    content: "steer dropped: turn_end",
    reason: "turn_end",
  }]);

  expect(store.getOutline()).toEqual([{ id: "user:delivery:dropped-steer", kind: "user" }]);
  expect(store.getItem("user:delivery:dropped-steer")).toEqual({
    id: "user:delivery:dropped-steer",
    type: "user",
    event: {
      type: "user_message",
      text: "",
      text_omitted: true,
      mode: "steer",
      delivery_id: "dropped-steer",
      delivery_status: "dropped",
      delivery_reason: "turn_end",
    },
  });
});

test("a dropped status followed by its echo fills the same row and keeps the drop", () => {
  const store = replay([
    { type: "delivery_status", delivery_id: "d", method: "steer", status: "dropped", content: "steer dropped: turn_end", reason: "turn_end" },
    { type: "user_message", text: "keep going", mode: "steer", delivery_id: "d" },
  ]);

  expect(store.getOutline()).toEqual([{ id: "user:delivery:d", kind: "user" }]);
  expect(store.getItem("user:delivery:d")).toMatchObject({
    event: { text: "keep going", delivery_status: "dropped", delivery_reason: "turn_end" },
  });
  expect((store.getItem("user:delivery:d") as { event: { text_omitted?: true } }).event.text_omitted).toBeUndefined();
});

test("a message without a delivery id never fills a text-omitted delivery row", () => {
  const store = replay([
    { type: "delivery_status", delivery_id: "d", method: "steer", status: "dropped", content: "steer dropped: turn_end", reason: "turn_end" },
    { type: "user_message", text: "same words are not identity", mode: "steer" },
  ]);

  expect(store.getOutline().filter(({ kind }) => kind === "user")).toHaveLength(2);
  expect(store.getItem("user:delivery:d")).toMatchObject({ event: { text: "", text_omitted: true } });
});

test("run end outcome is retained for the finished run and cleared by its next start", () => {
  const store = replay([
    { type: "run_start" },
    { type: "run_end", outcome: "unknown" } as RunEvent,
  ]);
  expect(store.getState().endOutcome).toBe("unknown");
  store.dispatch({ type: "run_end" });
  expect(store.getState().endOutcome).toBe("unknown");

  store.dispatch({ type: "run_start" });
  expect(store.getState().endOutcome).toBeUndefined();
});

test("sub-agent lifecycle is monotonic for every status pair", () => {
  const statuses = ["running", "waiting_approval", "waiting_input", "idle", "done", "error", "canceled"] as const;
  const terminal = new Set(["done", "error", "canceled"]);

  for (const before of statuses) {
    for (const after of statuses) {
      const store = replay([
        { type: "sub_agent", childRunId: "child", status: before, urgency: before === "waiting_input" ? "input" : undefined },
        { type: "sub_agent", childRunId: "child", status: after, urgency: after === "waiting_approval" ? "approval" : undefined },
      ]);
      const item = store.getItem("sub-agent:child");
      expect(item?.type === "sub_agent" ? item.status : undefined).toBe(terminal.has(before) ? before : after);
      expect(item?.type === "sub_agent" ? item.urgency : undefined).toBe(terminal.has(before) ? undefined : after === "waiting_approval" ? "approval" : undefined);

      const stale = replay([
        { type: "sub_agent", childRunId: "child", status: before, updatedAt: "2026-01-02T00:00:00Z" },
        { type: "sub_agent", childRunId: "child", status: after, updatedAt: "2026-01-01T00:00:00Z" },
      ]).getItem("sub-agent:child");
      expect(stale?.type === "sub_agent" ? stale.status : undefined).toBe(before);
    }
  }
});

test("a sparse sub-agent update keeps the row facts, and the tool count never goes down", () => {
  const store = replay([
    { type: "sub_agent", childRunId: "child", status: "running", name: "reviewer", task: "audit auth", latestActivity: "$ bun test", toolCount: 3, startedAt: "2026-01-01T00:00:00Z" },
    { type: "sub_agent", childRunId: "child", status: "waiting_approval", urgency: "approval", toolCount: 2 },
  ]);
  expect(store.getItem("sub-agent:child")).toMatchObject({ status: "waiting_approval", urgency: "approval", name: "reviewer", task: "audit auth", latestActivity: "$ bun test", toolCount: 3, startedAt: "2026-01-01T00:00:00Z" });
  store.dispatch({ type: "sub_agent", childRunId: "child", status: "running", latestActivity: "read src/auth.ts", toolCount: 5 });
  const item = store.getItem("sub-agent:child");
  expect(item).toMatchObject({ status: "running", latestActivity: "read src/auth.ts", toolCount: 5, name: "reviewer" });
  expect(item?.type === "sub_agent" ? item.urgency : "unset").toBeUndefined();
});

test("sub-agent lifecycle uses ordering metadata and clears resolved urgency", () => {
  const store = replay([
    { type: "sub_agent", childRunId: "child", status: "waiting_input", urgency: "input", updatedAt: "2026-01-02T00:00:00Z" },
    { type: "sub_agent", childRunId: "child", status: "running", updatedAt: "2026-01-01T00:00:00Z" },
  ]);
  expect(store.getItem("sub-agent:child")).toMatchObject({ status: "waiting_input", urgency: "input" });

  store.dispatch({ type: "sub_agent", childRunId: "child", status: "running", updatedAt: "2026-01-03T00:00:00Z" });
  expect(store.getItem("sub-agent:child")).toMatchObject({ status: "running" });
  expect(store.getItem("sub-agent:child")?.type === "sub_agent" ? store.getItem("sub-agent:child")?.urgency : undefined).toBeUndefined();

  store.dispatch({ type: "sub_agent", childRunId: "sequenced", status: "idle", sequence: 2 });
  store.dispatch({ type: "sub_agent", childRunId: "sequenced", status: "running", sequence: 1 });
  expect(store.getItem("sub-agent:sequenced")).toMatchObject({ status: "idle", sequence: 2 });
});

test("delta changes only the streaming message identity", () => {
  const store = replay([
    { type: "message_commit", message_id: "other", message: message("old") },
    { type: "tool_start", tool_call: toolCall },
    { type: "message_delta", message_id: "stream", delta: "a" },
  ]);
  const outline = store.getOutline();
  const other = store.getItem("message:other");
  const tool = store.getItem(`tool:${toolCall.id}`);
  const stream = store.getItem("message:stream");
  store.dispatch({ type: "message_delta", message_id: "stream", delta: "b" });

  expect(store.getItem("message:stream")).not.toBe(stream);
  expect(store.getItem("message:other")).toBe(other);
  expect(store.getItem(`tool:${toolCall.id}`)).toBe(tool);
  expect(store.getOutline()).toBe(outline);
});

test("a commit on an already committed message replaces it in place", () => {
  const store = replay([
    { type: "message_commit", message_id: "m", message: message("first") },
    { type: "tool_start", tool_call: toolCall },
    { type: "message_delta", message_id: "live", delta: "streaming" },
  ]);
  const outline = store.getOutline();
  const before = store.getItem("message:m");
  store.dispatch({ type: "message_commit", message_id: "m", message: message("first, with metadata") });

  expect(store.getItem("message:m")).toMatchObject({ message: message("first, with metadata"), version: before!.version + 1, active: false });
  expect(store.getOutline().map(({ id }) => id)).toEqual(outline.map(({ id }) => id));
  // Committing another message ends the streaming one: commit a stale message only once nothing streams.
  expect(store.getItem("message:live")).toMatchObject({ active: false });
});

test("tool output changes only the streamed tool identity", () => {
  const store = replay([
    { type: "message_commit", message_id: "other", message: message("old") },
    { type: "tool_start", tool_call: toolCall },
  ]);
  const outline = store.getOutline();
  const tool = store.getItem(`tool:${toolCall.id}`);
  const other = store.getItem("message:other");
  store.dispatch({ type: "tool_output", tool_call: toolCall, output: "chunk" });

  expect(store.getItem(`tool:${toolCall.id}`)).not.toBe(tool);
  expect(store.getItem("message:other")).toBe(other);
  expect(store.getOutline()).toBe(outline);
});

test("output events keep a known call; an unknown call takes the event's call", () => {
  const known = { ...toolCall, meta: { wireId: "w1", title: "Read README" } };
  const store = replay([{ type: "tool_start", tool_call: known }]);
  const other = { id: toolCall.id, name: "tool", arguments: {}, meta: { wireId: "w1" } };
  store.dispatch({ type: "tool_output", tool_call: other, output: "a" });
  const afterOutput = store.getItem(`tool:${toolCall.id}`);
  expect(afterOutput?.type === "tool" ? afterOutput.tool_call : undefined).toBe(known);
  store.dispatch({ type: "tool_output", tool_call: other, output: "b", replace: true });
  store.dispatch({ type: "tool_end", tool_call: other, tool_result: { tool_call_id: toolCall.id, content: "b", is_error: false } });
  const ended = store.getItem(`tool:${toolCall.id}`);
  expect(ended?.type === "tool" ? ended.tool_call : undefined).toBe(known);

  const orphan = { id: "tool-2", name: "bash", arguments: { command: "ls" } };
  store.dispatch({ type: "tool_output", tool_call: orphan, output: "x" });
  const created = store.getItem("tool:tool-2");
  expect(created?.type === "tool" ? [created.tool_call, created.output, created.active] : undefined).toEqual([orphan, "x", true]);
  expect(created?.type === "tool" ? created.tool_call : undefined).toBe(orphan);
});

test("tool_output with replace replaces the output in place and keeps the approval", () => {
  const request: RunEvent = { type: "approval_request", request_id: "approval-1", tool_call: toolCall, delegated: false };
  const approve: RunEvent = { type: "approval_end", request_id: "approval-1", decision: "approve" };
  const after: RunEvent = { type: "message_commit", message_id: "after", message: message("after") };
  const replace = (output: string): RunEvent => ({ type: "tool_output", tool_call: toolCall, output, replace: true });
  const toolOf = (store: ReturnType<typeof replay>) => {
    const item = store.getItem(`tool:${toolCall.id}`);
    if (item?.type !== "tool") throw new Error("no tool row");
    return item;
  };
  const ids = (store: ReturnType<typeof replay>) => store.getOutline().map(({ id }) => id);

  // After streamed outputs: the whole output so far replaces what the row has.
  const streamed = replay([
    { type: "tool_start", tool_call: toolCall },
    { type: "tool_output", tool_call: toolCall, output: "1 " },
    { type: "tool_output", tool_call: toolCall, output: "2 " },
    after,
  ]);
  const streamedIds = ids(streamed);
  streamed.dispatch(replace("1 2 3"));
  expect(toolOf(streamed).output).toBe("1 2 3");
  expect(toolOf(streamed).active).toBe(true);
  streamed.dispatch(replace("1 2 3 4"));
  expect(toolOf(streamed).output).toBe("1 2 3 4");
  streamed.dispatch({ type: "tool_output", tool_call: toolCall, output: " 5" });
  expect(toolOf(streamed).output).toBe("1 2 3 4 5");
  expect(ids(streamed)).toEqual(streamedIds);

  // After an approval folds into the row: the decision stays.
  const approved = replay([request, approve, { type: "tool_start", tool_call: toolCall }, replace("1"), after]);
  const approvedIds = ids(approved);
  approved.dispatch(replace("1 2"));
  expect(toolOf(approved)).toMatchObject({ output: "1 2", active: true, approval: { decision: "approve" } });
  expect(ids(approved)).toEqual(approvedIds);
  expect(approvedIds.filter((id) => id.startsWith("approval:"))).toEqual([]);

  // After tool_end: the result and error state clear, and the row is live again in its place.
  const ended = replay([
    request,
    approve,
    { type: "tool_start", tool_call: toolCall },
    { type: "tool_output", tool_call: toolCall, output: "partial" },
    { type: "tool_end", tool_call: toolCall, tool_result: { tool_call_id: toolCall.id, content: "failed", is_error: true, is_canceled: true } },
    after,
  ]);
  const endedIds = ids(ended);
  ended.dispatch(replace("whole"));
  const row = toolOf(ended);
  expect(row).toMatchObject({ output: "whole", active: true, is_error: false, canceled: false, approval: { decision: "approve" } });
  expect(row.result).toBeUndefined();
  expect(ids(ended)).toEqual(endedIds);
  expect(ended.getState().activeToolIds[toolCall.id]).toBe(true);
});

test("commit replaces streamed text with the final message", () => {
  const store = replay([
    { type: "message_delta", delta: "draft " },
    { type: "message_delta", delta: "text" },
    { type: "message_commit", message: message("final text") },
  ]);
  const item = store.getItem("message:assistant");
  expect(store.getOutline()).toEqual([{ id: "message:assistant", kind: "message" }]);
  expect(item?.type === "message" ? item.message.content : undefined).toEqual(message("final text").content);
  expect(item?.type === "message" ? item.text : undefined).toBeUndefined();
});

test("message_reset discards the in-progress stream", () => {
  const store = replay([
    { type: "message_delta", delta: "discard me" },
    { type: "message_reset" },
  ]);
  expect(store.getState().activeMessageId).toBeUndefined();
  expect(store.getItem("message:assistant")).toBeUndefined();
  expect(store.getOutline()).toEqual([]);
});

test("published snapshots and entities do not change after a delta", () => {
  const store = replay([{ type: "message_delta", delta: "before" }]);
  const snapshot = store.getState();
  const item = store.getItem("message:assistant");
  store.dispatch({ type: "message_delta", delta: " after" });

  expect(itemText(store.getItem("message:assistant"))).toBe("before after");
  expect(itemText(item)).toBe("before");
  expect(store.getState()).not.toBe(snapshot);
  expect(snapshot.outline).toEqual([{ id: "message:assistant", kind: "message" }]);
});

test.each([
  ["new then old", "+ + + + r3 r0 r2"],
  ["old then new", "+ + + + r0 r3 r1"],
  ["middle versions never read", "+ r0 + + + r3 r2 r1"],
  ["reads between deltas", "+ r0 + r1 + r0 r2 + r3 r1 r3"],
  ["after commit", "+ + r1 + c r2 r0"],
])("each stream version keeps its own text across reads: %s", (_, steps) => {
  const store = createRunStore((flush) => flush());
  const versions: RunItem[] = [];
  for (const step of steps.split(" ")) {
    if (step === "+") {
      store.dispatch({ type: "message_delta", message_id: "m", delta: String(versions.length) });
      versions.push(store.getItem("message:m")!);
    } else if (step === "c") {
      store.dispatch({ type: "message_commit", message_id: "m", message: message("final") });
    } else {
      const index = Number(step.slice(1));
      expect(itemText(versions[index])).toBe("0123".slice(0, index + 1));
    }
  }
});

test("tool output read through the stream cache every few chunks keeps each version's text", () => {
  const store = createRunStore((flush) => flush());
  store.dispatch({ type: "tool_start", tool_call: toolCall });
  const outputOf = (item: RunItem | undefined) => (item?.type === "tool" ? item.output : undefined);
  const read: { item: RunItem; text: string }[] = [];
  let expected = "";
  for (let i = 0; i < 200; i++) {
    store.dispatch({ type: "tool_output", tool_call: toolCall, output: `${i},` });
    expected += `${i},`;
    if (i % 7 === 0) {
      const item = store.getItem(`tool:${toolCall.id}`)!;
      expect(outputOf(item)).toBe(expected);
      read.push({ item, text: expected });
    }
  }
  expect(outputOf(store.getItem(`tool:${toolCall.id}`))).toBe(expected);
  // Older versions read after newer ones still return their own text.
  for (const { item, text } of [read[3], read[0], read[read.length - 2]]) expect(outputOf(item)).toBe(text);
});

test("spread, JSON, and structuredClone copies of a streaming item carry its text", () => {
  const store = replay([
    { type: "message_delta", message_id: "copy", delta: "a" },
    { type: "message_delta", message_id: "copy", delta: "b" },
  ]);
  const item = store.getItem("message:copy")!;
  expect(itemText({ ...item } as RunItem)).toBe("ab");
  expect(itemText(JSON.parse(JSON.stringify(item)))).toBe("ab");
  expect(itemText(structuredClone(item))).toBe("ab");
});

test("run_end clears active assistant and tool streams", () => {
  const store = replay([
    { type: "message_delta", delta: "old" },
    { type: "tool_start", tool_call: toolCall },
    { type: "tool_output", tool_call: toolCall, output: "old" },
    { type: "run_end" },
    { type: "message_delta", delta: "new" },
    { type: "tool_output", tool_call: toolCall, output: "new" },
  ]);
  const messageIds = store.getOutline().filter(({ kind }) => kind === "message").map(({ id }) => id);
  expect(messageIds).toHaveLength(2);
  expect(itemText(store.getItem("message:assistant"))).toBe("old");
  expect(itemText(store.getItem("message:assistant-2"))).toBe("new");
  const tool = store.getItem(`tool:${toolCall.id}`);
  expect(tool?.type === "tool" ? tool.output : undefined).toBe("new");
});

test("handles unknown events and receipt dedupe", () => {
  const store = replay([
    { type: "unknown", name: "future_event", data: { notification_id: "1", value: 1 } },
    { type: "unknown", name: "future_event", data: { notification_id: "1", value: 2 } },
    { type: "future_event", data: { value: 3 } } as never,
  ]);
  expect(store.getOutline().filter(({ kind }) => kind === "unknown")).toHaveLength(2);
  expect(store.getState().receipts["1"]).toBe(true);
});

test("receipt dedupe is bounded and evicts the oldest receipt", () => {
  const store = createRunStore(() => {});
  for (let i = 0; i <= RECEIPT_LIMIT; i++)
    store.dispatch({ type: "notification", notification_id: String(i) });
  const state = store.getState();
  expect(Object.keys(state.receipts)).toHaveLength(RECEIPT_LIMIT);
  expect(state.receipts["0"]).toBeUndefined();
  expect(state.receipts[String(RECEIPT_LIMIT)]).toBe(true);
});

test("streaming reasoning stays separate from assistant text", () => {
  const store = replay([
    { type: "message_delta", message_id: "mixed", kind: "reasoning", delta: "check " },
    { type: "message_delta", message_id: "mixed", kind: "reasoning", delta: "evidence" },
    { type: "message_delta", message_id: "mixed", kind: "text", delta: "answer" },
  ]);
  const item = store.getItem("message:mixed");
  expect(item?.type === "message" ? item.message.content : []).toEqual([
    { type: "reasoning", text: "check evidence" },
  ]);
  expect(item?.type === "message" ? item.text : undefined).toBe("answer");
});

test("an empty message_delta from any adapter is a no-op", () => {
  const store = replay([{ type: "message_commit", message_id: "m0", message: message("hi") }]);
  const state = store.getState();
  const outline = store.getOutline();
  store.dispatch({ type: "message_delta", message_id: "empty", delta: "" });
  expect(store.getOutline()).toBe(outline);
  expect(store.getItem("message:empty")).toBeUndefined();
  expect(store.getState()).toBe(state);
});

test("a repeated approval_request updates its one row and keeps a recorded end", () => {
  const store = createRunStore((flush) => flush());
  const request: RunEvent = { type: "approval_request", request_id: "approval-1", tool_call: toolCall, delegated: false };
  store.dispatch(request);
  store.dispatch({ ...request, delegated: true });
  expect(store.getOutline().map(({ id }) => id)).toEqual(["approval:approval-1"]);
  expect(store.getItem("approval:approval-1")).toMatchObject({ request: { delegated: true } });
  store.dispatch({ type: "approval_end", request_id: "approval-1" });
  store.dispatch(request);
  expect(store.getOutline()).toHaveLength(1);
  expect(store.getItem("approval:approval-1")).toMatchObject({ ended: { type: "approval_end" } });
});

test("tool_start on a known call restarts its row in place and keeps the approval decision", () => {
  const view = { kind: "read", path: "README.md" } as const;
  const store = replay([
    { type: "approval_request", request_id: "approval-1", tool_call: toolCall, delegated: false },
    { type: "approval_end", request_id: "approval-1", decision: "approve" },
    { type: "tool_start", tool_call: toolCall, view },
    { type: "tool_output", tool_call: toolCall, output: "partial" },
    { type: "tool_end", tool_call: toolCall, tool_result: { tool_call_id: toolCall.id, content: "failed", is_error: true } },
    { type: "message_commit", message_id: "after", message: message("after") },
    { type: "tool_start", tool_call: toolCall },
  ]);
  const outline = store.getOutline().map(({ id }) => id);
  expect(outline).toEqual([`tool:${toolCall.id}`, "message:after"]);
  const item = store.getItem(`tool:${toolCall.id}`);
  expect(item).toMatchObject({ output: "", active: true, is_error: false, canceled: false, approval: { decision: "approve" } });
  expect(item?.type === "tool" ? [item.result, item.view] : "missing").toEqual([undefined, undefined]);
  store.dispatch({ type: "tool_output", tool_call: toolCall, output: "whole" });
  expect(store.getItem(`tool:${toolCall.id}`)).toMatchObject({ output: "whole" });
  expect(store.getOutline().map(({ id }) => id)).toEqual(outline);
});

test("a resolved approval folds into its tool's row, in the same place live and after a reload", () => {
  const request: RunEvent = { type: "approval_request", request_id: "approval-1", tool_call: toolCall, delegated: false };
  const end: RunEvent = { type: "approval_end", request_id: "approval-1", decision: "approve" };
  const result: RunEvent = { type: "tool_end", tool_call: toolCall, tool_result: { tool_call_id: toolCall.id, content: "ok", is_error: false } };
  const before: RunEvent = { type: "user_message", text: "go", mode: "normal" };
  const after: RunEvent = { type: "error", error: { code: "x", message: "later" } };
  const ids = (store: ReturnType<typeof replay>) => store.getOutline().map(({ id }) => id);
  // Live: the request, the decision, then the call runs.
  const live = replay([before, request, end, { type: "tool_start", tool_call: toolCall }, { type: "tool_output", tool_call: toolCall, output: "o" }, result, after]);
  // A reload: history replays the call first, then its approval.
  const reloaded = replay([before, { type: "tool_start", tool_call: toolCall }, result, request, end, after]);
  for (const store of [live, reloaded]) {
    expect(ids(store)).toHaveLength(3);
    expect(ids(store).filter((id) => id.startsWith("approval:"))).toEqual([]);
    expect(ids(store)[1]).toBe(`tool:${toolCall.id}`);
    expect(store.getItem(`tool:${toolCall.id}`)).toMatchObject({ approval: { type: "approval_end", decision: "approve" } });
  }
  // Folded calls drop their approval link: later output of a chatty call does not search the outline again.
  for (const store of [live, reloaded]) expect(store.getState().toolApprovals).toEqual({});
  // A pending approval keeps its own row (it carries the actions) even when the call already has a card.
  const pending = replay([{ type: "tool_start", tool_call: toolCall }, request]);
  expect(ids(pending)).toEqual([`tool:${toolCall.id}`, "approval:approval-1"]);
  // A denied call that never ran stays one approval row.
  const denied = replay([request, { type: "approval_end", request_id: "approval-1", decision: "deny" }]);
  expect(ids(denied)).toEqual(["approval:approval-1"]);
});
