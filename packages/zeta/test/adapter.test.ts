import { expect, test } from "bun:test";
import { fromZetaEvent, fromZetaHistory } from "../src/index.js";
// Real zeta output (source and capture script: fixtures/capture-zeta-images.py): a served read of a png, its history,
// an MCP tool image validated and serialized by zeta's ToolResult, and an assistant message image from ImageContent.
import zeta from "./fixtures/zeta-images.json";

// Block shapes from zeta's protocol/types.py (ThinkingContent, ImageContent, RedactedThinkingContent) and the
// assistant_delta kinds from server/control.py ("assistant" for text, the content type, "thinking", otherwise).
test("preserves user delivery ids in live events and history", () => {
  expect(fromZetaEvent({ event: "user_message", text: "queued", mode: "steer", delivery_id: "d-1" })).toEqual([{ type: "user_message", text: "queued", mode: "steer", delivery_id: "d-1" }]);
  expect(fromZetaHistory([{ id: "h", role: "user", delivery_id: "d-1", content: [{ type: "text", text: "queued" }], tool_result: null }])).toEqual([{ type: "user_message", message_id: "h", text: "queued", mode: "send", delivery_id: "d-1" }]);
});

test("maps zeta thinking and redacted thinking to fulcrum content blocks", () => {
  expect(fromZetaEvent({ event: "assistant_delta", delta: "hm", kind: "thinking", data: { message_id: "m" } })).toEqual([{ type: "message_delta", message_id: "m", delta: "hm", kind: "reasoning" }]);
  expect(fromZetaEvent({ event: "assistant_delta", delta: "hi", kind: "assistant", data: { message_id: "m" } })).toEqual([{ type: "message_delta", message_id: "m", delta: "hi", kind: "text" }]);
  const [commit] = fromZetaEvent({
    event: "assistant_message",
    data: { message_id: "m" },
    message: {
      role: "assistant",
      content: [
        { type: "thinking", text: "plan", body: "plan", signature: "sig" },
        { type: "redacted_thinking", data: "c2VjcmV0" },
        { type: "text", text: "here" },
        { type: "tool_use", tool_call: { id: "t1", name: "read", arguments: {} } },
      ],
    },
  });
  expect(commit).toEqual({
    type: "message_commit",
    message_id: "m",
    message: {
      role: "assistant",
      content: [
        { type: "reasoning", text: "plan", signature: "sig" },
        { type: "reasoning", text: "", redacted: true, data: "c2VjcmV0" },
        { type: "text", text: "here" },
      ],
    },
  });
  const history = fromZetaHistory([{ id: "h", role: "assistant", content: [{ type: "thinking", text: "why", body: "why" }, { type: "text", text: "because" }], tool_result: null }]);
  expect(history).toEqual([{ type: "message_commit", message_id: "h", message: { role: "assistant", content: [{ type: "reasoning", text: "why" }, { type: "text", text: "because" }] } }]);
});

test("maps a zeta message image exactly as ImageContent sends it: data, mimeType, path, size", () => {
  const [commit] = fromZetaEvent({ event: "assistant_message", data: { message_id: "m" }, message: zeta.assistant_message });
  const image = zeta.assistant_message.content[1] as { data: string; size: number };
  expect(commit).toEqual({
    type: "message_commit",
    message_id: "m",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "the chart:" },
        { type: "image", url: `data:image/png;base64,${image.data}`, mediaType: "image/png", filename: "chart.png", size: image.size },
      ],
    },
  });
});

test("marks an image whose history bytes were omitted", () => {
  const [commit] = fromZetaEvent({ event: "assistant_message", data: { message_id: "h" }, message: { role: "assistant", content: [{ type: "image", mimeType: "image/png", width: 3, height: 2, data_omitted: true }] } });
  expect(commit).toMatchObject({ message: { content: [{ type: "image", omitted: true, mediaType: "image/png" }] } });
});

test("a zeta tool result's image blocks reach the tool row, with an MCP image's caption and pixel size", () => {
  const read = zeta.tool_end.tool_result.content_blocks[1] as { data: string; path: string; size: number };
  const [end] = fromZetaEvent(zeta.tool_end);
  expect(end).toMatchObject({
    type: "tool_end",
    tool_result: {
      content: zeta.tool_end.tool_result.content,
      blocks: [{ type: "image", url: `data:image/png;base64,${read.data}`, mediaType: "image/png", filename: "chart.png", size: read.size }],
    },
  });
  // The read's text block is already the result's content: only images become blocks.
  expect((end as { tool_result: { blocks: unknown[] } }).tool_result.blocks).toHaveLength(1);
  const mcp = zeta.mcp_tool_result.content_blocks[0]!;
  const [captioned] = fromZetaEvent({ ...zeta.tool_end, tool_result: zeta.mcp_tool_result });
  expect(captioned).toMatchObject({
    tool_result: { blocks: [{ type: "image", url: `data:image/png;base64,${mcp.data}`, mediaType: "image/png", alt: "revenue by quarter", width: 640, height: 480, size: mcp.size }] },
  });
});

test("zeta history drops tool images (content_blocks: []), so the replayed row has text only", () => {
  const ended = fromZetaHistory(zeta.history.messages).find((event) => event.type === "tool_end");
  expect(ended).toMatchObject({ type: "tool_end", tool_result: { content: zeta.history.messages.at(-1)!.tool_result!.content } });
  expect((ended as { tool_result: object }).tool_result).not.toHaveProperty("blocks");
});

// History (server/ergonomics.py _history_entry_rows) replaces a message image with {type: "attachment", name, size}.
test("keeps an image's history stub and passes unknown blocks through", () => {
  const [commit] = fromZetaEvent({ event: "assistant_message", data: { message_id: "m" }, message: { role: "assistant", content: [{ type: "future_block", value: 1 }] } });
  expect(commit).toMatchObject({ message: { content: [{ type: "future_block", value: 1 }] } });
  const history = fromZetaHistory([{ id: "h", role: "assistant", content: [{ type: "text", text: "see" }, { type: "attachment", name: "shot.png", size: 5 }], tool_result: null }]);
  expect(history).toEqual([{ type: "message_commit", message_id: "h", message: { role: "assistant", content: [{ type: "text", text: "see" }, { type: "file", filename: "shot.png", size: 5 }] } }]);
});

test("malformed attachment containers do not drop the user message", () => {
  for (const attachments of [null, "bad", 42, {}]) {
    expect(fromZetaEvent({ event: "user_message", text: "keep me", mode: "send", attachments })).toEqual([
      { type: "user_message", text: "keep me", mode: "send" },
    ]);
  }
});

test("a live user_message's attachments become file rows, as history's do", () => {
  // zeta's echo of a send_images turn: each stored image by name, type, and size, never its bytes.
  const attachments = [{ name: "circle.png", mime_type: "image/png", size: 2093 }, { size: 3 }];
  expect(fromZetaEvent({ event: "user_message", text: "describe this", mode: "send", attachments })).toEqual([
    { type: "user_message", text: "describe this", mode: "send", attachments: [{ type: "file", filename: "circle.png", mediaType: "image/png", size: 2093 }] },
  ]);
});

test("usage keeps the token counts and drops the provider details zeta passes through", () => {
  // A real usage event from zeta serve with an anthropic model (session id removed): counts beside strings and objects.
  const usage = { input_tokens: 4, cache_creation_input_tokens: 97, cache_read_input_tokens: 6287, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 97 }, output_tokens: 189, service_tier: "standard", inference_geo: "global", speed: "standard", output_tokens_details: { thinking_tokens: 157 } };
  expect(fromZetaEvent({ event: "usage", usage })).toEqual([{ type: "usage", usage: { input_tokens: 4, cache_creation_input_tokens: 97, cache_read_input_tokens: 6287, output_tokens: 189 } }]);
});

test("usage treats malformed containers as empty maps and keeps only nonnegative finite counts", () => {
  for (const usage of [null, [], "bad", 42]) {
    expect(fromZetaEvent({ event: "usage", usage })).toEqual([{ type: "usage", usage: {} }]);
  }
  expect(fromZetaEvent({ event: "usage", usage: { zero: 0, negative: -1, nan: NaN, infinity: Infinity, good: 3 } })).toEqual([{ type: "usage", usage: { zero: 0, good: 3 } }]);
});

test("usage accepts an own constructor key and history usage cannot update calls", () => {
  expect(fromZetaEvent({ event: "usage", usage: { constructor: null, input_tokens: 2 } })).toEqual([{ type: "usage", usage: { input_tokens: 2 } }]);
  const events = fromZetaHistory([
    { id: "call", role: "assistant", content: [{ type: "tool_use", tool_call: { id: "call", name: "bash", arguments: {} } }] },
    { id: "u", role: "system", event: "usage", usage: { input_tokens: 2 }, tool_call: { id: "call", name: "injected", arguments: { x: 1 } }, content: [] },
    { id: "result", role: "tool", tool_result: { tool_call_id: "call", content: "ok", is_error: false }, content: [] },
  ]);
  expect(events.at(-1)).toMatchObject({ type: "tool_end", tool_call: { name: "bash" } });
});

test("history usage rows use the live usage mapping", () => {
  expect(fromZetaHistory([{ id: "u", role: "system", event: "usage", usage: { input_tokens: 2 }, content: [] }])).toEqual([{ type: "usage", usage: { input_tokens: 2 } }]);
});

test("served_turn_end history rows add no transcript row", () => {
  // Row shape from zeta event_contract.served_turn_end_row (docs/serve-protocol.md, feature served_turn_end).
  const rows = [
    { id: "u1", role: "user", content: [{ type: "text", text: "hi" }], tool_result: null },
    { id: "a1", role: "assistant", content: [{ type: "text", text: "done" }], tool_result: null },
    { id: "e1", role: "system", event: "served_turn_end", data: { turn_id: "a1b2c3d4e5f60718293a4b5c6d7e8f90", reason: "completed" } },
  ];
  expect(fromZetaHistory(rows).map((event) => event.type)).toEqual(["user_message", "message_commit"]);
});
