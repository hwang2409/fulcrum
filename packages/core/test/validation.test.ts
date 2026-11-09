import { expect, test } from "bun:test";
import { createRunStore, initialState, type RunEvent } from "../src/index.js";
import { eventSchemas } from "../src/reducer.js";
import { seededRandom } from "./fuzz.js";

const seeds = [11, 29, 101, 2027, 65537];
const good = (index: number): RunEvent => {
  const id = String(index % 113);
  switch (index % 12) {
    case 0: return { type: "run_start" };
    case 1: return { type: "turn_start", data: { turn: index } };
    case 2: return { type: "message_delta", message_id: `m${id}`, delta: `x${index}`, kind: "text" };
    case 3: return { type: "message_commit", message_id: `m${id}`, message: { role: "assistant", content: [{ type: "text", text: `v${index}` }] } };
    case 4: return { type: "tool_start", tool_call: { id: `t${id}`, name: "bash", arguments: { command: "true" } } };
    case 5: return { type: "tool_output", tool_call: { id: `t${id}`, name: "bash", arguments: {} }, output: `o${index}` };
    case 6: return { type: "tool_end", tool_call: { id: `t${id}`, name: "bash", arguments: {} }, tool_result: { tool_call_id: `t${id}`, content: "ok", is_error: false } };
    case 7: return { type: "approval_end", request_id: `absent${id}`, decision: "approve" };
    case 8: return { type: "user_message", text: `u${index}`, mode: "send", message_id: `m${index}`, delivery_id: `d${index}`, intent: `i${index % 37}` };
    case 9: return { type: "notification", notification_id: `n${index}`, data: { text: `n${index}` } };
    case 10: return { type: "sub_agent", childRunId: `c${id}`, status: index % 2 ? "running" : "done", sequence: index };
    default: return { type: "turn_end" };
  }
};
type Generated = { event: unknown; replay?: RunEvent };
const bad = (index: number): Generated => {
  switch (index % 16) {
    case 0: return { event: null };
    case 1: return { event: [] };
    case 2: return { event: { type: 7 } };
    case 3: return { event: { type: "tool_start", tool_call: undefined } };
    case 4: return { event: { type: "message_delta", message_id: {}, delta: 4 } };
    case 5: return { event: { type: "message_commit", message: { role: "assistant", content: "bad" } } };
    case 6: return { event: { type: "approval_end", request_id: 3, decision: "maybe" } };
    case 7: return { event: { type: "usage", usage: { input: Number.NaN } } };
    case 8: return { event: { type: "sub_agent", childRunId: "bad", status: "running", startedAt: 3 }, replay: { type: "sub_agent", childRunId: "bad", status: "running" } };
    case 9: return { event: { type: "sub_agent", childRunId: "bad-seq", status: "running", sequence: Number.NaN }, replay: { type: "sub_agent", childRunId: "bad-seq", status: "running" } };
    case 10: return { event: { type: "user_message", text: "x", mode: "send", delivery_id: Number.NaN }, replay: { type: "user_message", text: "x", mode: "send" } };
    case 11: return { event: { type: "error", error: { code: "x", message: 9 } } };
    case 12: return { event: { type: "future_kind", data: { text: "secret" } }, replay: { type: "unknown", name: "future_kind", data: { text: "secret" } } };
    case 13: { const event = { type: "tool_start", tool_call: { id: "__proto__", name: "x", arguments: Object.fromEntries([["__proto__", "v"]]) } } as RunEvent; return { event, replay: event }; }
    case 14: { const event = { type: "approval_end", request_id: "absent", decision: "approve" } as RunEvent; return { event, replay: event }; }
    default: { const event = { type: "user_message", text: index === 999 ? "x".repeat(1_000_000) : "huge", mode: "send", delivery_id: `huge${index}` } as RunEvent; return { event, replay: event }; }
  }
};
const view = (store: ReturnType<typeof createRunStore>) => ({
  state: store.getState(),
  outline: store.getOutline(),
  items: store.getOutline().map(({ id }) => store.getItem(id)),
});

test("sanitization reads each schema field once and preserves valid event identity", () => {
  const reads: Record<string, number> = {};
  const accessorEvent: Record<string, unknown> = { type: "user_message" };
  for (const [field, value] of Object.entries({ text: "hello", mode: "send", delivery_id: {} })) {
    Object.defineProperty(accessorEvent, field, {
      enumerable: true,
      get() { reads[field] = (reads[field] ?? 0) + 1; return value; },
    });
  }
  const store = createRunStore((flush) => flush());
  store.dispatch(accessorEvent as unknown as RunEvent);
  expect(reads).toEqual({ text: 1, mode: 1, delivery_id: 1 });

  const validEvent = { type: "user_message", text: "same", mode: "send" } as const;
  store.dispatch(validEvent);
  expect((store.getItem("user:2") as { event: RunEvent }).event).toBe(validEvent);
});

test("thrown required and optional validation follow their field rules", () => {
  const required = Proxy.revocable({}, {});
  const optional = Proxy.revocable({}, {});
  required.revoke();
  optional.revoke();
  const requiredStore = createRunStore((flush) => flush());
  requiredStore.dispatch({ type: "tool_start", tool_call: required.proxy } as unknown as RunEvent);
  expect(requiredStore.getDiagnostics()).toEqual({ ignoredEvents: 1, sanitizedFields: 0, desynced: false });

  const optionalStore = createRunStore((flush) => flush());
  optionalStore.dispatch({ type: "user_message", text: "kept", mode: "send", attachments: optional.proxy } as unknown as RunEvent);
  expect(optionalStore.getDiagnostics()).toEqual({ ignoredEvents: 0, sanitizedFields: 1, desynced: false });
  expect(optionalStore.getOutline()).toEqual([{ id: "user:1", kind: "user" }]);
});

test("nested optional sanitization copies only changed levels", () => {
  const toolCall = { id: "t", name: "bash", arguments: {} };
  const result = { tool_call_id: "t", content: "ok", is_error: false, is_canceled: "invalid" };
  const event = { type: "tool_end", tool_call: toolCall, tool_result: result } as unknown as RunEvent;
  const store = createRunStore((flush) => flush());
  store.dispatch(event);

  const stored = store.getItem("tool:t") as { tool_call: unknown; result: Record<string, unknown> };
  expect(stored.tool_call).toBe(toolCall);
  expect(stored.result).not.toBe(result);
  expect(stored.result).toEqual({ tool_call_id: "t", content: "ok", is_error: false });
  expect(result.is_canceled).toBe("invalid");
  expect(store.getDiagnostics().sanitizedFields).toBe(1);
});

test("malformed event fuzz is total and equals a valid-only replay", () => {
  for (const seed of seeds) {
    const random = seededRandom(seed);
    const actual = createRunStore((flush) => flush());
    const expected = createRunStore((flush) => flush());
    for (let index = 0; index < 10_000; index++) {
      if (random() < 0.55) {
        const event = good(index);
        expect(() => actual.dispatch(event)).not.toThrow();
        expected.dispatch(event);
      } else {
        const { event, replay } = bad(index);
        expect(() => actual.dispatch(event as RunEvent)).not.toThrow();
        if (replay) expected.dispatch(replay);
      }
      expect(actual.getDiagnostics().desynced).toBe(false);
    }
    expect(view(actual)).toEqual(view(expected));
  }
});

const tool = { id: "t", name: "bash", arguments: {} };
const fieldCases: Array<{ event: Record<string, unknown>; fields: Array<[string, unknown]> }> = [
  { event: { type: "run_end", outcome: "unknown", data: {} }, fields: [["type", 1], ["outcome", "wrong"], ["data", 1]] },
  ...["run_start", "turn_start", "turn_end", "message_start", "message_reset"].map((type) => ({ event: { type, data: {} }, fields: [["type", 1], ["data", 1]] as Array<[string, unknown]> })),
  { event: { type: "retry" }, fields: [["type", 1]] },
  { event: { type: "message_delta", message_id: "m", delta: "x", kind: "text" }, fields: [["type", 1], ["message_id", 1], ["delta", 1], ["kind", 1]] },
  { event: { type: "message_block", message_id: "m", block: { type: "text" } }, fields: [["type", 1], ["message_id", 1], ["block", null], ["block.type", 1]] },
  { event: { type: "message_commit", message_id: "m", message: { role: "assistant", content: [] } }, fields: [["type", 1], ["message_id", 1], ["message", null], ["message.role", 1], ["message.content", {}]] },
  ...["tool_start", "tool_input", "tool_output", "tool_end"].map((type) => ({ event: { type, tool_call: structuredClone(tool), ...(type === "tool_input" ? { input: "{}" } : {}), ...(type === "tool_output" ? { output: "ok", replace: true } : {}), ...(type === "tool_end" ? { tool_result: { tool_call_id: "t", content: "ok", is_error: false } } : {}), view: {}, data: {} }, fields: [["type", 1], ["tool_call", null], ["tool_call.id", 1], ["tool_call.name", 1], ["tool_call.arguments", null], ...(type === "tool_input" ? [["input", 1] as [string, unknown]] : []), ...(type === "tool_output" ? [["output", 1], ["replace", "wrong"]] as Array<[string, unknown]> : []), ...(type === "tool_end" ? [["tool_result", 1], ["tool_result.tool_call_id", 1], ["tool_result.content", 1], ["tool_result.is_error", "wrong"], ["tool_result.is_canceled", "wrong"], ["tool_result.truncated", "wrong"]] as Array<[string, unknown]> : []), ["view", 1], ["data", 1]] as Array<[string, unknown]> })),
  { event: { type: "approval_request", request_id: "r", tool_call: structuredClone(tool), delegated: false, view: {} }, fields: [["type", 1], ["request_id", 1], ["tool_call.id", 1], ["tool_call.name", 1], ["tool_call.arguments", null], ["delegated", "wrong"], ["view", 1], ["state", "wrong"], ["status", 1], ["disabled_reason", 1]] },
  { event: { type: "approval_end", request_id: "r", decision: "approve", data: {} }, fields: [["type", 1], ["request_id", 1], ["decision", "wrong"], ["data", 1]] },
  { event: { type: "usage", usage: { input: 1 } }, fields: [["type", 1], ["usage", null], ["usage.input", Number.NaN]] },
  { event: { type: "user_message", text: "x", mode: "send", attachments: [], message_id: "m", delivery_id: "d", intent: "i", text_omitted: true, delivery_status: "delivered", delivery_reason: "turn_end" }, fields: [["type", 1], ["text", 1], ["mode", 1], ["attachments", {}], ["message_id", 1], ["delivery_id", 1], ["intent", 1], ["text_omitted", false], ["delivery_status", "wrong"], ["delivery_reason", 1]] },
  { event: { type: "delivery_status", delivery_id: "d", method: "steer", status: "dropped", content: "steer dropped: turn_end", reason: "turn_end" }, fields: [["type", 1], ["delivery_id", 1], ["method", 1], ["status", "wrong"], ["content", 1], ["reason", 1]] },
  { event: { type: "history_truncated", text: "notice" }, fields: [["type", 1], ["text", 1]] },
  { event: { type: "error", error: { code: "x", message: "x" } }, fields: [["type", 1], ["error", null], ["error.code", 1], ["error.message", 1]] },
  { event: { type: "notification", notification_id: "n", data: {} }, fields: [["type", 1], ["notification_id", 1], ["data", 1]] },
  { event: { type: "unknown", name: "future", data: {} }, fields: [["type", 1], ["name", 1], ["data", 1]] },
  { event: { type: "sub_agent", childRunId: "c", status: "running", name: "worker", task: "task", latestActivity: "work", toolCount: 1, summary: "summary", urgency: "input", notificationId: "n", startedAt: "2026-01-01", updatedAt: "2026-01-02", endedAt: "2026-01-03", sequence: 1 }, fields: [["type", 1], ["childRunId", 1], ["status", "wrong"], ["name", 1], ["task", 1], ["latestActivity", 1], ["toolCount", Number.NaN], ["summary", 1], ["urgency", "wrong"], ["notificationId", 1], ["startedAt", Symbol("wrong")], ["updatedAt", 1], ["endedAt", 1], ["sequence", Number.POSITIVE_INFINITY]] },
];
const replacePath = (source: Record<string, unknown>, path: string, value: unknown) => {
  const copy = structuredClone(source);
  const parts = path.split(".");
  let target = copy;
  for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
  target[parts.at(-1)!] = value;
  return copy;
};

const omitPath = (source: Record<string, unknown>, path: string) => {
  const copy = structuredClone(source);
  const parts = path.split(".");
  let target = copy;
  for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
  delete target[parts.at(-1)!];
  return copy;
};
const schemaField = (type: keyof typeof eventSchemas, path: string) => {
  let fields = eventSchemas[type] as unknown as Record<string, { required: boolean; fields?: Record<string, unknown> }>;
  let rule!: { required: boolean; fields?: Record<string, unknown> };
  for (const part of path.split(".")) {
    if (!fields?.[part]) return rule;
    rule = fields[part]!;
    fields = rule.fields as typeof fields;
  }
  return rule;
};

const finish = (start: RunEvent[], end: unknown) => {
  const store = createRunStore((flush) => flush());
  for (const event of start) store.dispatch(event);
  store.dispatch(end as RunEvent);
  return store;
};

const terminalCases: Array<[string, RunEvent[], unknown, (store: ReturnType<typeof createRunStore>) => void]> = [
  ["run_end.data", [{ type: "run_start" }], { type: "run_end", data: 7 }, (store) => expect(store.getState().agent).toBe("idle")],
  ["run_end.outcome", [{ type: "run_start" }], { type: "run_end", outcome: "lost" }, (store) => {
    expect(store.getState().agent).toBe("idle");
    expect(store.getState().endOutcome).toBeUndefined();
  }],
  ["turn_end.data", [{ type: "turn_start" }], { type: "turn_end", data: 7 }, (store) => expect(store.getState().turn).toBe("idle")],
  ["message_commit.message_id", [{ type: "message_delta", message_id: "m", delta: "draft" }], { type: "message_commit", message_id: 7, message: { role: "assistant", content: [{ type: "text", text: "done" }] } }, (store) => {
    expect(store.getState().activeMessageId).toBeUndefined();
    expect(store.getItem("message:m")).toMatchObject({ active: false });
  }],
  ["message_reset.data", [{ type: "message_delta", message_id: "m", delta: "draft" }], { type: "message_reset", data: 7 }, (store) => expect(store.getState().activeMessageId).toBeUndefined()],
  ["tool_end.tool_result.is_canceled", [{ type: "tool_start", tool_call: tool }], { type: "tool_end", tool_call: tool, tool_result: { tool_call_id: "t", content: "ok", is_error: false, is_canceled: "bad" } }, (store) => {
    expect(store.getState().activeToolIds.t).toBeUndefined();
    expect(store.getItem("tool:t")).toMatchObject({ active: false });
  }],
  ["tool_end.view", [{ type: "tool_start", tool_call: tool }], { type: "tool_end", tool_call: tool, view: 7 }, (store) => {
    expect(store.getState().activeToolIds.t).toBeUndefined();
    expect(store.getItem("tool:t")).toMatchObject({ active: false });
  }],
  ["approval_end.decision", [{ type: "tool_start", tool_call: tool }, { type: "approval_request", request_id: "r", tool_call: tool, delegated: false }], { type: "approval_end", request_id: "r", decision: "maybe" }, (store) => {
    expect(store.getState().toolApprovals.t).toBeUndefined();
    expect(store.getItem("tool:t")).toMatchObject({ approval: { type: "approval_end", request_id: "r" } });
  }],
  ["sub_agent.summary", [{ type: "sub_agent", childRunId: "c", status: "running" }], { type: "sub_agent", childRunId: "c", status: "done", summary: 7 }, (store) => expect(store.getItem("sub-agent:c")).toMatchObject({ status: "done" })],
];

test("valid events keep their identity through validation", () => {
  const event: RunEvent = { type: "user_message", text: "same object", mode: "send" };
  const store = createRunStore((flush) => flush());
  store.dispatch(event);
  expect(store.getItem("user:1")).toMatchObject({ event });
  expect((store.getItem("user:1") as { event: RunEvent }).event).toBe(event);
  expect(store.getDiagnostics().sanitizedFields).toBe(0);
});

test.each(terminalCases)("invalid optional %s does not block its terminal transition", (_name, start, end, assertEnded) => {
  const store = finish(start, end);
  assertEnded(store);
  expect(store.getDiagnostics()).toMatchObject({ ignoredEvents: 0, sanitizedFields: 1, desynced: false });
});

test("every field of every known event kind rejects required data or sanitizes optional data", () => {
  expect(new Set(fieldCases.map(({ event }) => event.type))).toEqual(new Set(Object.keys(eventSchemas)));
  for (const { event, fields } of fieldCases) {
    const type = event.type as keyof typeof eventSchemas;
    const testedFields = new Set(fields.filter(([path]) => path !== "type").map(([path]) => path.split(".")[0]));
    expect(testedFields, String(event.type)).toEqual(new Set(Object.keys(eventSchemas[type])));
    for (const [path, wrong] of fields) {
      const store = createRunStore((flush) => flush());
      const invalid = path === "type" ? { ...event, type: wrong } : replacePath(event, path, wrong);
      expect(() => store.dispatch(invalid as RunEvent)).not.toThrow();
      const required = path === "type" || schemaField(type, path).required;
      if (required) {
        expect(store.getDiagnostics(), `${String(event.type)}.${path}`).toEqual({ ignoredEvents: 1, sanitizedFields: 0, desynced: false });
        expect(store.getState(), `${String(event.type)}.${path}`).toEqual(initialState);
        expect(store.getOutline()).toEqual([]);
      } else {
        const expected = createRunStore((flush) => flush());
        expected.dispatch(omitPath(event, path) as RunEvent);
        expect(store.getDiagnostics(), `${String(event.type)}.${path}`).toEqual({ ignoredEvents: 0, sanitizedFields: 1, desynced: false });
        expect(view(store), `${String(event.type)}.${path}`).toEqual(view(expected));
      }
    }
  }
});
