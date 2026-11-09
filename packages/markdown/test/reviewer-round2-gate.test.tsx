import { expect, test } from "bun:test";
import { createStreamingDocument, parseMarkdown, type Block, type Inline } from "../src/index.js";
import { withoutDelimiterCells } from "./accepted-changes.js";

const json = (blocks: readonly Block[]) => JSON.stringify(blocks, (key, value) => key === "open" ? undefined : value);

function inlineVisible(nodes: readonly Inline[], includeProvisional = true): string {
  return nodes.map((node) => node.type === "pending-reference" ? includeProvisional ? node.value : ""
    : node.type === "text" || node.type === "code" ? node.value
    : node.type === "image" ? node.alt
    : node.type === "break" ? "\n"
    : inlineVisible(node.children, includeProvisional)).join("");
}

// A delimiter row arriving shows as sent until it completes (accepted-changes.ts).
function visible(blocks: readonly Block[], includeProvisional = true): string {
  return blocks.map((block) => block.type === "paragraph" || block.type === "heading" ? withoutDelimiterCells(inlineVisible(block.children, includeProvisional))
    : block.type === "code" ? block.value
    : block.type === "blockquote" ? visible(block.children, includeProvisional)
    : block.type === "list" ? block.items.map((item) => visible(item.children, includeProvisional)).join("")
    : block.type === "table" ? [...block.header, ...block.rows.flat()].map((cell) => inlineVisible(cell, includeProvisional)).join("")
    : "").join("").replace(/[\s|]/g, "");
}

function isSubsequence(needle: string, haystack: string) {
  const wanted = [...needle];
  let offset = 0;
  for (const character of haystack) if (character === wanted[offset]) offset++;
  return offset === wanted.length;
}

function expectMonotonic(source: string) {
  const document = createStreamingDocument();
  let previousStable = "";
  for (const character of source) {
    document.append(character);
    const blocks = document.render();
    expect(isSubsequence(previousStable, visible(blocks)), JSON.stringify(source.slice(0, source.indexOf(character) + 1))).toBe(true);
    previousStable = visible(blocks, false);
  }
}

test("pending preview advances beyond 1,024 characters", () => {
  const document = createStreamingDocument();
  document.append("a".repeat(1_025));
  expect(visible(document.render())).toHaveLength(1_025);
});

test("task-list marker prefixes never retract visible text", () => {
  expectMonotonic("- [x] complete\n  - [ ] pending");
});

test("a later reference definition updates a table cell", () => {
  const source = "| check |\n| --- |\n| Use [shared]. |\n\n[shared]: https://example.com/docs\n\n";
  const document = createStreamingDocument();
  document.append(source);
  expect(json(document.render())).toBe(json(parseMarkdown(source)));
});

test("a crlf pair split across chunks stays one newline", () => {
  const source = "> - first\r\n>   second\r\n";
  const document = createStreamingDocument();
  for (const character of source) document.append(character);
  document.finish();
  expect(json(document.render())).toBe(json(parseMarkdown(source)));
});

test("nested block-marker prefixes never retract visible text", () => {
  expectMonotonic("> - | a | b |\n>   | :- | -: |\n>   | one | two |");
});
