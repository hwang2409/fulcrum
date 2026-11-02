import { expect, test } from "bun:test";
import { runAdapterConformance, type AdapterFixture, type AdapterScenario } from "@fulcrum/adapter-test";
import { fromZetaEvent } from "../src/index.js";

const row = (scenario: AdapterScenario, sessionId: string, part: unknown): AdapterFixture => ({ scenario, sessionId, part });
const event = (sessionId: string, name: string, rest: Record<string, unknown> = {}) => ({ event: name, session_id: sessionId, data: {}, ...rest });
const fixtures: AdapterFixture[] = [
  row("text", "text", event("text", "assistant_delta", { delta: "hello", kind: "assistant", data: { message_id: "message-1" } })),
  row("text", "text", event("text", "assistant_message", { message: { role: "assistant", content: [{ type: "text", text: "hello" }] }, data: { message_id: "message-1" } })),
  row("reasoning", "reasoning", event("reasoning", "assistant_delta", { delta: "check evidence", kind: "thinking", data: { message_id: "reasoning-1" } })),
  row("reasoning", "reasoning", event("reasoning", "assistant_message", { message: { role: "assistant", content: [{ type: "thinking", text: "check evidence" }] }, data: { message_id: "reasoning-1" } })),
  row("tool", "tool", event("tool", "tool_start", { tool_call: { id: "call-1", name: "weather", arguments: { city: "SF" } } })),
  row("tool", "tool", event("tool", "tool_output", { tool_call: { id: "call-1", name: "weather", arguments: { city: "SF" } }, output: "sunny" })),
  row("tool", "tool", event("tool", "tool_end", { tool_call: { id: "call-1", name: "weather", arguments: { city: "SF" } }, tool_result: { tool_call_id: "call-1", content: "sunny", is_error: false } })),
  row("tool-error", "tool-error", event("tool-error", "tool_end", { tool_call: { id: "call-error", name: "shell", arguments: { command: "false" } }, tool_result: { tool_call_id: "call-error", content: "exit 1", is_error: true } })),
  row("approval", "approval", event("approval", "approval_request", { request_id: "approval-1", tool_call: { id: "call-approval", name: "deploy", arguments: { target: "production" } }, delegated: false })),
  row("approval", "approval", event("approval", "approval_end", { request_id: "approval-1" })),
  row("reset-retry-abort", "recovery", event("recovery", "assistant_reset")),
  row("reset-retry-abort", "recovery", event("recovery", "retry")),
  row("reset-retry-abort", "recovery", event("recovery", "turn_aborted", { message: "user cancelled" })),
  row("usage", "usage", event("usage", "usage", { usage: { inputTokens: 12, outputTokens: 4 } })),
  row("unknown-malformed", "unknown", event("unknown", "future_event", { future: true })),
  row("unknown-malformed", "unknown", null),
  row("sessions", "alpha", event("alpha", "assistant_delta", { delta: "alpha", kind: "assistant", data: { message_id: "alpha-message" } })),
  row("sessions", "beta", event("beta", "assistant_delta", { delta: "beta", kind: "assistant", data: { message_id: "beta-message" } })),
  { ...row("streams", "stream-alpha", event("stream-alpha", "assistant_message", { message: { role: "assistant", content: [{ type: "text", text: "stream-alpha" }] }, data: { message_id: "stream-alpha-message" } })), contentMarker: "stream-alpha" },
  { ...row("streams", "stream-beta", event("stream-beta", "assistant_message", { message: { role: "assistant", content: [{ type: "text", text: "stream-beta" }] }, data: { message_id: "stream-beta-message" } })), contentMarker: "stream-beta" },
  row("replay", "replay", event("replay", "assistant_message", { message: { role: "assistant", content: [{ type: "text", text: "stable" }] }, data: { message_id: "stable-message" } })),
];

test("zeta passes the harness-neutral adapter contract", () => {
  expect(runAdapterConformance({
    name: "zeta",
    fixtures,
    capabilities: { approval: true, reasoning: true, reset: true, usage: true },
    create: () => ({ decode: (value) => fromZetaEvent((value as { part: unknown }).part) }),
  })).toEqual([]);
});
