import { writeFile } from "node:fs/promises";
import { createUIMessageStream, simulateReadableStream, streamText, type UIMessageChunk } from "ai";
import { MockLanguageModelV3 } from "ai/test";

const usage = { inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 4, text: 3, reasoning: 1 } };
const finish = { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage };
const streamStart = { type: "stream-start", warnings: [] };

async function modelParts(messageId: string, chunks: unknown[], withUsage = false): Promise<UIMessageChunk[]> {
  const model = new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: [streamStart, ...chunks, finish] as never[] }) }),
  });
  const result = streamText({ model, prompt: "fixture" });
  const parts: UIMessageChunk[] = [];
  for await (const part of result.toUIMessageStream({
    generateMessageId: () => messageId,
    sendSources: true,
    messageMetadata: withUsage
      ? ({ part }) => part.type === "finish" ? { usage: { inputTokens: part.totalUsage.inputTokens, outputTokens: part.totalUsage.outputTokens } } : undefined
      : undefined,
  })) parts.push(part as UIMessageChunk);
  return parts;
}

async function hostParts(parts: UIMessageChunk[]): Promise<UIMessageChunk[]> {
  const stream = createUIMessageStream({ execute: ({ writer }) => { for (const part of parts) writer.write(part); } });
  const output: UIMessageChunk[] = [];
  for await (const part of stream) output.push(part);
  return output;
}

const rows: Array<{ scenario: string; sessionId: string; part: unknown }> = [];
const add = (scenario: string, sessionId: string, parts: readonly unknown[]) => {
  for (const part of parts) rows.push({ scenario, sessionId, part });
};

add("text", "writer-assets", await hostParts([
  { type: "source-url", sourceId: "writer-source", url: "https://example.com/writer", title: "Writer source" },
  { type: "file", url: "data:text/plain;base64,aGk=", mediaType: "text/plain" },
  { type: "finish", finishReason: "stop" },
]));
add("text", "text", await modelParts("message-1", [
  { type: "text-start", id: "text-1", providerMetadata: { mock: { trace: "text-start" } } },
  { type: "text-delta", id: "text-1", delta: "hello " },
  { type: "text-delta", id: "text-1", delta: "world" },
  { type: "text-end", id: "text-1" },
  { type: "source", sourceType: "url", id: "source-1", url: "https://example.com", title: "Example", providerMetadata: { mock: { rank: 1 } } },
  { type: "source", sourceType: "document", id: "source-2", mediaType: "application/pdf", title: "Guide", filename: "guide.pdf" },
  { type: "file", mediaType: "image/png", data: "eA==" },
]));
add("reasoning", "reasoning", await modelParts("message-reasoning", [
  { type: "reasoning-start", id: "reasoning-1", providerMetadata: { mock: { trace: "reasoning" } } },
  { type: "reasoning-delta", id: "reasoning-1", delta: "check evidence" },
  { type: "reasoning-end", id: "reasoning-1" },
]));
add("tool", "tool", await modelParts("message-tool", [
  { type: "tool-input-start", id: "call-1", toolName: "weather", providerExecuted: true, dynamic: true, title: "Weather", providerMetadata: { mock: { trace: "tool-start" } } },
  { type: "tool-input-delta", id: "call-1", delta: "{\"city\":\"San Francisco\"}" },
  { type: "tool-input-end", id: "call-1" },
  { type: "tool-call", toolCallId: "call-1", toolName: "weather", input: "{\"city\":\"San Francisco\"}", providerExecuted: true, dynamic: true, providerMetadata: { mock: { trace: "tool-call" } } },
  { type: "tool-result", toolCallId: "call-1", toolName: "weather", result: { weather: "sunny" }, providerExecuted: true, dynamic: true },
]));
add("tool-error", "tool-error", await modelParts("message-tool-error", [
  { type: "tool-call", toolCallId: "call-error", toolName: "shell", input: "{\"command\":\"false\"}", providerExecuted: true, dynamic: true },
  { type: "tool-result", toolCallId: "call-error", toolName: "shell", result: "exit 1", isError: true, providerExecuted: true, dynamic: true },
]));
add("approval", "approval", await hostParts([
  { type: "tool-input-available", toolCallId: "call-approval", toolName: "deploy", input: { target: "production" }, providerExecuted: true, dynamic: true, title: "Deploy" },
  { type: "tool-approval-request", toolCallId: "call-approval", approvalId: "approval-1" },
  { type: "tool-output-denied", toolCallId: "call-approval" },
]));
add("reset-retry-abort", "recovery", await hostParts([{ type: "abort" }]));
add("usage", "usage", await modelParts("message-usage", [], true));
add("unknown-malformed", "unknown", await hostParts([{ type: "data-weather", data: { temperature: 72, units: "F" }, id: "weather-1" }]));
add("unknown-malformed", "unknown", [{ type: "text-delta", id: 7, delta: false }]);
add("sessions", "alpha", await modelParts("alpha-message", [{ type: "text-start", id: "alpha-text" }, { type: "text-delta", id: "alpha-text", delta: "alpha" }, { type: "text-end", id: "alpha-text" }]));
add("sessions", "beta", await modelParts("beta-message", [{ type: "text-start", id: "beta-text" }, { type: "text-delta", id: "beta-text", delta: "beta" }, { type: "text-end", id: "beta-text" }]));
add("replay", "replay", await modelParts("stable-message", [{ type: "text-start", id: "stable-text" }, { type: "text-delta", id: "stable-text", delta: "stable" }, { type: "text-end", id: "stable-text" }]));

const fixtureUrl = new URL("../test/fixtures/conformance.jsonl", import.meta.url);
await writeFile(fixtureUrl, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
const playground = await modelParts("ai-sdk-demo", [
  { type: "reasoning-start", id: "reasoning-demo" },
  { type: "reasoning-delta", id: "reasoning-demo", delta: "check the current directory first" },
  { type: "reasoning-end", id: "reasoning-demo" },
  { type: "text-start", id: "text-demo" },
  { type: "text-delta", id: "text-demo", delta: "i'll inspect the project.\n" },
  { type: "text-end", id: "text-demo" },
  { type: "tool-call", toolCallId: "call-demo", toolName: "shell", input: "{\"command\":\"ls\"}", providerExecuted: true, dynamic: true },
  { type: "tool-result", toolCallId: "call-demo", toolName: "shell", result: "README.md\napps\npackages", providerExecuted: true, dynamic: true },
]);
await writeFile(new URL("../test/fixtures/playground.jsonl", import.meta.url), `${playground.map((part) => JSON.stringify(part)).join("\n")}\n`);
