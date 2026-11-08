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
  test(`a table header row is held until it is a table, never shown as glued prose (split ${split})`, () => {
    for (const frame of frames(source, split)) {
      // The row is either not shown yet or shown as the table: never as a paragraph of its cell words.
      expect(frame.some((block) => block.startsWith("p:") && /name|status/.test(block)), JSON.stringify(frame)).toBe(false);
    }
    // Once the rows end, the stream shows what the whole source parses to.
    expect(frames(source, split).at(-1)).toEqual(shown(parseMarkdown(source)));
  });
}

test("a pipe row that never becomes a table shows once the next line proves it, pipes kept", () => {
  const document = createStreamingDocument();
  document.append("Note:\n\n| not a table");
  expect(shown(document.render())).toEqual(["p:Note:"]);
  document.append("\nreally\n");
  expect(shown(document.render())).toEqual(["p:Note:", "p:| not a table\nreally"]);
});
