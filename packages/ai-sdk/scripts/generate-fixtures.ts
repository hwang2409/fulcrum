import { writeFile } from "node:fs/promises";
import { convertToModelMessages, createUIMessageStream, jsonSchema, simulateReadableStream, stepCountIs, streamText, tool, type ToolSet, type UIMessage, type UIMessageChunk } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { RunEvent } from "@fulcrum/core";
import { encodeAiSdkEntityId, respondToApproval } from "../src/index.js";
import { TestChat } from "../test/chat.js";

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

type SessionEntry = { stream: string; originalMessages?: UIMessage[]; part: UIMessageChunk } | { event: RunEvent };
/**
 * A host session on a real chat: each request runs its model steps through `streamText(...).toUIMessageStream()` as a
 * server route does, and the host answers each approval with `respondToApproval`, then continues. Returns what the
 * host fed its store, in order: each stream's chunks under its own stream key (the first one carries the messages the
 * request sent, which the stream's adapter takes as `originalMessages`), and the event respondToApproval dispatched
 * between the request and its continuation.
 */
async function hostSession(name: string, requests: unknown[][][], tools: ToolSet, response: { approved: boolean; reason?: string }) {
  const log: SessionEntry[] = [];
  let request = 0;
  const chat = new TestChat(async (messages) => {
    const steps = requests[request]!;
    let step = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        const chunks = steps[step++]!;
        const calls = chunks.some((chunk) => (chunk as { type: string }).type === "tool-call");
        return { stream: simulateReadableStream({ chunks: [streamStart, ...chunks, { ...finish, finishReason: calls ? { unified: "tool-calls", raw: "tool_calls" } : finish.finishReason }] as never[] }) };
      },
    });
    const result = streamText({ model, messages: await convertToModelMessages(messages), tools, stopWhen: stepCountIs(steps.length), _internal: { generateId: () => "approval-1" } } as Parameters<typeof streamText>[0]);
    const parts: UIMessageChunk[] = [];
    for await (const part of result.toUIMessageStream({ originalMessages: messages, generateMessageId: () => `${name}-message` })) parts.push(part);
    const stream = `${name}-request-${++request}`;
    parts.forEach((part, index) => log.push(index ? { stream, part } : { stream, originalMessages: structuredClone(messages), part }));
    return parts;
  });
  await chat.sendMessage({ text: "go" });
  while (request < requests.length) {
    for (const part of chat.messages.at(-1)!.parts)
      if ("approval" in part && part.state === "approval-requested")
        await respondToApproval({ chat, dispatch: (event) => log.push({ event }) }, { requestId: encodeAiSdkEntityId({ source: "wire", kind: "approval", id: part.approval.id }), ...response });
    await chat.sendMessage();
  }
  return log;
}

async function hostParts(parts: UIMessageChunk[]): Promise<UIMessageChunk[]> {
  const stream = createUIMessageStream({ execute: ({ writer }) => { for (const part of parts) writer.write(part); } });
  const output: UIMessageChunk[] = [];
  for await (const part of stream) output.push(part);
  return output;
}

const rows: Array<{ scenario: string; sessionId: string; [key: string]: unknown }> = [];
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
// An approval is two streams: the request ends at the approval; the host answers it (respondToApproval) and the
// continuation reports the decision's outcome.
const deploy = tool({ inputSchema: jsonSchema<{ target: string }>({ type: "object", properties: { target: { type: "string" } } }), needsApproval: true, execute: async () => ({ ok: true }) });
const say = (id: string, delta: string) => [{ type: "text-start", id }, { type: "text-delta", id, delta }, { type: "text-end", id }];
const deploySteps = [
  [...say("text-ask", "deploying to production."), { type: "tool-call", toolCallId: "call-approval", toolName: "deploy", input: "{\"target\":\"production\"}" }],
  say("text-after", "left production alone."),
];
for (const entry of await hostSession("approval", [deploySteps, deploySteps.slice(1)], { deploy }, { approved: false, reason: "not on a friday" }))
  rows.push({ scenario: "approval", sessionId: "approval", ...entry });
add("reset-retry-abort", "recovery", await hostParts([{ type: "abort" }]));
add("usage", "usage", await modelParts("message-usage", [], true));
add("unknown-malformed", "unknown", await hostParts([{ type: "data-weather", data: { temperature: 72, units: "F" }, id: "weather-1" }]));
add("unknown-malformed", "unknown", [{ type: "text-delta", id: 7, delta: false }]);
add("sessions", "alpha", await modelParts("alpha-message", [{ type: "text-start", id: "alpha-text" }, { type: "text-delta", id: "alpha-text", delta: "alpha" }, { type: "text-end", id: "alpha-text" }]));
add("sessions", "beta", await modelParts("beta-message", [{ type: "text-start", id: "beta-text" }, { type: "text-delta", id: "beta-text", delta: "beta" }, { type: "text-end", id: "beta-text" }]));
for (const [streamKey, marker] of [["request-alpha", "stream-alpha"], ["request-beta", "stream-beta"]] as const)
  for (const part of await hostParts([{ type: "source-url", sourceId: marker, url: `https://example.com/${marker}` }, { type: "finish", finishReason: "stop" }]))
    rows.push({ scenario: "streams", sessionId: streamKey, contentMarker: marker, part });
const adversarial = async (sessionId: string, messageId: string | undefined, marker: string) => {
  const parts = messageId === undefined
    ? await hostParts([{ type: "source-url", sourceId: marker, url: `https://example.com/${marker}` }, { type: "finish", finishReason: "stop" }])
    : await modelParts(messageId, [{ type: "text-start", id: `${marker}:text%` }, { type: "text-delta", id: `${marker}:text%`, delta: marker }, { type: "text-end", id: `${marker}:text%` }]);
  for (const part of parts) rows.push({ scenario: "adversarial-ids", sessionId, contentMarker: marker, part });
};
await adversarial("adversarial-a", undefined, "synthetic-a");
await adversarial("adversarial-a", "ai-sdk:adversarial-b:message-1", "wire-matches-old-b");
await adversarial("adversarial-a", "s:message:adversarial-b:1", "wire-matches-b");
await adversarial("adversarial-b", undefined, "synthetic-b");
await adversarial("adversarial-b", "ai-sdk:adversarial-a:message-1", "wire-matches-old-a");
await adversarial("adversarial-b", "s:message:adversarial-a:1", "wire-matches-a");
await adversarial("adversarial-separators", "w:message:%:unicode-雪", "wire-separators");
add("replay", "replay", await modelParts("stable-message", [{ type: "text-start", id: "stable-text" }, { type: "text-delta", id: "stable-text", delta: "stable" }, { type: "text-end", id: "stable-text" }]));

const fixtureUrl = new URL("../test/fixtures/conformance.jsonl", import.meta.url);
await writeFile(fixtureUrl, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
// The playground demo is a real approval session: step 1 reasons, says what it will do, and asks to run `shell`; the
// host approves; the continuation streams the shell's output as preliminary results, then reasons again and answers
// below the tool row.
const demoSteps = [
  [
    { type: "reasoning-start", id: "reasoning-demo" },
    { type: "reasoning-delta", id: "reasoning-demo", delta: "check the current directory first" },
    { type: "reasoning-end", id: "reasoning-demo" },
    { type: "text-start", id: "text-demo" },
    { type: "text-delta", id: "text-demo", delta: "i'll inspect the project.\n" },
    { type: "text-end", id: "text-demo" },
    { type: "tool-call", toolCallId: "call-demo", toolName: "shell", input: "{\"command\":\"ls\"}" },
  ],
  [
    { type: "reasoning-start", id: "reasoning-demo-2" },
    { type: "reasoning-delta", id: "reasoning-demo-2", delta: "three entries: a readme and two folders" },
    { type: "reasoning-end", id: "reasoning-demo-2" },
    { type: "text-start", id: "text-demo-2" },
    { type: "text-delta", id: "text-demo-2", delta: "The project has a README " },
    { type: "text-delta", id: "text-demo-2", delta: "and two folders: `apps` and `packages`.\n" },
    { type: "text-end", id: "text-demo-2" },
  ],
];
const shell = tool({
  inputSchema: jsonSchema<{ command: string }>({ type: "object", properties: { command: { type: "string" } } }),
  needsApproval: true,
  async *execute() { yield "README.md"; yield "README.md\napps"; yield "README.md\napps\npackages"; },
});
const playground = await hostSession("ai-sdk-demo", [demoSteps, demoSteps.slice(1)], { shell }, { approved: true });
await writeFile(new URL("../test/fixtures/playground.jsonl", import.meta.url), `${playground.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
