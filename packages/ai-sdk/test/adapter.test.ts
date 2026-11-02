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

test("commits source and file parts without losing their typed fields", () => {
  const adapter = createAiSdkAdapter();
  adapter.decode({ type: "start", messageId: "assets" });
  adapter.decode({ type: "source-url", sourceId: "source-1", url: "https://example.com", title: "Example", providerMetadata: { mock: { rank: 1 } } });
  adapter.decode({ type: "source-document", sourceId: "source-2", mediaType: "application/pdf", title: "Guide", filename: "guide.pdf" });
  adapter.decode({ type: "file", url: "data:image/png;base64,eA==", mediaType: "image/png" });
  const commit = adapter.decode({ type: "finish" }).find((event) => event.type === "message_commit");
  expect(commit?.type === "message_commit" ? commit.message.content : undefined).toEqual([
    { type: "source", kind: "source", url: "https://example.com", title: "Example", meta: { sourceId: "source-1", providerMetadata: [{ mock: { rank: 1 } }] } },
    { type: "source", kind: "source", mediaType: "application/pdf", title: "Guide", filename: "guide.pdf", meta: { sourceId: "source-2" } },
    { type: "file", kind: "file", url: "data:image/png;base64,eA==", mediaType: "image/png" },
  ]);
});

test("preserves block and tool protocol metadata in generic meta bags", () => {
  const adapter = createAiSdkAdapter();
  adapter.decode({ type: "start", messageId: "meta" });
  adapter.decode({ type: "text-start", id: "text", providerMetadata: { mock: { trace: "t" } } });
  adapter.decode({ type: "text-delta", id: "text", delta: "hello", providerMetadata: { mock: { trace: "delta" } } });
  const [tool] = adapter.decode({ type: "tool-input-available", toolCallId: "call", toolName: "search", input: {}, providerExecuted: true, dynamic: true, title: "Search", providerMetadata: { mock: { trace: "tool" } } });
  expect(tool?.type === "tool_start" ? tool.tool_call.meta : undefined).toEqual({ providerExecuted: true, dynamic: true, title: "Search", providerMetadata: [{ mock: { trace: "tool" } }] });
  const commit = adapter.decode({ type: "finish" }).find((event) => event.type === "message_commit");
  expect(commit?.type === "message_commit" ? commit.message.content[0]?.meta : undefined).toEqual({ providerMetadata: [{ mock: { trace: "t" } }, { mock: { trace: "delta" } }] });
});
