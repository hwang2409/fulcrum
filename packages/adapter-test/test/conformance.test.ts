import { expect, test } from "bun:test";
import type { RunEvent } from "@fulcrum/core";
import { runAdapterConformance, type AdapterConformanceOptions, type AdapterFixture } from "../src/index.js";

const fixture = (scenario: AdapterFixture["scenario"]): AdapterFixture => ({ scenario, sessionId: scenario });
const requiredFixtures = [
  "text", "tool", "tool-error", "reset-retry-abort", "unknown-malformed", "sessions", "replay",
] as const;
const options = (decode: (value: unknown) => RunEvent[]): AdapterConformanceOptions => ({
  name: "mutant",
  fixtures: requiredFixtures.map(fixture),
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

test("usage capability rejects an empty usage object", () => {
  const configured = options((value) => (value as AdapterFixture).scenario === "usage"
    ? [{ type: "usage", usage: {} }]
    : []);
  configured.capabilities = { ...configured.capabilities, usage: true };
  configured.fixtures = [...configured.fixtures, fixture("usage")];
  expect(runAdapterConformance(configured)).toContain("usage: numeric usage is missing");
});
