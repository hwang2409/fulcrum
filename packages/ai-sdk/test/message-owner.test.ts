import { expect, test } from "bun:test";
import { createRunStore, type RunEvent } from "@fulcrum/core";
import { convertToModelMessages, jsonSchema, readUIMessageStream, simulateReadableStream, stepCountIs, streamText, tool, type UIMessage, type UIMessageChunk } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createAiSdkAdapter, decodeAiSdkMessage, respondToApproval } from "../src/index.js";
import { TestChat } from "./chat.js";

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
  count: tool({ inputSchema: schema, needsApproval: true, async *execute() { yield "1"; yield "1 2"; yield "1 2 3"; } }),
  pick: tool({ inputSchema: schema }), // runs in the client: the host adds its output and continues
};
const user: UIMessage = { id: "u", role: "user", parts: [{ type: "text", text: "go" }] };

/** Streams model steps through ai 6.0.0 `streamText(...).toUIMessageStream()`, as a server route does. */
async function uiStream(steps: Chunk[][], options: { messages?: UIMessage[]; abortAfterDelta?: string; messageId?: string } = {}) {
  let step = 0;
  const model = new MockLanguageModelV3({ doStream: async () => ({ stream: simulateReadableStream({ chunks: (steps[step++] ?? [finish("stop")]) as never[], chunkDelayInMs: options.abortAfterDelta ? 1 : null }) }) });
  const abort = new AbortController();
  const messages = options.messages ?? [user];
  const result = streamText({ model, messages: await convertToModelMessages(messages), tools, stopWhen: stepCountIs(5), abortSignal: abort.signal, onError: () => {}, _internal: { generateId: () => "approval-1" } } as Parameters<typeof streamText>[0]);
  const parts: UIMessageChunk[] = [];
  for await (const part of result.toUIMessageStream({ originalMessages: messages, generateMessageId: () => options.messageId ?? "m" })) {
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
      return `${id} ${item.active ? "live " : ""}${[...blocks, ...(item.text ? [`streaming:${item.text}`] : [])].join("|")}`;
    }
    if (item.type === "tool") return `${id} ${item.tool_call.name}${JSON.stringify(item.tool_call.arguments)} -> ${item.output}${item.approval ? ` (${item.approval.decision})` : ""}`;
    if (item.type === "error") return `error ${item.event.type === "error" ? item.event.error.code : ""}`;
    return id;
  });
};
// Message ids that still look live, or are not committed with their UI message id, when a new tool row starts.
const liveAtToolRow = (events: RunEvent[]) => {
  const store = createRunStore((flush) => flush());
  const found: string[] = [];
  for (const event of events) {
    if (event.type === "tool_start" && !store.getItem(`tool:${event.tool_call.id}`)) {
      for (const { id } of store.getOutline()) {
        const item = store.getItem(id)!;
        if (item.type === "message" && (item.active || item.message.metadata?.wireId === undefined)) found.push(id);
      }
    }
    store.dispatch(event);
  }
  return found;
};
/**
 * One adapter per stream, given the messages its request sent; a host event (what respondToApproval dispatched, or a
 * reload's events) plays as is.
 */
type Entry = readonly [streamKey: string, parts: readonly Chunk[], originalMessages?: readonly UIMessage[]] | RunEvent;
const play = (entries: readonly Entry[]) => entries.flatMap((entry) => {
  if (!Array.isArray(entry)) return [entry as RunEvent];
  const [streamKey, parts, originalMessages] = entry;
  const adapter = createAiSdkAdapter({ streamKey, originalMessages });
  return parts.flatMap((part: Chunk) => adapter.decode(part));
});

/**
 * A host session on a real ai 6.0.0 chat: request n streams `requests[n]` through `uiStream` with stream key `req<n+1>`,
 * the host answers each approval with respondToApproval and continues. Returns what the host fed the store, in order,
 * and the chat's persisted messages.
 */
async function session(requests: Chunk[][][], response?: { approved: boolean; reason?: string }) {
  const log: Entry[] = [];
  let request = 0;
  const chat = new TestChat(async (messages) => {
    const parts = await uiStream(requests[request]!, { messages });
    log.push([`req${++request}`, parts, structuredClone(messages)]);
    return parts;
  });
  await chat.sendMessage({ text: "go" });
  while (response && request < requests.length) {
    const asked = (chat.messages.at(-1)!.parts as Chunk[]).filter((part) => part.state === "approval-requested");
    for (const part of asked) await respondToApproval({ chat, dispatch: (event) => log.push(event) }, { requestId: `w:approval:${(part.approval as { id: string }).id}`, ...response });
    await chat.sendMessage();
  }
  return { log, messages: chat.messages };
}
const deleteSteps = [[...text("t1", "i will delete it."), call("c1", "rm"), finish("tool-calls")], [...text("t2", "deleted."), finish("stop")]];
const denySteps = [[...text("t1", "i will delete it."), call("c1", "rm"), finish("tool-calls")], [...text("t2", "kept it."), finish("stop")]];
const countSteps = [[...text("t1", "counting."), call("c1", "count"), finish("tool-calls")], [...text("t2", "counted."), finish("stop")]];
/** The reload entry: one persisted assistant message. */
const reloadMessage = (message: unknown) => decodeAiSdkMessage(message);
const reload = (messages: UIMessage[]) => reloadMessage(messages.at(-1));

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

const cases: Array<[name: string, streams: () => Promise<readonly Entry[]>, expected: string[]]> = [
  ["single step", async () => [["k", await uiStream([[...text("t", "hello ", "world"), finish("stop")]])]], [
    "message:m:message:m:1 text:hello world",
  ]],
  ["multi-step text, tool, text", async () => [["k", await uiStream([[...text("t1", "looking."), call("c1", "ls"), finish("tool-calls")], [...text("t2", "found a."), finish("stop")]])]], [
    "message:m:message:m:1 text:looking.",
    "tool:w:tool:c1 ls{\"path\":\"a\"} -> a b",
    "message:m:message:m:2 text:found a.",
  ]],
  ["reasoning per step", async () => [["k", await uiStream([[...reasoning("r1", "plan"), ...text("t1", "looking."), call("c1", "ls"), finish("tool-calls")], [...reasoning("r2", "done"), ...text("t2", "found a."), finish("stop")]])]], [
    "message:m:message:m:1 reasoning:plan|text:looking.",
    "tool:w:tool:c1 ls{\"path\":\"a\"} -> a b",
    "message:m:message:m:2 reasoning:done|text:found a.",
  ]],
  ["a step with only tools", async () => [["k", await uiStream([[...text("t1", "looking."), call("c1", "ls"), finish("tool-calls")], [call("c2", "cat"), finish("tool-calls")], [...text("t3", "read it."), finish("stop")]])]], [
    "message:m:message:m:1 text:looking.",
    "tool:w:tool:c1 ls{\"path\":\"a\"} -> a b",
    "tool:w:tool:c2 cat{\"path\":\"a\"} -> body",
    "message:m:message:m:2 text:read it.",
  ]],
  ["a text part with no text after a tool", async () => [["k", await uiStream([[...text("t1", "looking."), call("c1", "ls"), finish("tool-calls")], [...text("t2"), finish("stop")]])]], [
    "message:m:message:m:1 text:looking.",
    "tool:w:tool:c1 ls{\"path\":\"a\"} -> a b",
  ]],
  ["approval, then a continuation that starts with the tool output", async () => {
    const steps = [[...text("t1", "i will delete it."), call("c1", "rm"), finish("tool-calls")], [...text("t2", "deleted."), finish("stop")]];
    const first = await uiStream(steps);
    const messages = await answered(first, approve);
    const second = await uiStream(steps.slice(1), { messages });
    expect(second.slice(0, 2)).toEqual([{ type: "start", messageId: "m" }, { type: "tool-output-available", toolCallId: "c1", output: "ok" }]);
    return [["req1", first, [user]], ["req2", second, messages]];
  }, [
    // No host step (the host never told fulcrum): the tool row keeps its call, the approval row waits.
    "message:m:message:m:1 text:i will delete it.",
    "tool:w:tool:c1 rm{\"path\":\"a\"} -> ok",
    "approval:w:approval:approval-1",
    "message:m:message:m:2 text:deleted.",
  ]],
  ["approved with respondToApproval: the approval folds into the tool row", async () => (await session([deleteSteps, deleteSteps.slice(1)], { approved: true })).log, [
    "message:m:message:m:1 text:i will delete it.",
    "tool:w:tool:c1 rm{\"path\":\"a\"} -> ok (approve)",
    "message:m:message:m:2 text:deleted.",
  ]],
  ["denied with a reason: the tool row is canceled and keeps its call", async () => (await session([denySteps, denySteps.slice(1)], { approved: false, reason: "keep it" })).log, [
    "message:m:message:m:1 text:i will delete it.",
    "tool:w:tool:c1 rm{\"path\":\"a\"} ->  (deny)",
    "message:m:message:m:2 text:kept it.",
  ]],
  ["an approved generator tool: preliminary outputs replace each other in one row", async () => (await session([countSteps, countSteps.slice(1)], { approved: true })).log, [
    "message:m:message:m:1 text:counting.",
    "tool:w:tool:c1 count{\"path\":\"a\"} -> 1 2 3 (approve)",
    "message:m:message:m:2 text:counted.",
  ]],
  ["reload of an approved message", async () => reload((await session([deleteSteps, deleteSteps.slice(1)], { approved: true })).messages), [
    "message:m:message:m:1 text:i will delete it.",
    "tool:w:tool:c1 rm{\"path\":\"a\"} -> ok (approve)",
    "message:m:message:m:2 text:deleted.",
  ]],
  ["reload of a denied message", async () => reload((await session([denySteps, denySteps.slice(1)], { approved: false, reason: "keep it" })).messages), [
    "message:m:message:m:1 text:i will delete it.",
    "tool:w:tool:c1 rm{\"path\":\"a\"} ->  (deny)",
    "message:m:message:m:2 text:kept it.",
  ]],
  ["reload before the decision: the approval waits", async () => reload((await session([deleteSteps])).messages), [
    "message:m:message:m:1 text:i will delete it.",
    "tool:w:tool:c1 rm{\"path\":\"a\"} -> ",
    "approval:w:approval:approval-1",
  ]],
  ["a continuation that starts with text", async () => {
    const first = await uiStream([[...text("t1", "which one?"), call("c1", "pick"), finish("tool-calls")]]);
    const messages = await answered(first, pickOutput);
    const second = await uiStream([[...text("t2", "you picked b."), finish("stop")]], { messages });
    expect(second.slice(0, 3).map((part) => part.type)).toEqual(["start", "start-step", "text-start"]);
    return [["req1", first, [user]], ["req2", second, messages]];
  }, [
    "message:m:message:m:1 text:which one?",
    "tool:w:tool:c1 pick{\"path\":\"a\"} -> ",
    "message:m:message:m:2 text:you picked b.",
  ]],
  ["a stream that drops before finish", async () => {
    const parts = await uiStream([[...text("t1", "looking."), call("c1", "ls"), finish("tool-calls")], [...text("t2", "found a."), finish("stop")]]);
    return [["k", parts.slice(0, parts.findIndex((part) => part.type === "text-end" && part.id === "t2"))]];
  }, [
    "message:m:message:m:1 text:looking.",
    "tool:w:tool:c1 ls{\"path\":\"a\"} -> a b",
    "message:m:message:m:2 live streaming:found a.",
  ]],
  ["abort mid-step", async () => [["k", await uiStream([[...text("t", "half ", "rest"), finish("stop")]], { abortAfterDelta: "half " })]], [
    "message:m:message:m:1 text:half ",
    "error aborted",
  ]],
  ["error mid-step, then the step goes on", async () => [["k", await uiStream([[{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "half " }, { type: "error", error: "overloaded" }, { type: "text-delta", id: "t", delta: "more" }, { type: "text-end", id: "t" }, finish("stop")]])]], [
    "message:m:message:m:1 text:half ",
    "error ai_sdk_error",
    "message:m:message:m:2 text:more",
  ]],
  ["duplicate and late parts", async () => [["k", await lateParts()]], [
    "message:m:message:m:1 reasoning:plan{\"providerMetadata\":[{\"mock\":{\"late\":true}}]}|text:before ",
    "tool:w:tool:c1 ls{\"path\":\"a\"} -> a b",
    "message:m:message:m:2 text:after|text:tail",
  ]],
];

test.each(cases)("%s: final rows, and a replay assigns the same ids", async (_name, streams, expected) => {
  const played = await streams();
  const events = play(played);
  expect(rows(events)).toEqual(expected);
  expect(liveAtToolRow(events)).toEqual([]);
  expect(play(played)).toEqual(events);
});


// The store a host builds from a session: the tool row keeps the call the request stream defined, through the
// continuation's outputs, and the approval ends at the click with the SDK's decision.
test.each([
  ["approve", "rm", deleteSteps, { approved: true }, { decision: "approve" }],
  ["deny with a reason", "rm", denySteps, { approved: false, reason: "keep it" }, { decision: "deny", data: { reason: "keep it" } }],
  ["approve a generator tool", "count", countSteps, { approved: true }, { decision: "approve" }],
] as const)("%s: the tool row keeps its call and the approval card ends", async (_name, name, steps, response, ended) => {
  const { log, messages } = await session([steps, steps.slice(1)], response);
  const build = (events: RunEvent[]) => {
    const store = createRunStore((flush) => flush());
    for (const event of events) store.dispatch(event);
    return store;
  };
  const requested = build(play(log.slice(0, 1))).getItem("tool:w:tool:c1");
  const live = build(play(log));
  const reloaded = build(reload(messages));
  for (const store of [live, reloaded]) {
    const item = store.getItem("tool:w:tool:c1");
    expect(item?.type === "tool" ? item.tool_call : undefined).toEqual(requested?.type === "tool" ? requested.tool_call : undefined);
    expect(item?.type === "tool" ? item.tool_call : undefined).toMatchObject({ name, arguments: { path: "a" }, meta: { wireId: "c1" } });
    expect(item?.type === "tool" ? item.approval : undefined).toEqual({ type: "approval_end", request_id: "w:approval:approval-1", ...ended });
    expect(store.getOutline().filter(({ id }) => id.startsWith("tool:")).length).toBe(1);
    expect(store.getItem("approval:w:approval:approval-1")).toMatchObject({ type: "approval", ended: { request_id: "w:approval:approval-1", ...ended } });
  }
  // The card ends when the host answers, before the continuation streams.
  const answered = build(play(log.slice(0, 2)));
  expect(answered.getItem("approval:w:approval:approval-1")).toMatchObject({ ended: { ...ended } });
});

// A finished multi-step stream persists as one message; a reload of it reads as the live rows did.
test.each(cases.slice(0, 5))("reload of %s reads as the live stream", async (_name, streams, expected) => {
  const [[, parts]] = await streams() as [[string, Chunk[]]];
  let persisted: UIMessage | undefined;
  for await (const next of readUIMessageStream({ stream: simulateReadableStream({ chunks: parts as UIMessageChunk[], chunkDelayInMs: null }) })) persisted = next;
  expect(rows(reloadMessage(persisted))).toEqual(expected);
});

// One id rule for live and reload: a message row is `m:message:<UI message id>:<n>`, the UI message's nth segment, so
// a store can mix live streams and reloaded messages, and decoding a persisted message again replaces its rows.
const storeOf = (events: RunEvent[]) => {
  const store = createRunStore((flush) => flush());
  for (const event of events) store.dispatch(event);
  return store;
};
const outline = (store: ReturnType<typeof storeOf>) => store.getOutline().map(({ id }) => id);
const messageRows = (store: ReturnType<typeof storeOf>) => outline(store).filter((id) => id.startsWith("message:"));

test.each([
  ["approve", [deleteSteps, deleteSteps.slice(1)], { approved: true }],
  ["deny with a reason", [denySteps, denySteps.slice(1)], { approved: false, reason: "keep it" }],
  ["approve a generator tool", [countSteps, countSteps.slice(1)], { approved: true }],
  ["multi-step tools in one stream", [[[...text("t1", "looking."), call("c1", "ls"), finish("tool-calls")], [call("c2", "cat"), finish("tool-calls")], [...reasoning("r", "done"), ...text("t3", "read it."), finish("stop")]]], undefined],
] as const)("live then reload, %s: the persisted message decodes to the live ids and rows", async (_name, requests, response) => {
  const { log, messages } = await session(requests as unknown as Chunk[][][], response);
  const live = storeOf(play(log));
  const reloaded = storeOf(reload(messages));
  expect(rows(reload(messages))).toEqual(rows(play(log)));
  expect(outline(reloaded)).toEqual(outline(live));
  // Decoding the persisted message into the live store (a re-sync) replaces rows in place: nothing doubles.
  for (const event of reload(messages)) live.dispatch(event);
  expect(outline(live)).toEqual(outline(reloaded));
});

test("reload a pending approval, respond, stream the continuation: one message row keeps its text, one tool row", async () => {
  const pending = (await session([deleteSteps])).messages;
  const store = storeOf(reload(pending));
  // A reload: a new chat from the persisted messages, as useChat({ messages }) does.
  let continuation: Entry | undefined;
  const chat = new TestChat(async (messages) => {
    const parts = await uiStream(deleteSteps.slice(1), { messages });
    continuation = ["req2", parts, structuredClone(messages)];
    return parts;
  }, pending);
  await respondToApproval({ chat, dispatch: store.dispatch }, { requestId: "w:approval:approval-1", approved: true });
  await chat.sendMessage();
  for (const event of play([continuation!])) store.dispatch(event);
  // The store matches a reload of the final persisted message, so a re-sync replaces rows instead of doubling them.
  expect(outline(store)).toEqual(outline(storeOf(reload(chat.messages))));
  for (const event of reload(chat.messages)) store.dispatch(event);
  expect(outline(store).filter((id) => id.startsWith("message:") || id.startsWith("tool:")).length).toBe(3);
  const final = rows([...reload(pending), { type: "approval_end", request_id: "w:approval:approval-1", decision: "approve" }, ...play([continuation!])]);
  expect(final).toEqual([
    "message:m:message:m:1 text:i will delete it.",
    "tool:w:tool:c1 rm{\"path\":\"a\"} -> ok (approve)",
    "message:m:message:m:2 text:deleted.",
  ]);
  expect(outline(store).filter((id) => id.startsWith("message:") || id.startsWith("tool:"))).toEqual(["message:m:message:m:1", "tool:w:tool:c1", "message:m:message:m:2"]);
});

test("reload, then a client continuation that starts with text: its text is the next message, after the step's text", async () => {
  // The request's step says something after the client tool call, then the host answers the tool and continues.
  const steps = [[...text("t1", "which one?"), call("c1", "pick"), ...text("t2", "waiting."), finish("tool-calls")]];
  const pending = (await session([steps])).messages;
  const store = storeOf(reload(pending));
  let continuation: Entry | undefined;
  const chat = new TestChat(async (messages) => {
    const parts = await uiStream([[...text("t3", "you picked b."), finish("stop")]], { messages });
    continuation = ["req2", parts, structuredClone(messages)];
    return parts;
  }, pending);
  await chat.addToolOutput({ tool: "pick" as never, toolCallId: "c1", output: "b" as never });
  await chat.sendMessage();
  for (const event of play([continuation!])) store.dispatch(event);
  const resynced = storeOf(reload(chat.messages));
  expect(messageRows(store)).toEqual(messageRows(resynced));
  for (const event of reload(chat.messages)) store.dispatch(event);
  expect(messageRows(store)).toHaveLength(3);
  expect(rows([...reload(pending), ...play([continuation!])]).filter((row) => row.startsWith("message:"))).toEqual([
    "message:m:message:m:1 text:which one?",
    "message:m:message:m:2 text:waiting.",
    "message:m:message:m:3 text:you picked b.",
  ]);
  expect(messageRows(store)).toEqual(["message:m:message:m:1", "message:m:message:m:2", "message:m:message:m:3"]);
});

test("two reloaded messages, then a new live message: each keeps its own rows", async () => {
  const first: UIMessage = { id: "a1", role: "assistant", parts: [{ type: "step-start" }, { type: "text", text: "first answer." }] };
  const second: UIMessage = { id: "a2", role: "assistant", parts: [{ type: "step-start" }, { type: "text", text: "second answer." }] };
  const history = [user, first, { ...user, id: "u2" }, second, { ...user, id: "u3" }];
  const store = storeOf([...reloadMessage(first), ...reloadMessage(second)]);
  const parts = await uiStream([[...text("t", "third answer."), finish("stop")]], { messages: history, messageId: "a3" });
  for (const event of play([["req3", parts, history]])) store.dispatch(event);
  let persisted: UIMessage | undefined;
  for await (const next of readUIMessageStream({ stream: simulateReadableStream({ chunks: parts, chunkDelayInMs: null }) })) persisted = next;
  for (const event of [...reloadMessage(first), ...reloadMessage(second), ...reloadMessage(persisted)]) store.dispatch(event);
  expect(messageRows(store)).toHaveLength(3);
  expect(rows([...reloadMessage(first), ...reloadMessage(second), ...play([["req3", parts, history]])])).toEqual([
    "message:m:message:a1:1 text:first answer.",
    "message:m:message:a2:1 text:second answer.",
    "message:m:message:a3:1 text:third answer.",
  ]);
  expect(messageRows(store)).toEqual(["message:m:message:a1:1", "message:m:message:a2:1", "message:m:message:a3:1"]);
});

// respondToApproval ends the card only when the SDK will record the decision: the approval must be pending in the
// chat's last message, the one place addToolApprovalResponse writes (ai 6.0.0 dist/index.mjs:11329-11345).
test("respondToApproval refuses an approval the SDK would not record", async () => {
  const dispatched: RunEvent[] = [];
  const dispatch = (event: RunEvent) => dispatched.push(event);
  const requestId = "w:approval:approval-1";
  const pendingChat = async () => {
    const { messages } = await session([deleteSteps]);
    return new TestChat(async (sent) => uiStream([[...text("t9", "ok, never mind."), finish("stop")]], { messages: sent, messageId: "m2" }), messages);
  };
  // A stale card: the user sent a new prompt instead of answering, then clicks approve.
  const stale = await pendingChat();
  await stale.sendMessage({ text: "never mind" });
  await expect(respondToApproval({ chat: stale, dispatch }, { requestId, approved: true })).rejects.toThrow("this approval is no longer waiting for a decision");
  // A second, opposite answer after the first one landed.
  const twice = await pendingChat();
  await respondToApproval({ chat: twice, dispatch }, { requestId, approved: true });
  await expect(respondToApproval({ chat: twice, dispatch }, { requestId, approved: false })).rejects.toThrow("this approval is no longer waiting for a decision");
  expect((twice.messages.at(-1)!.parts as Chunk[]).find((part) => part.type === "tool-rm")).toMatchObject({ approval: { approved: true } });
  // An id the chat never asked about.
  await expect(respondToApproval({ chat: await pendingChat(), dispatch }, { requestId: "w:approval:nope", approved: true })).rejects.toThrow("this approval is no longer waiting for a decision");
  expect(dispatched).toEqual([{ type: "approval_end", request_id: requestId, decision: "approve" }]);
});

test("a persisted approval with a malformed decision is one error; the tool's outcome still plays", () => {
  const events = reloadMessage({ id: "bad", role: "assistant", parts: [
    { type: "tool-rm", toolCallId: "c1", state: "output-available", input: { path: "a" }, output: "ok", approval: { id: "approval-1", approved: "yes" } },
  ] });
  expect(events.filter((event) => event.type === "error").map((event) => event.type === "error" ? event.error.code : "")).toEqual(["adapter_invalid_payload"]);
  const store = storeOf(events);
  expect(store.getItem("tool:w:tool:c1")).toMatchObject({ type: "tool", active: false, output: "ok" });
});
