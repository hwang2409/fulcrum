import { expect, test } from "bun:test";
import { createStreamingDocument, type Block, type Inline } from "../src/index.js";

const PENDING_INLINE_SUFFIX_BUDGET = 256;

function text(nodes: readonly Inline[]): string {
  return nodes.map((node) => node.type === "text" || node.type === "pending-reference" || node.type === "code"
    ? node.value
    : node.type === "break" ? "\n"
      : "children" in node ? text(node.children) : node.type === "image" ? node.alt : "").join("");
}

function stableText(nodes: readonly Inline[]): string {
  return nodes.map((node) => node.type === "pending-text" || node.type === "pending-reference" ? ""
    : node.type === "text" || node.type === "code" ? node.value
      : node.type === "break" ? "\n"
        : "children" in node ? stableText(node.children) : node.type === "image" ? node.alt : "").join("");
}

function stableVisible(blocks: readonly Block[]): string {
  return blocks.map((block) => block.type === "paragraph" || block.type === "heading" ? stableText(block.children)
    : block.type === "code" ? block.value
      : block.type === "blockquote" ? stableVisible(block.children)
        : block.type === "list" ? block.items.map((item) => stableVisible(item.children)).join("")
          : block.type === "table" ? [...block.header, ...block.rows.flat()].map(stableText).join("") : "").join("");
}

function subsequence(before: string, after: string) {
  let cursor = 0;
  for (const character of after) if (character === before[cursor]) cursor++;
  return cursor === before.length;
}

function visible(blocks: readonly Block[]): string {
  return blocks.map((block) => block.type === "paragraph" || block.type === "heading" ? text(block.children)
    : block.type === "code" ? block.value
      : block.type === "blockquote" ? visible(block.children)
        : block.type === "list" ? block.items.map((item) => visible(item.children)).join("")
          : block.type === "table" ? [...block.header, ...block.rows.flat()].map(text).join("") : "").join("");
}

function provisional(nodes: readonly Inline[]): number {
  return nodes.reduce((total, node) => total + (node.type === "pending-text" ? text(node.children).length
    : "children" in node ? provisional(node.children) : 0), 0);
}

function provisionalIn(blocks: readonly Block[]): number {
  return blocks.reduce((total, block) => total + (block.type === "paragraph" || block.type === "heading" ? provisional(block.children)
    : block.type === "blockquote" ? provisionalIn(block.children)
      : block.type === "list" ? block.items.reduce((sum, item) => sum + provisionalIn(item.children), 0)
        : block.type === "table" ? [...block.header, ...block.rows.flat()].reduce((sum, cell) => sum + provisional(cell), 0) : 0), 0);
}

for (const [name, source, stableCharacters] of [
  ["unclosed bracket", `[${"x".repeat(100_000)}`, 100_000],
  ["setext underline candidate", `heading\n${"=".repeat(100_000)}`, 100_000],
] as const) test(`${name} keeps hidden and provisional text bounded at every prefix`, () => {
  const document = createStreamingDocument();
  for (let offset = 0; offset < source.length; offset += 1_024) {
    document.append(source.slice(offset, offset + 1_024));
    const blocks = document.render();
    const received = Math.min(offset + 1_024, source.length);
    const expectedStable = name === "unclosed bracket" ? Math.max(0, received - 1) : Math.max(0, received - "heading\n".length);
    const hiddenStable = expectedStable - visible(blocks).replace("heading", "").length;
    expect(hiddenStable + provisionalIn(blocks), `prefix ${received}`).toBeLessThanOrEqual(PENDING_INLINE_SUFFIX_BUDGET);
  }
  expect(visible(document.render())).toContain("x".repeat(name === "unclosed bracket" ? stableCharacters : 0));
});

test("a late closer restyles retained characters without removing or reordering them", () => {
  const label = "retained ".repeat(200);
  const document = createStreamingDocument();
  document.append(`[${label}](`);
  const before = stableVisible(document.render());
  expect(before.length).toBeGreaterThan(label.length - PENDING_INLINE_SUFFIX_BUDGET);
  document.append("https://example.com)");
  const after = stableVisible(document.render());
  expect(subsequence(before, after)).toBe(true);
  expect(after).toBe(label);
  expect(document.render()[0]?.type === "paragraph" && document.render()[0].children[0]?.type).toBe("link");
});

test("an unresolved owner copies only the delta and bounded suffix", () => {
  const source = ("**strong** *emphasis* `code` [link](https://example.com) [" + "plain **strong** and *emphasis* with `code`. ".repeat(24_000)).slice(0, 1_000_000);
  const document = createStreamingDocument();
  for (let offset = 0; offset < source.length; offset += 1_024) {
    const copied = document.stats.copiedCharacters;
    document.append(source.slice(offset, offset + 1_024));
    document.render();
    expect(document.stats.copiedCharacters - copied, `offset ${offset}`).toBeLessThanOrEqual(1_024 + PENDING_INLINE_SUFFIX_BUDGET);
  }
});
