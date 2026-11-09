import { expect, test } from "bun:test";
import { createStreamingDocument, parseMarkdown } from "../src/index.js";

const fixed = [
  "*a [" + "w ".repeat(100) + "b* c]x " + "w ".repeat(100) + "end\n",
  "*a " + "w ".repeat(100) + "[b* c]x " + "w ".repeat(100) + "end\n",
  "[a *b " + "w ".repeat(100) + "] c " + "w ".repeat(100) + "d* end\n",
  "before [label] and *style* and ~~strike~~\n[id]: /target \"title\"\n",
];
const words = ["plain", "*open", "close*", "[label]", "[x](https://e.com)", "~~strike~~", "`code`", "![alt](img.png)", "_word_", "[ref][id]"];

const generated = (seed: number) => {
  let state = seed || 1;
  const next = () => (state = Math.imul(state ^ state >>> 15, 2_246_822_519) ^ Math.imul(state ^ state >>> 13, 3_266_489_917)) >>> 0;
  const lines: string[] = [];
  for (let line = 0; line < 12; line++) {
    const parts: string[] = [];
    for (let word = 0; word < 18; word++) parts.push(words[next() % words.length]!);
    lines.push(parts.join(" "));
  }
  lines.push("[id]: /resolved");
  return lines.join("\n") + "\n";
};

const stream = (source: string, seed: number, fixedChunk?: number) => {
  let state = seed || 1;
  const next = () => (state = Math.imul(state ^ state >>> 16, 1_664_525) + 1_013_904_223) >>> 0;
  const document = createStreamingDocument();
  let offset = 0;
  while (offset < source.length) {
    const newline = source.indexOf("\n", offset);
    const planned = fixedChunk ?? 1 + next() % 29;
    const end = Math.min(source.length, offset + planned, newline < 0 ? source.length : newline + 1);
    document.append(source.slice(offset, end));
    offset = end;
    if (source[offset - 1] === "\n") {
      const committed = source.slice(0, offset);
      expect(JSON.stringify(document.render()), `seed ${seed}, committed ${offset}`).toBe(JSON.stringify(parseMarkdown(committed)));
    }
  }
  document.finish();
  expect(JSON.stringify(document.render()), `seed ${seed}, finish`).toBe(JSON.stringify(parseMarkdown(source)));
};

test("settled delimiter prefixes equal the authoritative parse for fixed and random chunk plans", () => {
  for (const source of fixed) {
    stream(source, 1, 1);
    stream(source, 17, 7);
    stream(source, 991);
  }
  for (let seed = 1; seed <= 40; seed++) stream(generated(seed), seed * 97);
});
