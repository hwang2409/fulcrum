import { expect, test } from "bun:test";
import { createStreamingDocument, parseMarkdown, type Block } from "../src/index.js";

const splits = [1, 2, 3, 7, 20, 1000];
const json = (blocks: readonly Block[]) => JSON.stringify(blocks, (key, value) => key === "open" ? undefined : value);

function stream(source: string, split: number) {
  const document = createStreamingDocument();
  for (let offset = 0; offset < source.length; offset += split) {
    document.append(source.slice(offset, offset + split));
    document.render();
  }
  document.finish();
  return document;
}

test("quote lazy continuation rejects parent block openers", () => {
  const sources = [
    "> text\n---\n",
    "> text\n# heading\n",
    "> text\n```js\ncode\n```\n",
    "> text\n- item\n",
    "> text\n\nnext\n",
    "> text\n    indented\n",
    ">*s*\n    >",
  ];
  for (const source of sources) for (const split of splits) {
    const document = stream(source, split);
    expect(json(document.render()), `${JSON.stringify(source)}, split ${split}`).toBe(json(parseMarkdown(source)));
    document.finish();
    expect(json(document.render()), `finished ${JSON.stringify(source)}, split ${split}`).toBe(json(parseMarkdown(source)));
  }
});

test("quote lazy continuation never promotes a setext underline", () => {
  for (const underline of ["---", "==="]) for (const split of splits) {
    const source = `> text\n${underline}\n`;
    expect(json(stream(source, split).render()), `${underline}, split ${split}`).toBe(json(parseMarkdown(source)));
  }
});

test("a whitespace-only unfinished line after a table never throws or adds a row", () => {
  for (const suffix of [" ", "   ", "\t"]) for (const split of splits) {
    const source = `| a | b |\n| --- | --- |\n| 1 | 2 |\n${suffix}`;
    const document = createStreamingDocument();
    for (let offset = 0; offset < source.length; offset += split) {
      document.append(source.slice(offset, offset + split));
      expect(() => document.render(), `${JSON.stringify(suffix)}, split ${split}`).not.toThrow();
    }
    document.finish();
    expect(json(document.render())).toBe(json(parseMarkdown(source)));
  }
});

test("an empty list item does not consume the next unindented block", () => {
  for (const source of ["1. \n.", " 1.\n.", "- \noutside", "- 1.\n.", "- text\n>"]) for (const split of splits)
    expect(json(stream(source, split).render()), `${JSON.stringify(source)}, split ${split}`).toBe(json(parseMarkdown(source)));
});

test("an unfinished task marker never flashes as a reference", () => {
  const source = "- [x] complete";
  for (const split of splits) {
    const document = createStreamingDocument();
    for (let offset = 0; offset < source.length; offset += split) {
      document.append(source.slice(offset, offset + split));
      expect(json(document.render())).not.toContain("pending-reference");
    }
    document.finish();
    expect(json(document.render())).toBe(json(parseMarkdown(source)));
  }
});

test("an indented empty quote stays inside an empty list item", () => {
  const source = "3.\n     >";
  for (const split of splits) expect(json(stream(source, split).render())).toBe(json(parseMarkdown(source)));
});

test("lazy continuation reaches a nested quote paragraph", () => {
  const source = "2. >.\ns";
  for (const split of splits) expect(json(stream(source, split).render())).toBe(json(parseMarkdown(source)));
});

test("a container after leading blank lines stays visible", () => {
  for (const source of ["\n>", "text\n>", "\n\n- item"]) for (const split of splits)
    expect(json(stream(source, split).render())).toBe(json(parseMarkdown(source)));
});

test("a nested hard-break marker never flashes as text", () => {
  for (const source of ["> - line\\\n>   second", "- > line\\\n  > second"]) for (const split of splits) {
    const document = createStreamingDocument();
    for (let offset = 0; offset < source.length; offset += split) {
      document.append(source.slice(offset, offset + split));
      expect(json(document.render())).not.toContain("line\\\\");
    }
    document.finish();
    expect(json(document.render())).toBe(json(parseMarkdown(source)));
  }
});

test("a closing fence commits before the following block", () => {
  const source = "~~~sh\nprintf safe\n~~~\n\n- item";
  for (const split of splits) expect(json(stream(source, split).render())).toBe(json(parseMarkdown(source)));
});

test("a complete thematic break at eof is not withheld", () => {
  for (const source of ["---", "- item\n\n---"]) for (const split of splits)
    expect(json(stream(source, split).render())).toBe(json(parseMarkdown(source)));
});

test("a container opener terminates a table instead of becoming a row", () => {
  const source = "| one |\n| - |\n2. > ---\n";
  for (const split of splits) {
    const document = stream(source, split);
    expect(json(document.render()), `split ${split}`).toBe(json(parseMarkdown(source)));
    document.finish();
    expect(json(document.render()), `finished split ${split}`).toBe(json(parseMarkdown(source)));
  }
});

test("a single-column table stays visible before a whitespace-only unfinished line", () => {
  const source = "| a |\n| - |\n ";
  for (const split of splits) {
    const document = stream(source, split);
    expect(json(document.render()), `split ${split}`).toBe(json(parseMarkdown(source)));
    document.finish();
    expect(json(document.render()), `finished split ${split}`).toBe(json(parseMarkdown(source)));
  }
});
