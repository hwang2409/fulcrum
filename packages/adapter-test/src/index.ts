import { createRunStore, type RunEvent, type RunItem } from "@fulcrum/core";

export const canonicalScenarios = [
  "text", "reasoning", "tool", "tool-error", "approval",
  "reset-retry-abort", "usage", "unknown-malformed", "sessions", "replay",
] as const;
export type AdapterScenario = (typeof canonicalScenarios)[number];
export interface AdapterFixture {
  scenario: AdapterScenario;
  sessionId: string;
  [key: string]: unknown;
}
export interface AdapterConformanceOptions {
  name: string;
  fixtures: readonly AdapterFixture[];
  create(): { decode(value: unknown): RunEvent[] };
  capabilities?: { approval?: boolean };
}

const identity = (event: RunEvent) => {
  switch (event.type) {
    case "message_delta": case "message_commit": return `message:${event.message_id ?? ""}`;
    case "tool_start": case "tool_input": case "tool_output": case "tool_end": return `tool:${event.tool_call.id}`;
    case "approval_request": case "approval_end": return `approval:${event.request_id}`;
    default: return event.type;
  }
};
const messageText = (item: RunItem) => item.type === "message"
  ? item.message.content.filter((part) => part.type === "text").map((part) => String(part.text ?? "")).join("") || item.text || ""
  : "";
const has = (events: readonly RunEvent[], type: RunEvent["type"]) => events.some((event) => event.type === type);

/** Runs Fulcrum-owned behavioral scenarios without depending on a test framework. */
export function runAdapterConformance(options: AdapterConformanceOptions): string[] {
  const failures: string[] = [];
  const fixtureScenarios = new Set(options.fixtures.map(({ scenario }) => scenario));
  for (const scenario of canonicalScenarios)
    if (scenario !== "approval" || options.capabilities?.approval !== false)
      if (!fixtureScenarios.has(scenario)) failures.push(`${scenario}: fixture is missing`);

  const run = (fixtures: readonly AdapterFixture[]) => {
    const adapters = new Map<string, ReturnType<AdapterConformanceOptions["create"]>>();
    const stores = new Map<string, ReturnType<typeof createRunStore>>();
    const events: RunEvent[] = [];
    for (const fixture of fixtures) {
      const adapter = adapters.get(fixture.sessionId) ?? options.create();
      adapters.set(fixture.sessionId, adapter);
      const store = stores.get(fixture.sessionId) ?? createRunStore(() => {});
      stores.set(fixture.sessionId, store);
      try {
        for (const event of adapter.decode(fixture)) { events.push(event); store.dispatch(event); }
      } catch (error) {
        failures.push(`${fixture.scenario}: decode threw ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { events, stores };
  };
  const scenario = (name: AdapterScenario) => run(options.fixtures.filter((fixture) => fixture.scenario === name));
  const require = (ok: boolean, name: AdapterScenario, message: string) => { if (!ok) failures.push(`${name}: ${message}`); };

  const text = scenario("text");
  require(has(text.events, "message_delta") && has(text.events, "message_commit"), "text", "must stream and commit text");
  require([...text.stores.values()].some((store) => store.getOutline().some(({ id }) => messageText(store.getItem(id)!).includes("hello"))), "text", "committed text was lost");

  const reasoning = scenario("reasoning");
  require(reasoning.events.some((event) => event.type === "message_delta" && (event.kind === "reasoning" || event.kind === "thinking")), "reasoning", "reasoning delta was not preserved");
  require(reasoning.events.some((event) => event.type === "message_commit" && event.message.content.some((part) => part.type === "reasoning" || part.type === "thinking")), "reasoning", "reasoning commit was not preserved");

  const tool = scenario("tool").events;
  require(has(tool, "tool_start") && has(tool, "tool_output") && has(tool, "tool_end"), "tool", "tool lifecycle is incomplete");
  require(tool.some((event) => event.type === "tool_input") || tool.some((event) => event.type === "tool_start" && Object.keys(event.tool_call.arguments).length > 0), "tool", "streamed or complete tool arguments are missing");
  require(tool.some((event) => event.type === "tool_end" && !event.tool_result?.is_error), "tool", "successful tool end is missing");
  require(scenario("tool-error").events.some((event) => event.type === "tool_end" && event.tool_result?.is_error), "tool-error", "tool error is missing");

  if (options.capabilities?.approval !== false) {
    const approval = scenario("approval").events;
    require(has(approval, "approval_request") && has(approval, "approval_end"), "approval", "approval lifecycle is incomplete");
  }
  const recovery = scenario("reset-retry-abort").events;
  require(has(recovery, "message_reset") && has(recovery, "retry"), "reset-retry-abort", "reset or retry is missing");
  require(recovery.some((event) => event.type === "error" && /abort|cancel/i.test(`${event.error.code} ${event.error.message}`)), "reset-retry-abort", "abort is missing");
  require(scenario("usage").events.some((event) => event.type === "usage" && Object.values(event.usage).every(Number.isFinite)), "usage", "numeric usage is missing");
  const invalid = scenario("unknown-malformed").events;
  require(has(invalid, "unknown") && invalid.some((event) => event.type === "error" && event.error.code === "adapter_invalid_payload"), "unknown-malformed", "unknown data or malformed-input error is missing");

  const sessions = scenario("sessions").stores;
  require(sessions.size >= 2, "sessions", "two sessions were not isolated");
  if (sessions.size >= 2) {
    const contents = [...sessions.values()].map((store) => store.getOutline().map(({ id }) => messageText(store.getItem(id)!)).join(""));
    require(contents.some((value) => value.includes("alpha")) && contents.some((value) => value.includes("beta")) && contents.every((value) => !(value.includes("alpha") && value.includes("beta"))), "sessions", "session content leaked");
  }

  const replayFixtures = options.fixtures.filter((fixture) => fixture.scenario === "replay");
  const first = run(replayFixtures).events.map(identity).filter((id) => /^(message|tool|approval):/.test(id));
  const second = run(replayFixtures).events.map(identity).filter((id) => /^(message|tool|approval):/.test(id));
  require(first.length > 0 && JSON.stringify(first) === JSON.stringify(second), "replay", "ids changed across reconnect replay");
  return failures;
}
