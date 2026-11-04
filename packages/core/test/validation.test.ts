import { expect, test } from "bun:test";
import { createRunStore, initialState, type RunEvent } from "../src/index.js";
import { eventSchemas } from "../src/reducer.js";

const seeds = [11, 29, 101, 2027, 65537];
const rng = (seed: number) => () => ((seed = Math.imul(seed ^ seed >>> 15, 1 | seed), seed ^= seed + Math.imul(seed ^ seed >>> 7, 61 | seed)), ((seed ^ seed >>> 14) >>> 0) / 4294967296);
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
    case 8: return { type: "user_message", text: `u${index}`, mode: "send", delivery_id: `d${index}`, intent: `i${index % 37}` };
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
    case 8: return { event: { type: "sub_agent", childRunId: "bad", status: "running", startedAt: 3 } };
    case 9: return { event: { type: "sub_agent", childRunId: "bad-seq", status: "running", sequence: Number.NaN } };
    case 10: return { event: { type: "user_message", text: "x", mode: "send", delivery_id: Number.NaN } };
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

test("malformed event fuzz is total and equals a valid-only replay", () => {
  for (const seed of seeds) {
    const random = rng(seed);
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
  ...["run_start", "run_end", "turn_start", "turn_end", "message_start", "message_reset"].map((type) => ({ event: { type, data: {} }, fields: [["type", 1], ["data", 1]] as Array<[string, unknown]> })),
  { event: { type: "retry" }, fields: [["type", 1]] },
  { event: { type: "message_delta", message_id: "m", delta: "x", kind: "text" }, fields: [["type", 1], ["message_id", 1], ["delta", 1], ["kind", 1]] },
  { event: { type: "message_block", message_id: "m", block: { type: "text" } }, fields: [["type", 1], ["message_id", 1], ["block", null], ["block.type", 1]] },
  { event: { type: "message_commit", message_id: "m", message: { role: "assistant", content: [] } }, fields: [["type", 1], ["message_id", 1], ["message", null], ["message.role", 1], ["message.content", {}]] },
  ...["tool_start", "tool_input", "tool_output", "tool_end"].map((type) => ({ event: { type, tool_call: structuredClone(tool), ...(type === "tool_input" ? { input: "{}" } : {}), ...(type === "tool_output" ? { output: "ok" } : {}), ...(type === "tool_end" ? { tool_result: { tool_call_id: "t", content: "ok", is_error: false } } : {}), view: {}, data: {} }, fields: [["type", 1], ["tool_call", null], ["tool_call.id", 1], ["tool_call.name", 1], ["tool_call.arguments", null], ...(type === "tool_input" ? [["input", 1] as [string, unknown]] : []), ...(type === "tool_output" ? [["output", 1] as [string, unknown]] : []), ...(type === "tool_end" ? [["tool_result", 1], ["tool_result.tool_call_id", 1], ["tool_result.content", 1], ["tool_result.is_error", "wrong"], ["tool_result.is_canceled", "wrong"]] as Array<[string, unknown]> : []), ["view", 1], ["data", 1]] as Array<[string, unknown]> })),
  { event: { type: "approval_request", request_id: "r", tool_call: structuredClone(tool), delegated: false, view: {} }, fields: [["type", 1], ["request_id", 1], ["tool_call.id", 1], ["tool_call.name", 1], ["tool_call.arguments", null], ["delegated", "wrong"], ["view", 1]] },
  { event: { type: "approval_end", request_id: "r", decision: "approve", data: {} }, fields: [["type", 1], ["request_id", 1], ["decision", "wrong"], ["data", 1]] },
  { event: { type: "usage", usage: { input: 1 } }, fields: [["type", 1], ["usage", null], ["usage.input", Number.NaN]] },
  { event: { type: "user_message", text: "x", mode: "send", attachments: [], delivery_id: "d", intent: "i" }, fields: [["type", 1], ["text", 1], ["mode", 1], ["attachments", {}], ["delivery_id", 1], ["intent", 1]] },
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

test("every field of every known event kind rejects a wrong type", () => {
  expect(new Set(fieldCases.map(({ event }) => event.type))).toEqual(new Set(Object.keys(eventSchemas)));
  for (const { event, fields } of fieldCases) {
    const testedFields = new Set(fields.filter(([path]) => path !== "type").map(([path]) => path.split(".")[0]));
    expect(testedFields, String(event.type)).toEqual(new Set(Object.keys(eventSchemas[event.type as keyof typeof eventSchemas])));
    for (const [path, wrong] of fields) {
      const store = createRunStore((flush) => flush());
      const invalid = path === "type" ? { ...event, type: wrong } : replacePath(event, path, wrong);
      expect(() => store.dispatch(invalid as RunEvent)).not.toThrow();
      expect(store.getDiagnostics(), `${String(event.type)}.${path}`).toEqual({ ignoredEvents: 1, desynced: false });
      expect(store.getState(), `${String(event.type)}.${path}`).toEqual(initialState);
      expect(store.getOutline()).toEqual([]);
    }
  }
});
