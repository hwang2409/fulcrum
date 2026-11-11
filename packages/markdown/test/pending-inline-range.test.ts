import { expect, test } from "bun:test";
import { createStreamingDocument, parseMarkdown } from "../src/index.js";

function stream(source: string, size: number) {
  const document = createStreamingDocument();
  for (let offset = 0; offset < source.length; offset += size) {
    document.append(source.slice(offset, offset + size));
    expect(() => document.render()).not.toThrow();
  }
  document.finish();
  expect(JSON.stringify(document.render())).toBe(JSON.stringify(parseMarkdown(source)));
}

test("does not resolve a new emphasis opener as an emitted node", () => {
  const source = `[${"a".repeat(150)}] *x y**${"b".repeat(200)}`;
  const document = createStreamingDocument();
  document.append(source.slice(0, 129));
  expect(() => document.render()).not.toThrow();
  document.append(source.slice(129));
  expect(() => document.render()).not.toThrow();
  document.finish();
  expect(JSON.stringify(document.render())).toBe(JSON.stringify(parseMarkdown(source)));
});

test("matches the one-shot tree for seeded rich text at every append range", () => {
  let state = 0x6d2b79f5;
  const next = () => {
    state = Math.imul(state ^ (state >>> 15), state | 1);
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
    return ((state ^ (state >>> 14)) >>> 0) / 0x1_0000_0000;
  };
  const words = ["[link](https://example.com)", "**bold**", "`code`", "_em_", "plain", "[open", "x**", "~tilde~"];
  let source = "";
  while (source.length < 180) source += words[Math.floor(next() * words.length)] + " ";
  for (let size = 1; size <= 512; size++) stream(source, size);
});
