import { expect, test } from "bun:test";
import { createRunStore, MAX_DATA_IMAGE_CHARS, safeUrl, type RunEvent } from "../src/index.js";

const replay = (events: RunEvent[]) => {
  const store = createRunStore((flush) => flush());
  events.forEach(store.dispatch);
  return store;
};
const read = (store: ReturnType<typeof replay>, id: string) => {
  const item = store.getItem(id);
  if (item?.type !== "message") throw new Error("no message");
  return { content: item.message.content, text: item.text };
};

test("streamed text, reasoning, and blocks keep the order they arrived in", () => {
  const source = { type: "source", kind: "source", url: "https://example.com", title: "Example" };
  const store = replay([
    { type: "message_delta", message_id: "m", delta: "first " },
    { type: "message_delta", message_id: "m", delta: "text" },
    { type: "message_delta", message_id: "m", kind: "reasoning", delta: "think " },
    { type: "message_delta", message_id: "m", kind: "reasoning", delta: "more" },
    { type: "message_block", message_id: "m", block: source },
    { type: "message_delta", message_id: "m", delta: "after" },
  ]);
  expect(read(store, "message:m")).toEqual({
    content: [{ type: "text", text: "first text" }, { type: "reasoning", text: "think more" }, source],
    text: "after",
  });
});

test("a streamed block keeps the identity of the blocks before it", () => {
  const store = replay([
    { type: "message_delta", message_id: "m", kind: "reasoning", delta: "a" },
    { type: "message_block", message_id: "m", block: { type: "file", kind: "file", url: "https://example.com/a.txt" } },
  ]);
  const before = read(store, "message:m").content[0];
  store.dispatch({ type: "message_delta", message_id: "m", kind: "reasoning", delta: "b" });
  const after = read(store, "message:m").content;
  expect(after[0]).toBe(before!);
  expect(after.map((block) => block.type)).toEqual(["reasoning", "file", "reasoning"]);
});

test("a message_block opens a message row and a commit replaces the stream", () => {
  const store = replay([{ type: "message_block", message_id: "m", block: { type: "image", url: "https://example.com/a.png" } }]);
  expect(store.getOutline()).toEqual([{ id: "message:m", kind: "message" }]);
  expect(store.getItem("message:m")).toMatchObject({ active: true });
  store.dispatch({ type: "message_commit", message_id: "m", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
  expect(store.getItem("message:m")).toMatchObject({ active: false, message: { content: [{ type: "text", text: "done" }] } });
});

test("safeUrl allows http, https, mailto, and relative links, and nothing else", () => {
  for (const url of ["https://example.com/a?b#c", "http://example.com", "mailto:a@example.com", "/files/a.png", "a.png", "#top", " HTTPS://example.com "])
    expect(safeUrl(url)).toBe(url.trim());
  for (const url of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "java\tscript:alert(1)", " javascript:alert(1)", "\u0000javascript:alert(1)", "vbscript:x", "data:text/html,<script>alert(1)</script>", "data:image/png;base64,eA==", "file:///etc/passwd", "blob:https://example.com/x", "//evil.example/x", "\\\\evil.example\\x", "ftp://example.com"])
    expect(safeUrl(url)).toBeUndefined();
  expect(safeUrl(undefined)).toBeUndefined();
  expect(safeUrl(42)).toBeUndefined();
});

test("safeUrl allows inline raster images under the size cap only", () => {
  expect(safeUrl("data:image/png;base64,iVBORw0KGgo=", "image")).toBe("data:image/png;base64,iVBORw0KGgo=");
  expect(safeUrl("https://example.com/a.png", "image")).toBe("https://example.com/a.png");
  for (const url of ["data:image/svg+xml;base64,PHN2Zz4=", "data:image/svg+xml,<svg onload=alert(1)>", "data:text/html;base64,PHNjcmlwdD4=", "data:image/png,raw", "data:image/png;base64,<script>", "javascript:alert(1)"])
    expect(safeUrl(url, "image")).toBeUndefined();
  const big = "data:image/png;base64," + "A".repeat(MAX_DATA_IMAGE_CHARS);
  expect(safeUrl(big, "image")).toBeUndefined();
});
