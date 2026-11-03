import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createStreamingDocument, parseMarkdown, type Block, type Inline } from "../src/index.js";
import { Markdown } from "../src/react.js";

const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

test("bounds 100 KB quote > list > quote work", () => {
  const unit = "> - outer item\n>   > deepest leaf keeps streaming words and `code` safely.\n";
  const source = unit.repeat(Math.ceil(100_000 / unit.length)).slice(0, 100_000);
  const document = createStreamingDocument();
  const work: number[] = [];
  for (let offset = 0; offset < source.length; offset += 20) {
    const before = document.stats.scannedCharacters;
    document.append(source.slice(offset, offset + 20));
    document.render();
    work.push(document.stats.scannedCharacters - before);
  }
  const quarter = Math.floor(work.length / 4);
  const ratio = average(work.slice(quarter * 3, quarter * 4)) / average(work.slice(quarter, quarter * 2));
  expect(ratio).toBeLessThanOrEqual(1.2);
}, 60_000);

test("hides the spaced nested-quote table prefix", () => {
  const source = [
    "# report 1",
    "",
    "> - nested quote-list",
    ">   > inner quote with **strong**, *emphasis*, ~~strike~~, and `code`.",
    ">   >",
    ">   > |",
  ].join("\n");
  const html = renderToStaticMarkup(<Markdown source={source} streaming />);
  expect(html).not.toContain("|");
});

const json = (blocks: readonly Block[]) => JSON.stringify(blocks, (key, value) => key === "open" ? undefined : value);

function inlineText(nodes: readonly Inline[]): string {
  return nodes.map((node) => node.type === "text" || node.type === "pending-reference" || node.type === "code"
    ? node.value
    : node.type === "image" ? node.alt
      : node.type === "break" ? "\n" : inlineText(node.children)).join("");
}

function visibleText(blocks: readonly Block[]): string {
  return blocks.map((block) => {
    if (block.type === "paragraph" || block.type === "heading") return inlineText(block.children);
    if (block.type === "code") return block.value;
    if (block.type === "blockquote") return visibleText(block.children);
    if (block.type === "list") return block.items.map((item) => visibleText(item.children)).join("");
    if (block.type === "table") return [...block.header, ...block.rows.flat()].map(inlineText).join("");
    return "";
  }).join("");
}

const quote = (source: string) => source.split("\n").map((line) => `> ${line}`).join("\n");
const list = (source: string) => source.split("\n").map((line, index) => `${index ? "  " : "- "}${line}`).join("\n");

function generatedShape(seed: number) {
  let state = seed;
  const random = () => (state = Math.imul(state ^ state >>> 15, 1 | state), ((state ^ state >>> 7) >>> 0) / 0x1_0000_0000);
  const leaves = [
    "paragraph with **strong words** and [known][].",
    "| check | result |\n| --- | ---: |\n| package | passing |",
    "```ts\nconst value = 1;\n```",
    "reference uses [known].\n\n[known]: https://example.com/docs",
  ];
  const sections = Array.from({ length: 12 }, (_, index) => {
    let source = leaves[Math.floor(random() * leaves.length)]!;
    const depth = index === 0 ? 6 : Math.floor(random() * 7);
    for (let level = 0; level < depth; level++) source = random() < 0.5 ? quote(source) : list(source);
    return source;
  });
  const unit = `${sections.join("\n\n")}\n\n`;
  const quarter = unit.repeat(Math.ceil(25_000 / unit.length)).slice(0, 25_000);
  return quarter.repeat(4);
}

function boundedWork(work: number[], bounds: number[]) {
  for (let index = 0; index < work.length; index++)
    if (work[index]! > bounds[index]!) throw new Error(`unbounded parser work at delta ${index}: ${work[index]} > ${bounds[index]}`);
  const quarter = Math.max(1, Math.floor(work.length / 4));
  return average(work.slice(quarter * 3, quarter * 4)) / Math.max(average(work.slice(quarter, quarter * 2)), 1);
}

test("random recursive containers stay safe, equal, and bounded", () => {
  const splitSizes = [1, 2, 7, 20, 1000];
  for (const seed of [7, 29]) {
    const source = generatedShape(seed);
    const expected = json(parseMarkdown(source));
    for (const split of splitSizes) {
      const document = createStreamingDocument();
      const work: number[] = [];
      const bounds: number[] = [];
      for (let offset = 0; offset < source.length; offset += split) {
        const delta = source.slice(offset, offset + split);
        const before = document.stats.scannedCharacters;
        document.append(delta);
        const blocks = document.render();
        work.push(document.stats.scannedCharacters - before);
        const openLeafLength = document.source.length - document.source.lastIndexOf("\n") - 1;
        bounds.push(2048 * (6 + delta.length + openLeafLength));
      }
      const ratio = boundedWork(work, bounds);
      expect(ratio, `seed ${seed}, split ${split}`).toBeLessThanOrEqual(1.2);
      document.finish();
      expect(json(document.render())).toBe(expected);
    }
  }
}, 60_000);

// The same gate must reject retained-source scans at every possible container depth.
test("the work gate rejects an unbounded scan at every container depth", () => {
  for (let depth = 0; depth <= 6; depth++) {
    const allowed = 64 * (depth + 20 + 40);
    expect(() => boundedWork([20, allowed + 1], [allowed, allowed])).toThrow("unbounded parser work");
  }
});

test("keeps 1-byte mixed-quote benchmark work bounded", () => {
  const unit = "> summary\n>\n> - completed step\n>\n> ```ts\n> const value = 1;\n> ```\n>\n";
  const source = unit.repeat(Math.ceil(100_000 / unit.length)).slice(0, 100_000);
  const document = createStreamingDocument();
  const work: number[] = [];
  for (const character of source) {
    const before = document.stats.scannedCharacters;
    document.append(character);
    document.render();
    work.push(document.stats.scannedCharacters - before);
  }
  const bounds = work.map(() => 256 * (6 + 1 + unit.length));
  expect(boundedWork(work, bounds)).toBeLessThanOrEqual(1.2);
});
