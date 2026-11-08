import { expect, test } from "bun:test";
import { createStreamingDocument, parseMarkdown, type Block, type Inline } from "../src/index.js";

const text = (nodes: readonly Inline[]): string => nodes.map((node) =>
  node.type === "text" || node.type === "code" || node.type === "pending-reference" ? node.value
  : node.type === "image" ? node.alt
  : node.type === "break" ? "\n"
  : text(node.children)).join("");

// What a reader sees of each block, in order: a paragraph's text, or a table's cells.
const shown = (blocks: readonly Block[]) => blocks.map((block) => block.type === "paragraph" ? `p:${text(block.children)}`
  : block.type === "table" ? `table:${[...block.header, ...block.rows.flat()].map(text).join("|")}` : block.type);

// Every frame of `source` streamed in `split`-sized deltas.
function frames(source: string, split: number) {
  const document = createStreamingDocument();
  const seen: string[][] = [];
  for (let offset = 0; offset < source.length; offset += split) {
    document.append(source.slice(offset, offset + split));
    seen.push(shown(document.render()));
  }
  return seen;
}

const source = "Every check passed:\n\n| name | status |\n| --- | --- |\n| typecheck | pass |\n";
for (const split of [1, 3, 7, 1000]) {
  test(`a table header row shows as sent, then as the table, never as glued prose (split ${split})`, () => {
    for (const frame of frames(source, split)) {
      // The row shows raw (its pipes kept) or as the table: never as a paragraph of its cell words run together.
      expect(frame.some((block) => block.startsWith("p:") && /name[^|]*status/.test(block)), JSON.stringify(frame)).toBe(false);
    }
    // Once the rows end, the stream shows what the whole source parses to.
    expect(frames(source, split).at(-1)).toEqual(shown(parseMarkdown(source)));
  });
}

// Everything a reader sees, blocks flattened, in order.
const visible = (blocks: readonly Block[]): string => blocks.map((block) => block.type === "paragraph" || block.type === "heading" ? text(block.children)
  : block.type === "table" ? [...block.header, ...block.rows.flat()].map(text).join(" ")
  : block.type === "blockquote" ? visible(block.children)
  : block.type === "list" ? block.items.map((item) => visible(item.children)).join("\n") : "").join("\n");

// A stream that stalls here, for as long as the model pauses: every pipe line it already sent shows, pipes kept, at
// once (the document has no clock, so anything held would stay hidden until the next line ends).
const stalls: [string, string[]][] = [
  ["| a | b |", ["| a | b |"]],
  ["Intro\n\n| a | b |", ["Intro", "| a | b |"]],
  ["| a | b |\n", ["| a | b |"]],
  // A growing delimiter row is markup, like a lone `-` or `>` (reviewer-round3.test.tsx): it shows once its line ends.
  ["| a | b |\n| - |", ["| a | b |"]],
  ["| a | b |\nmo", ["| a | b |", "mo"]],
  ["Intro\n| a | b |", ["Intro", "| a | b |"]],
  ["> | a | b |", ["| a | b |"]],
  ["- item\n  | a | b |", ["item", "| a | b |"]],
  ["| grep foo is how you pipe", ["| grep foo is how you pipe"]],
  // A later prose line keeps the pipe row above it, as sent.
  ["a\n| x |\nb", ["a", "| x |", "b"]],
  ["Intro line\n| a | b |\nmore prose", ["Intro line", "| a | b |", "more prose"]],
  ["Use the shell:\n\n| grep foo is how you pipe\nand then sort the output", ["Use the shell:", "| grep foo is how you pipe", "and then sort the output"]],
  ["Results:\n\n| a | b |\nnot a delimiter", ["Results:", "| a | b |", "not a delimiter"]],
];
for (const [stalled, expected] of stalls) {
  for (const split of [1, 1000]) {
    test(`a stall on ${JSON.stringify(stalled)} shows every pipe line already sent (split ${split})`, () => {
      const document = createStreamingDocument();
      for (let offset = 0; offset < stalled.length; offset += split) document.append(stalled.slice(offset, offset + split));
      const seen = visible(document.render());
      for (const line of expected) expect(seen, JSON.stringify(seen)).toContain(line);
    });
  }
}

test("a pipe row that never becomes a table stays as sent, pipes kept, before and after the next line proves it", () => {
  const document = createStreamingDocument();
  document.append("Note:\n\n| not a table");
  expect(shown(document.render())).toEqual(["p:Note:", "p:| not a table"]);
  document.append("\nreally\n");
  expect(shown(document.render())).toEqual(["p:Note:", "p:| not a table\nreally"]);
});

test("the header row shows raw at once and becomes the table when its delimiter row ends", () => {
  const document = createStreamingDocument();
  document.append("| a | b |\n");
  expect(shown(document.render())).toEqual(["p:| a | b |"]);
  document.append("| - | - |\n");
  expect(shown(document.render())).toEqual(["table:a|b"]);
});

test("a header and a delimiter row with no body row yet are a table", () => {
  const document = createStreamingDocument();
  document.append("Results:\n\n| a | b |\n|---|---|\n");
  expect(shown(document.render())).toEqual(["p:Results:", "table:a|b"]);
});

// The rule: at every streamed prefix, the reader sees every character the model sent, except syntax: pipes (cell
// borders once a table forms), delimiter rows (they become the borders), container markers, and whitespace. A growing
// line of only markup (a delimiter row, a lone pipe or marker) is syntax until its line ends.
const content = (line: string) => line.replace(/^[ \t]*(?:>[ \t]?)*(?:[-*+][ \t]+)?/, "");
const markup = (line: string) => /^[ \t|:-]*$/.test(line) && (line.includes("-") || line.includes(":") || !/[^ \t]/.test(line) || line.includes("|"));
const sent = (prefix: string) => prefix.split("\n").map(content).filter((line) => !markup(line)).join("").replace(/[\s|]/g, "");
const seen = (blocks: readonly Block[]) => visible(blocks).replace(/[\s|]/g, "");
for (const fixture of [
  "Every check passed:\n\n| check | result |\n| --- | --- |\n| typecheck | pass |\n| unit tests | 412 pass |\n\nDone.",
  "Intro line\n| a | b |\nmore prose\n\n| x | y |\n|:--|--:|\n| 1 | 2 |",
  "Use the shell:\n\n| grep foo is how you pipe\nand then sort the output\n| a | b |\nnot a delimiter",
  "> | q | r |\n> | - | - |\n> | s | t |\n\n- item\n  | a | b |\n  more",
]) {
  for (const split of [1, 2, 5]) {
    test(`every prefix shows every character sent so far (${JSON.stringify(fixture.slice(0, 24))}, split ${split})`, () => {
      const document = createStreamingDocument();
      for (let offset = 0; offset < fixture.length; offset += split) {
        document.append(fixture.slice(offset, offset + split));
        const prefix = fixture.slice(0, offset + split);
        expect(seen(document.render()), JSON.stringify(prefix)).toBe(sent(prefix));
      }
    });
  }
}
