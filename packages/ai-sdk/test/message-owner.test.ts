import { expect, test } from "bun:test";
import { createRunStore, type RunEvent } from "@fulcrum/core";
import { convertToModelMessages, jsonSchema, readUIMessageStream, simulateReadableStream, stepCountIs, streamText, tool, type UIMessage, type UIMessageChunk } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createAiSdkAdapter } from "../src/index.js";

// Which fulcrum message each content part goes to, played from real ai 6.0.0 UI message streams into one store.
type Chunk = Record<string, unknown>;
const finish = (reason: string) => ({ type: "finish", finishReason: { unified: reason, raw: reason }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } });
const text = (id: string, ...deltas: string[]): Chunk[] => [{ type: "text-start", id }, ...deltas.map((delta) => ({ type: "text-delta", id, delta })), { type: "text-end", id }];
const reasoning = (id: string, delta: string): Chunk[] => [{ type: "reasoning-start", id }, { type: "reasoning-delta", id, delta }, { type: "reasoning-end", id }];
const call = (toolCallId: string, toolName: string): Chunk => ({ type: "tool-call", toolCallId, toolName, input: "{\"path\":\"a\"}" });
const schema = jsonSchema<{ path: string }>({ type: "object", properties: { path: { type: "string" } } });
const tools = {
  ls: tool({ inputSchema: schema, execute: async () => "a b" }),
  cat: tool({ inputSchema: schema, execute: async () => "body" }),
  rm: tool({ inputSchema: schema, needsApproval: true, execute: async () => "ok" }),
  pick: tool({ inputSchema: schema }), // runs in the client: the host adds its output and continues
};
const user: UIMessage = { id: "u", role: "user", parts: [{ type: "text", text: "go" }] };

/** Streams model steps through ai 6.0.0 `streamText(...).toUIMessageStream()`, as a server route does. */
async function uiStream(steps: Chunk[][], options: { messages?: UIMessage[]; abortAfterDelta?: string } = {}) {
  let step = 0;
  const model = new MockLanguageModelV3({ doStream: async () => ({ stream: simulateReadableStream({ chunks: (steps[step++] ?? [finish("stop")]) as never[], chunkDelayInMs: options.abortAfterDelta ? 1 : null }) }) });
  const abort = new AbortController();
  const messages = options.messages ?? [user];
  const result = streamText({ model, messages: await convertToModelMessages(messages), tools, stopWhen: stepCountIs(5), abortSignal: abort.signal, onError: () => {}, _internal: { generateId: () => "approval-1" } } as Parameters<typeof streamText>[0]);
  const parts: UIMessageChunk[] = [];
  for await (const part of result.toUIMessageStream({ originalMessages: messages, generateMessageId: () => "m" })) {
    parts.push(part);
    if (part.type === "text-delta" && part.delta === options.abortAfterDelta) abort.abort();
  }
  return parts;
}
/** The UI message after a stream, with every pending approval answered or every client tool given an output. */
async function answered(parts: UIMessageChunk[], answer: (part: Record<string, unknown>) => void) {
  let message: UIMessage | undefined;
  for await (const next of readUIMessageStream({ stream: simulateReadableStream({ chunks: parts }) })) message = next;
  const copy = structuredClone(message!);
  for (const part of copy.parts as Record<string, unknown>[]) answer(part);
  return [user, copy];
}
const approve = (part: Record<string, unknown>) => {
  if (part.state === "approval-requested") Object.assign(part, { state: "approval-responded", approval: { ...(part.approval as object), approved: true } });
};
const pickOutput = (part: Record<string, unknown>) => {
  if (part.state === "input-available") Object.assign(part, { state: "output-available", output: "b" });
};

// A row as a reader sees it, with its fulcrum id.
const rows = (events: RunEvent[]) => {
  const store = createRunStore((flush) => flush());
  for (const event of events) store.dispatch(event);
  return store.getOutline().map(({ id }) => {
    const item = store.getItem(id)!;
    if (item.type === "message") {
      const blocks = item.message.content.map((block) => `${block.type}:${String(block.text ?? "")}${block.meta ? JSON.stringify(block.meta) : ""}`);
      return `${id} ${item.active ? "live " : ""}${[...blocks, ...(item.text ? [`text:${item.text}`] : [])].join("|")}`;
    }
    if (item.type === "tool") return `${id} ${item.output}${item.approval ? ` (${item.approval.decision})` : ""}`;
    if (item.type === "error") return `error ${item.event.type === "error" ? item.event.error.code : ""}`;
    return id;
  });
};
const play = (streams: Array<[streamKey: string, parts: readonly Chunk[]]>) => streams.flatMap(([streamKey, parts]) => {
  const adapter = createAiSdkAdapter({ streamKey });
  return parts.flatMap((part) => adapter.decode(part));
});

const lateParts = async () => {
  const parts: Chunk[] = await uiStream([[...reasoning("r", "plan"), ...text("a", "before "), call("c1", "ls"), finish("tool-calls")], [...text("b", "after"), finish("stop")]]);
  const at = (type: string, id: string) => parts.findIndex((part) => part.type === type && part.id === id);
  // The first step's parts end late, after the second step's text: the reasoning part with provider metadata, the
  // text part with one more delta. Then a text part that never streams text, a repeated end, and a second finish.
  parts.splice(at("reasoning-end", "r"), 1);
  parts.splice(at("text-end", "a"), 1);
  parts.splice(at("text-end", "b") + 1, 0,
    { type: "reasoning-end", id: "r", providerMetadata: { mock: { late: true } } },
    { type: "text-delta", id: "a", delta: "tail" },
    { type: "text-end", id: "a" }, { type: "text-end", id: "a" },
    { type: "text-start", id: "silent" }, { type: "text-end", id: "silent" });
  return [...parts, { type: "finish", finishReason: "stop" }];
};

const cases: Array<[name: string, streams: () => Promise<Array<[string, readonly Chunk[]]>>, expected: string[]]> = [
  ["single step", async () => [["k", await uiStream([[...text("t", "hello ", "world"), finish("stop")]])]], [
    "message:s:message:k:1 text:hello world",
  ]],
  ["multi-step text, tool, text", async () => [["k", await uiStream([[...text("t1", "looking."), call("c1", "ls"), finish("tool-calls")], [...text("t2", "found a."), finish("stop")]])]], [
    "message:s:message:k:1 text:looking.",
    "tool:w:tool:c1 a b",
    "message:s:message:k:2 text:found a.",
  ]],
  ["reasoning per step", async () => [["k", await uiStream([[...reasoning("r1", "plan"), ...text("t1", "looking."), call("c1", "ls"), finish("tool-calls")], [...reasoning("r2", "done"), ...text("t2", "found a."), finish("stop")]])]], [
    "message:s:message:k:1 reasoning:plan|text:looking.",
    "tool:w:tool:c1 a b",
    "message:s:message:k:2 reasoning:done|text:found a.",
  ]],
  ["a step with only tools", async () => [["k", await uiStream([[...text("t1", "looking."), call("c1", "ls"), finish("tool-calls")], [call("c2", "cat"), finish("tool-calls")], [...text("t3", "read it."), finish("stop")]])]], [
    "message:s:message:k:1 text:looking.",
    "tool:w:tool:c1 a b",
    "tool:w:tool:c2 body",
    "message:s:message:k:2 text:read it.",
  ]],
  ["a text part with no text after a tool", async () => [["k", await uiStream([[...text("t1", "looking."), call("c1", "ls"), finish("tool-calls")], [...text("t2"), finish("stop")]])]], [
    "message:s:message:k:1 text:looking.",
    "tool:w:tool:c1 a b",
  ]],
  ["approval, then a continuation that starts with the tool output", async () => {
    const steps = [[...text("t1", "i will delete it."), call("c1", "rm"), finish("tool-calls")], [...text("t2", "deleted."), finish("stop")]];
    const first = await uiStream(steps);
    const second = await uiStream(steps.slice(1), { messages: await answered(first, approve) });
    expect(second.slice(0, 2)).toEqual([{ type: "start", messageId: "m" }, { type: "tool-output-available", toolCallId: "c1", output: "ok" }]);
    return [["req1", first], ["req2", second]];
  }, [
    "message:s:message:req1:1 text:i will delete it.",
    "tool:w:tool:c1 ok",
    "approval:w:approval:approval-1",
    "message:s:message:req2:1 text:deleted.",
  ]],
  ["a continuation that starts with text", async () => {
    const first = await uiStream([[...text("t1", "which one?"), call("c1", "pick"), finish("tool-calls")]]);
    const second = await uiStream([[...text("t2", "you picked b."), finish("stop")]], { messages: await answered(first, pickOutput) });
    expect(second.slice(0, 3).map((part) => part.type)).toEqual(["start", "start-step", "text-start"]);
    return [["req1", first], ["req2", second]];
  }, [
    "message:s:message:req1:1 text:which one?",
    "tool:w:tool:c1 ",
    "message:s:message:req2:1 text:you picked b.",
  ]],
  ["abort mid-step", async () => [["k", await uiStream([[...text("t", "half ", "rest"), finish("stop")]], { abortAfterDelta: "half " })]], [
    "message:s:message:k:1 text:half ",
    "error aborted",
  ]],
  ["error mid-step, then the step goes on", async () => [["k", await uiStream([[{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "half " }, { type: "error", error: "overloaded" }, { type: "text-delta", id: "t", delta: "more" }, { type: "text-end", id: "t" }, finish("stop")]])]], [
    "message:s:message:k:1 text:half ",
    "error ai_sdk_error",
    "message:s:message:k:2 text:more",
  ]],
  ["duplicate and late parts", async () => [["k", await lateParts()]], [
    "message:s:message:k:1 reasoning:plan{\"providerMetadata\":[{\"mock\":{\"late\":true}}]}|text:before ",
    "tool:w:tool:c1 a b",
    "message:s:message:k:2 text:after|text:tail",
  ]],
];

test.each(cases)("%s: final rows, and a replay assigns the same ids", async (_name, streams, expected) => {
  const played = await streams();
  const events = play(played);
  expect(rows(events)).toEqual(expected);
  expect(play(played)).toEqual(events);
});

// Known gaps of the approval continuation, outside message identity (follow-up: continuation tool and approval state).
// Repro: the "approval, then a continuation" row above; the continuation's adapter never saw the call or the approval.
test.todo("approval continuation: the tool row keeps its name and arguments (today core tool_output adopts the placeholder `tool` / {})");
test.todo("approval continuation: the approval row resolves once the approved tool returns (today no approval_end: the continuation has no approvalId)");
