import { expect, test } from "bun:test";
import { fromZetaEvent, fromZetaHistory } from "../src/index.js";

// Block shapes from zeta's protocol/types.py (ThinkingContent, ImageContent, RedactedThinkingContent) and the
// assistant_delta kinds from server/control.py ("assistant" for text, the content type, "thinking", otherwise).
test("maps zeta thinking, images, and redacted thinking to fulcrum content blocks", () => {
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
        { type: "image", data: "aGVsbG8=", mimeType: "image/png", path: "/tmp/shots/shot.png", size: 5 },
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
        { type: "image", url: "data:image/png;base64,aGVsbG8=", mediaType: "image/png", filename: "shot.png", size: 5 },
      ],
    },
  });
  const history = fromZetaHistory([{ id: "h", role: "assistant", content: [{ type: "thinking", text: "why", body: "why" }, { type: "text", text: "because" }], tool_result: null }]);
  expect(history).toEqual([{ type: "message_commit", message_id: "h", message: { role: "assistant", content: [{ type: "reasoning", text: "why" }, { type: "text", text: "because" }] } }]);
});
