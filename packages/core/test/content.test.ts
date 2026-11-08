import { expect, test } from "bun:test";
import { createRunStore, MAX_URL_CHARS, safeUrl, type RunEvent } from "../src/index.js";

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

test("interleaved text, kind-tagged deltas, and blocks preserve the replay result", () => {
  const source = { type: "source", url: "https://example.com/source" };
  const store = replay([
    { type: "message_delta", message_id: "m", delta: "answer one" },
    { type: "message_delta", message_id: "m", kind: "reasoning", delta: "reason one" },
    { type: "message_delta", message_id: "m", kind: "reasoning", delta: " + two" },
    { type: "message_block", message_id: "m", block: source },
    { type: "message_delta", message_id: "m", kind: "analysis", delta: "analysis" },
    { type: "message_delta", message_id: "m", delta: "answer two" },
  ]);

  expect(read(store, "message:m")).toEqual({
    content: [
      { type: "text", text: "answer one" },
      { type: "reasoning", text: "reason one + two" },
      source,
      { type: "analysis", text: "analysis" },
    ],
    text: "answer two",
  });
  expect(store.getState()).toEqual({
    turns: [],
    outline: [{ id: "message:m", kind: "message" }],
    usage: {},
    agent: "idle",
    turn: "idle",
    receipts: {},
    receiptOrder: [],
    nextId: 2,
    activeMessageId: "m",
    activeToolIds: {},
    toolApprovals: {},
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

test("kind-tagged deltas preserve other fields on the block they extend", () => {
  const store = replay([
    { type: "message_block", message_id: "m", block: { type: "reasoning", text: "one", provider: "test" } },
    { type: "message_delta", message_id: "m", kind: "reasoning", delta: " two" },
    { type: "message_delta", message_id: "m", kind: "reasoning", delta: " three" },
  ]);

  expect(read(store, "message:m").content).toEqual([
    { type: "reasoning", text: "one two three", provider: "test" },
  ]);
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
  const prefix = "data:image/png;base64,";
  expect(safeUrl(prefix + "A".repeat(MAX_URL_CHARS - prefix.length), "image")).toBeDefined();
  expect(safeUrl(prefix + "A".repeat(MAX_URL_CHARS - prefix.length + 1), "image")).toBeUndefined();
  // The cap reads the raw length before any other work: padding is not trimmed away first.
  expect(safeUrl(" ".repeat(MAX_URL_CHARS) + "a.png", "image")).toBeUndefined();
});

test("a stream that restarts a finished message replaces its blocks instead of appending to them", () => {
  const store = replay([
    { type: "message_commit", message_id: "m", message: { role: "assistant", content: [{ type: "text", text: "old" }, { type: "reasoning", text: "old thought" }] } },
    { type: "message_delta", message_id: "m", delta: "new" },
  ]);
  expect(read(store, "message:m")).toEqual({ content: [], text: "new" });
  store.dispatch({ type: "message_commit", message_id: "m", message: { role: "assistant", content: [{ type: "text", text: "old" }] } });
  store.dispatch({ type: "message_delta", message_id: "m", kind: "reasoning", delta: "again" });
  expect(read(store, "message:m")).toEqual({ content: [{ type: "reasoning", text: "again" }], text: undefined });
});
