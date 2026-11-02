import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runAdapterConformance, type AdapterFixture } from "@fulcrum/adapter-test";
import { createRunStore } from "@fulcrum/core";
import { simulateReadableStream, streamText, type UIMessageChunk } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createAiSdkAdapter, decodeAiSdkEntityId, encodeAiSdkEntityId, type AiSdkEntityIdentity } from "../src/index.js";

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
    "message:s:message:request-alpha:1",
    "message:s:message:request-beta:1",
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
  expect(ids("alpha")).toEqual(["s:message:alpha:1", "w:tool:same", "w:approval:same"]);
  expect(ids("beta")).toEqual(["s:message:beta:1", "w:tool:same", "w:approval:same"]);
  expect(ids("alpha")).toEqual(ids("alpha"));
});

test("entity id encoding is injective and reversible", () => {
  let seed = 0x5eed;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const alphabet = [":", "%", "w:", "s:", "雪", "🙂", "a", "0", " "];
    return Array.from({ length: 1 + seed % 12 }, () => alphabet[(seed = (seed * 1664525 + 1013904223) >>> 0) % alphabet.length]).join("");
  };
  const values = ["", " ", "\t\n", ":", "%", "w:", "s:", "unicode-雪🙂", ...Array.from({ length: 200 }, random)];
  const identities: AiSdkEntityIdentity[] = [];
  for (const kind of ["message", "tool", "approval"] as const) {
    for (const value of values) identities.push({ source: "wire", kind, id: value });
    for (const streamKey of values.filter((value) => value.trim())) identities.push({ source: "synthetic", kind, streamKey, counter: 1 }, { source: "synthetic", kind, streamKey, counter: 2 });
  }
  const encoded = identities.map(encodeAiSdkEntityId);
  expect(new Set(encoded).size).toBe(new Set(identities.map((identity) => JSON.stringify(identity))).size);
  expect(encoded.map(decodeAiSdkEntityId)).toEqual(identities);
  for (const empty of ["", " ", "\t\n"]) {
    expect(decodeAiSdkEntityId(encodeAiSdkEntityId({ source: "wire", kind: "message", id: empty }))).toEqual({ source: "wire", kind: "message", id: empty });
    expect(() => encodeAiSdkEntityId({ source: "synthetic", kind: "message", streamKey: empty, counter: 1 })).toThrow();
  }
});

test("pinned AI SDK accepts blank strings in every adapter-read wire field", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["text id", { type: "text-start", id: "" }],
    ["text delta", { type: "text-delta", id: "text", delta: "" }],
    ["reasoning id", { type: "reasoning-start", id: " " }],
    ["reasoning delta", { type: "reasoning-delta", id: "reasoning", delta: "\t\n" }],
    ["source url sourceId", { type: "source-url", sourceId: "", url: "" }],
    ["source url title", { type: "source-url", sourceId: "url", url: "url", title: "" }],
    ["source document sourceId", { type: "source-document", sourceId: " ", mediaType: "" , title: "" }],
    ["source document filename", { type: "source-document", sourceId: "doc", mediaType: "media", title: "title", filename: "" }],
    ["file url and mediaType", { type: "file", url: "", mediaType: "" }],
    ["tool input start ids and name", { type: "tool-input-start", toolCallId: "", toolName: "" }],
    ["tool input delta", { type: "tool-input-delta", toolCallId: "delta", inputTextDelta: "" }],
    ["tool input error fields", { type: "tool-input-error", toolCallId: "error", toolName: "", input: {}, errorText: "" }],
    ["approval ids", { type: "tool-approval-request", toolCallId: "approval", approvalId: "" }],
    ["tool output error", { type: "tool-output-error", toolCallId: "output-error", errorText: "" }],
    ["lifecycle messageId", { type: "start", messageId: "" }],
  ];
  for (const [name, part] of cases) {
    const adapter = createAiSdkAdapter({ streamKey: `blank-${name}` });
    if (part.type === "text-delta") adapter.decode({ type: "text-start", id: part.id });
    if (part.type === "reasoning-delta") adapter.decode({ type: "reasoning-start", id: part.id });
    if (part.type === "tool-input-delta") adapter.decode({ type: "tool-input-start", toolCallId: part.toolCallId, toolName: "tool" });
    expect(adapter.decode(part).some((event) => event.type === "error" && event.error.code === "adapter_invalid_payload"), name).toBe(false);
  }
});

test("blank text and source ids preserve streamed content and sources", () => {
  const adapter = createAiSdkAdapter({ streamKey: "blank-content" });
  const events = [
    { type: "text-start", id: "" },
    { type: "text-delta", id: "", delta: "kept" },
    { type: "text-end", id: "" },
    { type: "source-url", sourceId: "", url: "https://example.com/blank" },
    { type: "source-document", sourceId: " ", mediaType: "text/plain", title: "blank" },
    { type: "finish", finishReason: "stop" },
  ].flatMap((part) => adapter.decode(part));
  const commit = events.find((event) => event.type === "message_commit");
  expect(commit?.type === "message_commit" ? commit.message.content : undefined).toEqual([
    { type: "text", text: "kept" },
    { type: "source", kind: "source", url: "https://example.com/blank", meta: { sourceId: "" } },
    { type: "source", kind: "source", mediaType: "text/plain", title: "blank", meta: { sourceId: " " } },
  ]);
});

test("pinned AI SDK writer ids round trip to their original wire ids", () => {
  const decodeFixture = (sessionId: string) => {
    const adapter = createAiSdkAdapter({ streamKey: sessionId });
    return fixtures.filter((fixture) => fixture.sessionId === sessionId).flatMap((fixture) => adapter.decode(fixture.part));
  };
  const message = decodeFixture("text").find((event) => event.type === "message_commit");
  const tool = decodeFixture("tool").find((event) => event.type === "tool_start");
  const approval = decodeFixture("approval").find((event) => event.type === "approval_request");
  expect(message?.type === "message_commit" ? decodeAiSdkEntityId(message.message_id!) : undefined).toEqual({ source: "wire", kind: "message", id: "message-1" });
  expect(message?.type === "message_commit" ? message.message.metadata : undefined).toEqual({ wireId: "message-1" });
  expect(tool?.type === "tool_start" ? decodeAiSdkEntityId(tool.tool_call.id) : undefined).toEqual({ source: "wire", kind: "tool", id: "call-1" });
  expect(tool?.type === "tool_start" ? tool.tool_call.meta : undefined).toMatchObject({ wireId: "call-1" });
  expect(approval?.type === "approval_request" ? decodeAiSdkEntityId(approval.request_id) : undefined).toEqual({ source: "wire", kind: "approval", id: "approval-1" });
  expect(approval?.type === "approval_request" ? approval.tool_call.meta : undefined).toMatchObject({ wireId: "call-approval", approvalId: "approval-1" });
});

test("pinned AI SDK emits blank message ids without losing identity", async () => {
  for (const messageId of ["", " ", "\t\n"]) {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: [
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: messageId || "content" },
        { type: "text-end", id: "text" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
      ] as never[] }) }),
    });
    const result = streamText({ model, prompt: "fixture" });
    const parts: UIMessageChunk[] = [];
    for await (const part of result.toUIMessageStream({ generateMessageId: () => messageId })) parts.push(part);
    const adapter = createAiSdkAdapter({ streamKey: "blank-message" });
    const commit = parts.flatMap((part) => adapter.decode(part)).find((event) => event.type === "message_commit");
    expect(commit?.type === "message_commit" ? decodeAiSdkEntityId(commit.message_id!) : undefined).toEqual({ source: "wire", kind: "message", id: messageId });
    expect(commit?.type === "message_commit" ? commit.message.metadata : undefined).toEqual({ wireId: messageId });
  }
});

test("pinned AI SDK preserves blank text and source part ids", async () => {
  const model = new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: [
      { type: "text-start", id: "" },
      { type: "text-delta", id: "", delta: "kept" },
      { type: "text-end", id: "" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
    ] as never[] }) }),
  });
  const parts: UIMessageChunk[] = [];
  for await (const part of streamText({ model, prompt: "fixture" }).toUIMessageStream()) parts.push(part);
  const adapter = createAiSdkAdapter({ streamKey: "blank-parts" });
  const events = parts.flatMap((part) => adapter.decode(part));
  expect(events.some((event) => event.type === "error" && event.error.code === "adapter_invalid_payload")).toBe(false);
});

test("blank tool and approval ids survive adapter and outbound decoding", () => {
  const adapter = createAiSdkAdapter({ streamKey: "blank-tool" });
  const [tool] = adapter.decode({ type: "tool-input-available", toolCallId: "", toolName: "deploy", input: {} });
  const [approval] = adapter.decode({ type: "tool-approval-request", toolCallId: "", approvalId: "" });
  expect(tool?.type === "tool_start" ? decodeAiSdkEntityId(tool.tool_call.id) : undefined).toEqual({ source: "wire", kind: "tool", id: "" });
  expect(approval?.type === "approval_request" ? decodeAiSdkEntityId(approval.request_id) : undefined).toEqual({ source: "wire", kind: "approval", id: "" });
  expect(approval?.type === "approval_request" ? approval.tool_call.meta : undefined).toMatchObject({ wireId: "", approvalId: "" });
  const approvalEnd = adapter.decode({ type: "tool-output-denied", toolCallId: "" }).find((event) => event.type === "approval_end");
  expect(approvalEnd?.type === "approval_end" ? decodeAiSdkEntityId(approvalEnd.request_id) : undefined).toEqual({ source: "wire", kind: "approval", id: "" });
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
  expect(tool?.type === "tool_start" ? tool.tool_call.meta : undefined).toEqual({ providerExecuted: true, dynamic: true, title: "Search", providerMetadata: [{ mock: { trace: "tool" } }], wireId: "call" });
  const commit = adapter.decode({ type: "finish" }).find((event) => event.type === "message_commit");
  expect(commit?.type === "message_commit" ? commit.message.content[0]?.meta : undefined).toEqual({ providerMetadata: [{ mock: { trace: "t" } }, { mock: { trace: "delta" } }] });
});
