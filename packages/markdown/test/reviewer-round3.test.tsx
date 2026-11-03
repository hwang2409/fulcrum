import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createStreamingDocument, parseMarkdown, type Block, type Inline } from "../src/index.js";
import { Markdown } from "../src/react.js";
import { MarkdownLineResolver, PENDING_INLINE_SUFFIX_BUDGET } from "../src/resolver.js";

function inlineVisible(nodes: readonly Inline[], provisional: boolean): string {
  return nodes.map((node) => node.type === "pending-reference"
    ? provisional ? node.value : ""
    : node.type === "pending-text" ? provisional ? inlineVisible(node.children, provisional) : ""
    : node.type === "text" || node.type === "code" ? node.value
    : node.type === "image" ? node.alt
    : node.type === "break" ? "\n"
    : inlineVisible(node.children, provisional)).join("");
}

function visible(blocks: readonly Block[], provisional = true): string {
  return blocks.map((block) => block.type === "paragraph" || block.type === "heading" ? inlineVisible(block.children, provisional)
    : block.type === "code" ? block.value
    : block.type === "blockquote" ? visible(block.children, provisional)
    : block.type === "list" ? block.items.map((item) => visible(item.children, provisional)).join("")
    : block.type === "table" ? [...block.header, ...block.rows.flat()].map((cell) => inlineVisible(cell, provisional)).join("")
    : "").join("");
}

const json = (value: unknown) => JSON.stringify(value, (key, item) => key === "open" ? undefined : item);

test("pending classification is resolver-owned and settles marker suffixes", () => {
  const resolver = new MarkdownLineResolver();
  expect(resolver.classifyPending("> ")).toMatchObject({ kind: "empty", content: "" });
  expect(resolver.classifyPending("> hello")).toMatchObject({ kind: "paragraph", content: "hello", provisional: false });
  expect(resolver.classifyPending("- item")).toMatchObject({ kind: "paragraph", content: "item", provisional: false });
});

test("fence ownership does not reveal text that the next newline retracts", () => {
  const document = createStreamingDocument();
  document.append(">~~~\n4");
  expect(visible(document.render())).toBe("");
  document.append("\n");
  expect(visible(document.render())).toBe("4");
  expect(visible(document.render(), false)).toBe("4");
  document.finish();
  expect(json(document.render())).toBe(json(parseMarkdown(">~~~\n4\n")));
});

test("an empty pipe header never takes ownership of later paragraph text", () => {
  const source = "|\n|-|\nt\n";
  const document = createStreamingDocument();
  for (const character of source) document.append(character);
  expect(visible(document.render())).toContain("t");
  document.finish();
  expect(json(document.render())).toBe(json(parseMarkdown(source)));
});

test("block lookahead keeps plain text stable without provisional styling", () => {
  for (const source of ["left | right\n", "heading\n"]) {
    const markup = renderToStaticMarkup(<Markdown source={source} streaming />);
    expect(markup).not.toContain('data-part="md-text-pending"');
  }
});

test("preview copy work stays bounded for 10 KB, 100 KB, and 1 MB leaves", () => {
  for (const size of [10_000, 100_000, 1_000_000]) {
    const document = createStreamingDocument();
    let previous = 0;
    let maximum = 0;
    for (let offset = 0; offset < size; offset += 1_024) {
      document.append("a".repeat(Math.min(1_024, size - offset)));
      document.render();
      maximum = Math.max(maximum, document.stats.copiedCharacters - previous);
      previous = document.stats.copiedCharacters;
    }
    expect(maximum, `${size} byte leaf`).toBeLessThanOrEqual(1_024 + PENDING_INLINE_SUFFIX_BUDGET);
    expect(document.stats.copiedCharacters, `${size} byte leaf total`).toBeLessThanOrEqual(size + Math.ceil(size / 1_024) * PENDING_INLINE_SUFFIX_BUDGET);
  }
});

test("a held marker never hides text after the marker settles", () => {
  const cases = [[">", " hello", "hello"], ["-", " item", "item"], ["1", ". item", "item"], ["#", " heading", "heading"], ["|", " cell |", "cell"], ["[", "label] text", "label text"]] as const;
  for (const [marker, suffix, expected] of cases) {
    const document = createStreamingDocument();
    document.append(marker);
    expect(visible(document.render())).toBe("");
    document.append(suffix);
    expect(visible(document.render()).replace(/\s/g, " ").trim()).toBe(expected);
  }
});

test("active output excludes text absent from the final parse", () => {
  for (const source of [">\n    >\n", ">\n[s]:'\n"]) {
    const document = createStreamingDocument();
    document.append(source);
    expect(visible(document.render())).toBe(visible(parseMarkdown(source)));
  }
});
