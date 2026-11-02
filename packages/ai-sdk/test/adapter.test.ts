import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runAdapterConformance, type AdapterFixture } from "@fulcrum/adapter-test";
import { createRunStore } from "@fulcrum/core";
import { createAiSdkAdapter } from "../src/index.js";

const fixtures = readFileSync(new URL("./fixtures/conformance.jsonl", import.meta.url), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line) as AdapterFixture);

test("AI SDK UI message stream conforms to generic run events", () => {
  expect(runAdapterConformance({
    name: "ai-sdk",
    fixtures,
    capabilities: { approval: true, reasoning: true, reset: false, usage: true },
    create: (streamKey) => {
      const adapter = createAiSdkAdapter({ streamKey });
      return { decode: (value) => adapter.decode((value as { part: unknown }).part) };
    },
  })).toEqual([]);
});

test("writer-only source and file streams commit content with a stable synthetic id", () => {
  const parts = fixtures.filter((fixture) => fixture.sessionId === "writer-assets").map((fixture) => fixture.part);
  const decode = () => {
    const adapter = createAiSdkAdapter({ streamKey: "writer-assets" });
    return parts.flatMap((part) => adapter.decode(part));
  };
  const first = decode().find((event) => event.type === "message_commit");
  const second = decode().find((event) => event.type === "message_commit");
  expect(first?.type === "message_commit" ? first.message.content : undefined).toEqual([
    { type: "source", kind: "source", url: "https://example.com/writer", title: "Writer source", meta: { sourceId: "writer-source" } },
    { type: "file", kind: "file", url: "data:text/plain;base64,aGk=", mediaType: "text/plain" },
  ]);
  expect(first?.type === "message_commit" ? first.message_id : undefined).toBe(second?.type === "message_commit" ? second.message_id : undefined);
});

test("two writer-only streams keep distinct replay-stable messages in one run", () => {
  const parts = (marker: string) => [
    { type: "source-url", sourceId: marker, url: `https://example.com/${marker}` },
    { type: "finish", finishReason: "stop" },
  ];
  const decode = (streamKey: string, marker: string) => {
    const adapter = createAiSdkAdapter({ streamKey });
    return parts(marker).flatMap((part) => adapter.decode(part));
  };
  const first = [decode("request-alpha", "first"), decode("request-beta", "second")];
  const store = createRunStore(() => {});
  for (const event of first.flat()) store.dispatch(event);
  expect(store.getOutline()).toHaveLength(2);
  expect(store.getOutline().map(({ id }) => id)).toEqual([
    "message:ai-sdk:request-alpha:message-1",
    "message:ai-sdk:request-beta:message-1",
  ]);
  expect(store.getOutline().map(({ id }) => JSON.stringify(store.getItem(id)))).toEqual([
    expect.stringContaining("first"),
    expect.stringContaining("second"),
  ]);
  expect(decode("request-alpha", "first")).toEqual(first[0]);
  expect(decode("request-beta", "second")).toEqual(first[1]);
});

test("scopes part, tool, and approval ids to their stream", () => {
  const ids = (streamKey: string) => {
    const adapter = createAiSdkAdapter({ streamKey });
    adapter.decode({ type: "text-start", id: "same" });
    const message = adapter.decode({ type: "text-delta", id: "same", delta: "x" });
    const tool = adapter.decode({ type: "tool-input-available", toolCallId: "same", toolName: "deploy", input: {} });
    const approval = adapter.decode({ type: "tool-approval-request", toolCallId: "same", approvalId: "same" });
    return [message[0], tool[0], approval[0]].map((event) => event?.type === "message_delta" ? event.message_id
      : event?.type === "tool_start" ? event.tool_call.id
      : event?.type === "approval_request" ? event.request_id : undefined);
  };
  expect(ids("alpha")).toEqual(["ai-sdk:alpha:part-same", "ai-sdk:alpha:tool-same", "ai-sdk:alpha:approval-same"]);
  expect(ids("beta")).toEqual(["ai-sdk:beta:part-same", "ai-sdk:beta:tool-same", "ai-sdk:beta:approval-same"]);
  expect(ids("alpha")).toEqual(ids("alpha"));
});

test("malformed parts never throw", () => {
  const adapter = createAiSdkAdapter({ streamKey: "malformed" });
  for (const value of [null, [], {}, { type: 1 }, { type: "tool-input-start" }]) {
    expect(() => adapter.decode(value)).not.toThrow();
    expect(adapter.decode(value)[0]?.type).toBe("error");
  }
});

test("text-encoded tool input remains available to generic tool views", () => {
  const adapter = createAiSdkAdapter({ streamKey: "test" });
  adapter.decode({ type: "tool-input-start", toolCallId: "raw", toolName: "code", inputEncoding: "text" });
  const [event] = adapter.decode({ type: "tool-input-available", toolCallId: "raw", toolName: "code", input: "console.log(1)" });
  expect(event?.type === "tool_start" ? event.tool_call.arguments : undefined).toEqual({ input: "console.log(1)" });
});

test("preliminary tool output keeps the tool active", () => {
  const adapter = createAiSdkAdapter({ streamKey: "test" });
  adapter.decode({ type: "tool-input-available", toolCallId: "tool", toolName: "search", input: {} });
  expect(adapter.decode({ type: "tool-output-available", toolCallId: "tool", output: "first", preliminary: true }).map(({ type }) => type)).toEqual(["tool_output"]);
  expect(adapter.decode({ type: "tool-output-available", toolCallId: "tool", output: "final" }).map(({ type }) => type)).toEqual(["tool_output", "tool_end"]);
});

test("commits source and file parts without losing their typed fields", () => {
  const adapter = createAiSdkAdapter({ streamKey: "test" });
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
  const adapter = createAiSdkAdapter({ streamKey: "test" });
  adapter.decode({ type: "start", messageId: "meta" });
  adapter.decode({ type: "text-start", id: "text", providerMetadata: { mock: { trace: "t" } } });
  adapter.decode({ type: "text-delta", id: "text", delta: "hello", providerMetadata: { mock: { trace: "delta" } } });
  const [tool] = adapter.decode({ type: "tool-input-available", toolCallId: "call", toolName: "search", input: {}, providerExecuted: true, dynamic: true, title: "Search", providerMetadata: { mock: { trace: "tool" } } });
  expect(tool?.type === "tool_start" ? tool.tool_call.meta : undefined).toEqual({ providerExecuted: true, dynamic: true, title: "Search", providerMetadata: [{ mock: { trace: "tool" } }] });
  const commit = adapter.decode({ type: "finish" }).find((event) => event.type === "message_commit");
  expect(commit?.type === "message_commit" ? commit.message.content[0]?.meta : undefined).toEqual({ providerMetadata: [{ mock: { trace: "t" } }, { mock: { trace: "delta" } }] });
});
