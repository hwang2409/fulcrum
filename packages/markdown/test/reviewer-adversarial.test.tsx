import { expect, test } from "bun:test";
import { createStreamingDocument, parseMarkdown, type Block, type Inline } from "../src/index.js";

const json = (value: unknown) => JSON.stringify(value, (key, child) => key === "open" ? undefined : child);
function inlineVisible(nodes: readonly Inline[], includeProvisional = true): string {
  return nodes.map((node) => node.type === "pending-reference" ? includeProvisional ? node.value : ""
    : node.type === "pending-text" ? includeProvisional ? inlineVisible(node.children, includeProvisional) : ""
    : node.type === "text" || node.type === "code" ? node.value
    : node.type === "image" ? node.alt : node.type === "break" ? "\n"
    : inlineVisible(node.children, includeProvisional)).join("");
}
function visible(blocks: readonly Block[], includeProvisional = true): string {
  return blocks.map((block) => block.type === "paragraph" || block.type === "heading" ? inlineVisible(block.children, includeProvisional)
    : block.type === "code" ? block.value : block.type === "blockquote" ? visible(block.children, includeProvisional)
    : block.type === "list" ? block.items.map((item) => visible(item.children, includeProvisional)).join("")
    : block.type === "table" ? [...block.header, ...block.rows.flat()].map((cell) => inlineVisible(cell, includeProvisional)).join("") : "").join("").replace(/\s/g, "");
}
function provisionalCharacters(blocks: readonly Block[]): number {
  const inline = (nodes: readonly Inline[]): number => nodes.reduce((count, node) => count
    + (node.type === "pending-reference" ? node.value.length
      : node.type === "pending-text" ? inlineVisible(node.children).length
      : "children" in node ? inline(node.children) : 0), 0);
  return blocks.reduce((count, block) => count
    + (block.type === "paragraph" || block.type === "heading" ? inline(block.children)
      : block.type === "blockquote" ? provisionalCharacters(block.children)
      : block.type === "list" ? block.items.reduce((sum, item) => sum + provisionalCharacters(item.children), 0)
      : block.type === "table" ? [...block.header, ...block.rows.flat()].reduce((sum, cell) => sum + inline(cell), 0) : 0), 0);
}

function subsequence(needle: string, haystack: string) {
  const wanted = [...needle];
  let offset = 0;
  for (const character of haystack) if (character === wanted[offset]) offset++;
  return offset === wanted.length;
}

type Case = { name: string; source: string };
const cases: Case[] = [
  { name: "lazy quote paragraph", source: "> alpha\nlazy *continuation*\n\nnext" },
  { name: "lazy nested list", source: "> - alpha\n>   lazy continuation\n>\n>   second paragraph\n\nafter" },
  { name: "tabs nested lists", source: "1.\touter\n\t-\tinner\n\t\tcontinued\n\t\t> quote\n\t\t> lazy\n\nafter" },
  { name: "fence list quote", source: "> - item\n>   ```ts\n>   const π = \"🙂\";\n>   ```\n>\n>   tail" },
  { name: "tilde fence deep", source: "- > 1. ~~~sh\n    >    printf 'safe'\n    >    ~~~\n    >    after" },
  { name: "table after quote list", source: "> - | a | b |\n>   | :- | -: |\n>   | α | 🙂 |\n>\n> after" },
  { name: "table closes to container", source: "| one |\n| - |\n2. > ---\n" },
  { name: "html comment nested", source: "> - <!-- open\n>   still <b>raw</b>\n>   -->\n>   after" },
  { name: "html div nested", source: "> <div>\n> body &amp; text\n> </div>\n\nafter" },
  { name: "references later nested", source: "> - Use [shared] and [full][id].\n>\n> [shared]: https://example.com/a\n> [id]: <https://example.com/b>\n>   \"title next line\"\n" },
  { name: "references definition first", source: "[shared]: https://example.com/a 'title'\n\n> 1. Use [shared].\n" },
  { name: "crlf", source: "> - first\r\n>   second  \r\n>   hard break\r\n\r\nnext\r\n" },
  { name: "unicode whitespace", source: ">\u00a0not-commonmark-space\n-\u2003not-list\n\tindented tab\nαβγ 🙂 e\u0301\n" },
  { name: "markers", source: "1. 3. setext heading\n      ===\n\n> ---\n\n- [x] complete\n" },
  { name: "fence info", source: "> ~~~typescript\n> const x = 1\n> ~~~\n" },
  { name: "reference eof", source: "Use [x].\n\n[x]: https://example.com" },
  { name: "reference title eof", source: "Use [x].\n\n[x]: https://example.com\n\"later title\"" },
];
for (let depth = 1; depth <= 8; depth++) {
  const prefix = Array.from({ length: depth }, (_, index) => index % 2 ? "- " : "> ").join("");
  const indent = "  ".repeat(Math.floor(depth / 2));
  cases.push({ name: `generated depth ${depth}`, source: `${prefix}| h | v |\n${indent}| - | - |\n${indent}| α | 🙂 |\n${indent}\n${indent}\`\`\`js\n${indent}const x = 1\n${indent}\`\`\`` });
}

const encoder = new TextEncoder();
const chunkPlans = [
  { name: "chars-1", chunks: (source: string) => [...source] },
  { name: "chars-3", chunks: (source: string) => { const characters = [...source]; const chunks: string[] = []; for (let index = 0; index < characters.length; index += 3) chunks.push(characters.slice(index, index + 3).join("")); return chunks; } },
  { name: "bytes-1", chunks: (source: string) => { const decoder = new TextDecoder(); const chunks: string[] = []; for (const byte of encoder.encode(source)) { const value = decoder.decode(Uint8Array.of(byte), { stream: true }); if (value) chunks.push(value); } const tail = decoder.decode(); if (tail) chunks.push(tail); return chunks; } },
  { name: "marker-boundaries", chunks: (source: string) => source.split(/(?=[\n\r`~|>\-*+.#\[\]()])/).filter(Boolean) },
];

test("reviewer 25-family generator preserves visible order and final output within the provisional budget", () => {
  expect(cases).toHaveLength(25);
  let renders = 0;
  let shareTotal = 0;
  let maximumShare = 0;
  let maximumCharacters = 0;
  for (const current of cases) for (const plan of chunkPlans) {
    const document = createStreamingDocument();
    let previousStable = "";
    let prefix = "";
    for (const chunk of plan.chunks(current.source)) {
      document.append(chunk);
      prefix += chunk;
      const blocks = document.render();
      const allCharacters = visible(blocks).length;
      const provisional = provisionalCharacters(blocks);
      const share = provisional / Math.max(1, allCharacters);
      renders++;
      shareTotal += share;
      maximumShare = Math.max(maximumShare, share);
      maximumCharacters = Math.max(maximumCharacters, provisional);
      expect(provisional, `${current.name}/${plan.name}: provisional budget`).toBeLessThanOrEqual(256);
      expect(subsequence(previousStable, visible(blocks)), `${current.name}/${plan.name}: ${JSON.stringify(prefix)}: ${JSON.stringify(previousStable)} -> ${JSON.stringify(visible(blocks))}`).toBe(true);
      previousStable = visible(blocks, false);
    }
    document.finish();
    expect(json(document.render()), `${current.name}/${plan.name}`).toBe(json(parseMarkdown(current.source)));
  }
  const meanShare = shareTotal / renders;
  console.log(`provisional share: mean ${(meanShare * 100).toFixed(3)}%, max ${(maximumShare * 100).toFixed(3)}%, max ${maximumCharacters} characters`);
  expect(meanShare).toBeLessThan(0.02);
});
