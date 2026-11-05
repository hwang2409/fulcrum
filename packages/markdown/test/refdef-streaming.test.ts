import { expect, test } from "bun:test";
import { createStreamingDocument, parseMarkdown, type Block, type Inline } from "../src/index.js";

const inlineText = (nodes: readonly Inline[], provisional: boolean): string => nodes.map((node) =>
  node.type === "pending-reference" ? provisional ? node.value : ""
    : node.type === "text" || node.type === "code" ? node.value
      : node.type === "break" ? "\n"
        : node.type === "image" ? node.alt
          : "children" in node ? inlineText(node.children, provisional) : "").join("");

const visible = (blocks: readonly Block[], provisional = false): string => blocks.map((block) =>
  block.type === "paragraph" || block.type === "heading" ? inlineText(block.children, provisional)
    : block.type === "blockquote" ? visible(block.children, provisional)
      : block.type === "list" ? block.items.map((item) => visible(item.children, provisional)).join("")
        : block.type === "table" ? block.rows.flat().map((cell) => inlineText(cell, provisional)).join("")
          : block.type === "code" ? block.value : "").join("");

const subsequence = (needle: string, haystack: string) => {
  let offset = 0;
  for (const character of haystack) if (character === needle[offset]) offset++;
  return offset === needle.length;
};

function stream(source: string, chunks: readonly number[]) {
  const document = createStreamingDocument();
  let previous = "";
  let offset = 0;
  let chunk = 0;
  while (offset < source.length) {
    const start = offset;
    offset = Math.min(source.length, offset + chunks[chunk++ % chunks.length]!);
    document.append(source.slice(start, offset));
    const current = visible(document.render());
    expect(subsequence(previous, current), `${JSON.stringify(source)} at ${offset}: ${JSON.stringify(previous)} -> ${JSON.stringify(current)}`).toBe(true);
    previous = current;
  }
  const beforeFinish = visible(document.render());
  document.finish();
  const final = parseMarkdown(source);
  expect(subsequence(beforeFinish, visible(final)), `${JSON.stringify(source)}: ${JSON.stringify(beforeFinish)} -> ${JSON.stringify(visible(final))}`).toBe(true);
  expect(JSON.stringify(document.render())).toBe(JSON.stringify(final));
}

test("a possible reference definition after a lazy empty quote never retracts text", () => {
  const source = ".\n>\n[s]:\"\n";
  for (let mask = 0; mask < 512; mask++) {
    const chunks: number[] = [];
    for (let bit = 0; bit < 9; bit++) chunks.push(mask & (1 << bit) ? 2 : 1);
    stream(source, chunks);
  }
});

test("reference-definition shapes stay monotonic at every character boundary", () => {
  const sources = [
    "[top]: https://example.com",
    "> [quote]: https://example.com",
    "- [item]: https://example.com",
    "before\n\n[after]: https://example.com",
    "[plain]: https://example.com \"title\"",
    "[next]: https://example.com\n\"title\"",
    "[unterminated]: https://example.com \"title",
    "[escaped\\]label]: https://example.com",
    "[crlf]: https://example.com\r\n",
    "paragraph\n[s]: https://example.com",
  ];
  for (const source of sources) stream(source, [1]);
});
