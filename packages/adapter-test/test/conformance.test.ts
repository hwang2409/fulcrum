import { expect, test } from "bun:test";
import type { RunEvent } from "@fulcrum/core";
import { runAdapterConformance, type AdapterConformanceOptions, type AdapterFixture } from "../src/index.js";

const fixture = (scenario: AdapterFixture["scenario"]): AdapterFixture => ({ scenario, sessionId: scenario });
const requiredFixtures = [
  "text", "tool", "tool-error", "reset-retry-abort", "unknown-malformed", "sessions", "replay",
] as const;
const adversarialFixtures: AdapterFixture[] = [
  { scenario: "adversarial-ids", sessionId: "a", contentMarker: "synthetic-a" },
  { scenario: "adversarial-ids", sessionId: "a", contentMarker: "wire-b" },
  { scenario: "adversarial-ids", sessionId: "b", contentMarker: "synthetic-b" },
  { scenario: "adversarial-ids", sessionId: "b", contentMarker: "wire-a" },
];
const streamFixtures: AdapterFixture[] = [
  { scenario: "streams", sessionId: "alpha", contentMarker: "alpha" },
  { scenario: "streams", sessionId: "beta", contentMarker: "beta" },
];
const options = (decode: (value: unknown) => RunEvent[]): AdapterConformanceOptions => ({
  name: "mutant",
  fixtures: [...requiredFixtures.map(fixture), ...streamFixtures, ...adversarialFixtures],
  create: () => ({ decode }),
  capabilities: { approval: false, reasoning: false, reset: false, usage: false },
});

test("rejects empty message identities", () => {
  const failures = runAdapterConformance(options((value) => (value as AdapterFixture).scenario === "replay"
    ? [{ type: "message_commit", message: { role: "assistant", content: [] } }]
    : []));
  expect(failures).toContain("replay: event identity must be nonempty");
});

test("replays into one store so missing ids cannot duplicate messages", () => {
  const failures = runAdapterConformance(options((value) => (value as AdapterFixture).scenario === "replay"
    ? [{ type: "message_commit", message: { role: "assistant", content: [] } }]
    : []));
  expect(failures).toContain("replay: reconnect replay changed outline membership");
});

test("rejects colliding ids from independent streams in one run", () => {
  const failures = runAdapterConformance(options((value) => (value as AdapterFixture).scenario === "streams"
    ? [{ type: "message_commit", message_id: "same", message: { role: "assistant", content: [{ type: "text", text: (value as AdapterFixture).contentMarker }] } }]
    : []));
  expect(failures).toContain("streams: independent streams must commit distinct message ids");
});

test("rejects collisions between wire-looking and synthetic-looking ids", () => {
  const failures = runAdapterConformance(options((value) => {
    const fixture = value as AdapterFixture;
    if (fixture.scenario !== "adversarial-ids") return [];
    const collision = fixture.contentMarker === "synthetic-a" || fixture.contentMarker === "wire-a" ? "a" : "b";
    return [{ type: "message_commit", message_id: collision, message: { role: "assistant", content: [{ type: "text", text: fixture.contentMarker }] } }];
  }));
  expect(failures).toContain("adversarial-ids: wire and synthetic ids must stay distinct");
  expect(failures).toContain("adversarial-ids: content marker synthetic-a was lost");
});

test("false capabilities reject feature events from any scenario", () => {
  const configured = options((value) => {
    if ((value as AdapterFixture).scenario !== "text") return [];
    return [
      { type: "message_delta", message_id: "reasoning", delta: "thinking", kind: "reasoning" },
      { type: "approval_request", request_id: "approval", tool_call: { id: "tool", name: "deploy", arguments: {} }, delegated: false },
      { type: "message_reset" },
      { type: "usage", usage: { inputTokens: 1 } },
      { type: "message_delta", message_id: "text", delta: "hello", kind: "assistant" },
      { type: "message_commit", message_id: "text", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
    ] satisfies RunEvent[];
  });
  const failures = runAdapterConformance(configured);
  expect(failures).toContain("reasoning: emitted while capability is false");
  expect(failures).toContain("approval: emitted while capability is false");
  expect(failures).toContain("reset: emitted while capability is false");
  expect(failures).toContain("usage: emitted while capability is false");
});

test("usage capability rejects an empty usage object", () => {
  const configured = options((value) => (value as AdapterFixture).scenario === "usage"
    ? [{ type: "usage", usage: {} }]
    : []);
  configured.capabilities = { ...configured.capabilities, usage: true };
  configured.fixtures = [...configured.fixtures, fixture("usage")];
  expect(runAdapterConformance(configured)).toContain("usage: numeric usage is missing");
});
