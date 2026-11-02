import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runAdapterConformance, type AdapterFixture } from "@fulcrum/adapter-test";
import { createAiSdkAdapter } from "../src/index.js";

const fixtures = readFileSync(new URL("./fixtures/conformance.jsonl", import.meta.url), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line) as AdapterFixture);

test("AI SDK UI message stream conforms to generic run events", () => {
  expect(runAdapterConformance({
    name: "ai-sdk",
    fixtures,
    capabilities: { approval: true, reasoning: true, reset: false, usage: true },
    create: () => {
      const adapter = createAiSdkAdapter();
      return { decode: (value) => adapter.decode((value as { part: unknown }).part) };
    },
  })).toEqual([]);
});

test("malformed parts never throw", () => {
  const adapter = createAiSdkAdapter();
  for (const value of [null, [], {}, { type: 1 }, { type: "tool-input-start" }]) {
    expect(() => adapter.decode(value)).not.toThrow();
    expect(adapter.decode(value)[0]?.type).toBe("error");
  }
});

test("text-encoded tool input remains available to generic tool views", () => {
  const adapter = createAiSdkAdapter();
  adapter.decode({ type: "tool-input-start", toolCallId: "raw", toolName: "code", inputEncoding: "text" });
  const [event] = adapter.decode({ type: "tool-input-available", toolCallId: "raw", toolName: "code", input: "console.log(1)" });
  expect(event?.type === "tool_start" ? event.tool_call.arguments : undefined).toEqual({ input: "console.log(1)" });
});

test("preliminary tool output keeps the tool active", () => {
  const adapter = createAiSdkAdapter();
  adapter.decode({ type: "tool-input-available", toolCallId: "tool", toolName: "search", input: {} });
  expect(adapter.decode({ type: "tool-output-available", toolCallId: "tool", output: "first", preliminary: true }).map(({ type }) => type)).toEqual(["tool_output"]);
  expect(adapter.decode({ type: "tool-output-available", toolCallId: "tool", output: "final" }).map(({ type }) => type)).toEqual(["tool_output", "tool_end"]);
});
