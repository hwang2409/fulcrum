import { expect, test } from "bun:test";
import { createStreamingDocument, parseMarkdown, type Block, type Inline } from "../src/index.js";
import { PENDING_INLINE_SUFFIX } from "../src/pending-inline.js";

// A stable `[` decided as text: the opener has one source position; hidden there until decided, shown there when
// decided, never re-materialized elsewhere. Deciding it reveals the markers kept in place and never parses the text
// inside it again, so a run of closers costs the distance between them, not depth x length.

const text = (nodes: readonly Inline[]): string => nodes.map((node) =>
  node.type === "text" || node.type === "code" || node.type === "pending-reference" ? node.value
  : node.type === "image" ? node.alt
  : node.type === "break" ? "\n"
  : text(node.children)).join("");
const paragraph = (blocks: readonly Block[]) => blocks.map((block) => block.type === "paragraph" ? text(block.children) : "").join("\n");
const hasEmphasis = (nodes: readonly Inline[]): boolean => nodes.some((node) => node.type === "emphasis" || node.type === "strong" || "children" in node && hasEmphasis(node.children));

/** A minified JSON value nested `depth` arrays deep, each level padded with `width` strings on both sides. */
function nestedJson(depth: number, width: number): string {
  const fill = Array.from({ length: width }, (_, index) => `"item-${index}"`).join(",");
  let value = `{"leaf":true}`;
  for (let level = 0; level < depth; level++) value = `[${fill},${value},${fill}]`;
  return value;
}

// Every frame may copy its delta (twice: the emitted text and the suffix) plus the bounded suffix window; nothing more.
const WINDOW = PENDING_INLINE_SUFFIX + 66;
const shapes: Array<[string, (scale: number) => string]> = [
  ["minified JSON, depth 30", (scale) => `Result: ${nestedJson(30, Math.max(4, Math.round(280 * scale)))}`],
  ["nested plain brackets", (scale) => "[w ".repeat(Math.round(1000 * scale)) + "ab ".repeat(Math.round(10_000 * scale)) + "]x ".repeat(Math.round(1000 * scale))],
  ["brackets over emphasis openers", (scale) => "[*a ".repeat(Math.round(500 * scale)) + "b ".repeat(Math.round(5000 * scale)) + "]x ".repeat(Math.round(500 * scale))],
  ["emphasis closers past brackets", (scale) => "*a[".repeat(Math.round(400 * scale)) + "x* ".repeat(Math.round(400 * scale))],
  ["sequential spans", (scale) => "[a] ".repeat(Math.round(3000 * scale))],
];

// One character per delta costs a parse of the suffix per character, so that plan streams a tenth of the input; the
// nesting (and so the quadratic on the old path) is the same shape.
for (const [name, build] of shapes) for (const delta of [1, 7, 1024]) {
  test(`deciding stable brackets copies only each frame's text and the suffix window (${name}, ${delta}-character deltas)`, () => {
    const source = build(delta === 1 ? 0.1 : 1);
    const document = createStreamingDocument();
    let frames = 0;
    for (let offset = 0; offset < source.length; offset += delta) {
      const before = document.stats.copiedCharacters;
      document.append(source.slice(offset, offset + delta));
      document.render();
      frames++;
      const copied = document.stats.copiedCharacters - before;
      if (copied > 2 * delta + 2 * WINDOW + 16) expect(copied, `frame ending at ${offset + delta} of ${source.length}`).toBeLessThanOrEqual(2 * delta + 2 * WINDOW + 16);
    }
    expect(document.stats.copiedCharacters).toBeLessThanOrEqual(4 * source.length + frames * (WINDOW + 16));
    document.finish();
    expect(JSON.stringify(document.render())).toBe(JSON.stringify(parseMarkdown(source)));
  }, 60_000);
}

// A stray `]` after many stable openers finds no bracket below it: one step to the bracket below, not a walk.
test("stray closing brackets after stable emphasis openers stay linear", () => {
  const source = "*a ".repeat(20_000) + "] ".repeat(20_000);
  const document = createStreamingDocument();
  const start = performance.now();
  for (let offset = 0; offset < source.length; offset += 1024) {
    document.append(source.slice(offset, offset + 1024));
    document.render();
  }
  const elapsed = performance.now() - start;
  expect(document.stats.copiedCharacters).toBeLessThanOrEqual(4 * source.length);
  // A coarse backstop: the walk took 1.9-5.6 s here; the copy count above is the gate.
  expect(elapsed).toBeLessThan(1_500);
});

/** The non-space, non-bracket characters before each `[` or `]` of `value`, with the glyph: where a bracket sits. */
const bracketPlaces = (value: string) => {
  const places: string[] = [];
  let count = 0;
  for (const character of value) {
    if (character === "[" || character === "]") places.push(`${character}@${count}`);
    else if (!/\s/.test(character)) count++;
  }
  return places;
};

const aside = "Note [this applies to every package in the workspace, including the ones that are only built for tests and never published to the registry at all, and the docs].\n";
const longLabel = (words: number, tail: string) => `see [note ${"word text ".repeat(words)}${tail}`;
const positionSources = [
  aside,
  aside.replace("].\n", "] ok.\n"),
  ...[150, 200, 1200].flatMap((words) => [longLabel(words, "] done\n"), longLabel(words, "] done and some more words\n"), longLabel(words, "]. next")]),
  // an unclosed long `[` at the line end, and a `]` followed by a backtick run
  `see [note ${"word text ".repeat(150)}\nnext line`,
  `see [note ${"word text ".repeat(150)}] \`code\` more\n`,
  `x [${"word text ".repeat(30)}]\`\``,
];

// Every visible `[` or `]` sits where it is in the source, at every prefix, including the frame where the deciding
// character and the line end arrive in one delta. An undecided `[` has no glyph anywhere.
for (const delta of [1, 2, 4, 30]) {
  test(`a decided bracket shows at its own source position at every prefix (${delta}-character deltas)`, () => {
    const failures: string[] = [];
    // The 12k-character label streams only at 30 characters per delta: smaller deltas would render it thousands of
    // times per alignment for no new case (150 and 200 words already pass the 128-character window).
    for (const source of positionSources.filter((value) => delta >= 30 || value.length < 4_000)) {
      // The alignments that matter: delta boundaries just before the last `]` and before each of the few characters
      // after it, so `].\n` (the `]`, its deciding character, and the line end) lands in one delta in some.
      const close = source.lastIndexOf("]");
      const shifts = new Set([0, ...Array.from({ length: 8 }, (_, back) => ((close - back) % delta + delta) % delta)]);
      for (const shift of shifts) {
        const document = createStreamingDocument();
        const starts = shift ? [0, ...Array.from({ length: Math.ceil((source.length - shift) / delta) }, (_, index) => shift + index * delta)] : Array.from({ length: Math.ceil(source.length / delta) }, (_, index) => index * delta);
        for (let index = 0; index < starts.length && failures.length < 4; index++) {
          const end = starts[index + 1] ?? source.length;
          document.append(source.slice(starts[index], end));
          const shown = bracketPlaces(paragraph(document.render()));
          const sent = new Set(bracketPlaces(source.slice(0, end)));
          const wrong = shown.filter((place) => !sent.has(place));
          if (wrong.length) failures.push(`${JSON.stringify(source.slice(0, 40))}... prefix ${end}: ${wrong.join(", ")} has no bracket of the source there`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 60_000);
}

// Deciding a `[` as text takes it off the opener stack, so an emphasis closer after its `]` reaches an opener before it.
test("an emphasis around a decided bracket streams styled", () => {
  const pad = "w ".repeat(100);
  const document = createStreamingDocument();
  const source = `*a [b ${pad}] c* ${pad}end`;
  for (let offset = 0; offset < source.length; offset += 4) document.append(source.slice(offset, offset + 4));
  const blocks = document.render();
  expect(blocks[0]?.type === "paragraph" && hasEmphasis(blocks[0].children)).toBe(true);
  expect(paragraph(blocks)).toContain("[b");
});

test("an image opener decided as text shows `![` in place", () => {
  const pad = "w ".repeat(100);
  const document = createStreamingDocument();
  const source = `see ![x ${pad}] y ${pad}end`;
  for (let offset = 0; offset < source.length; offset += 4) document.append(source.slice(offset, offset + 4));
  expect(paragraph(document.render()).startsWith("see ![x w")).toBe(true);
});

// Known gap, the same on main (e5a9bcb): while a line streams, an emphasis never pairs across a `[` that is decided as
// text; the emphasis appears at commit. Owned by the follow-up delimiter stack (a CommonMark delimiter list that
// re-pairs closers when a bracket leaves it).
test("known gap, as on main: emphasis across a text-decided `[` appears at commit, not while the line streams", () => {
  const pad = "w ".repeat(100);
  for (const source of [`*a [${pad}b* c]x ${pad}end`, `*a ${pad}[b* c]x ${pad}end`, `[a *b ${pad}] c ${pad}d* end`]) {
    const document = createStreamingDocument();
    for (let offset = 0; offset < source.length; offset += 4) document.append(source.slice(offset, offset + 4));
    const streaming = document.render();
    expect(streaming[0]?.type === "paragraph" && hasEmphasis(streaming[0].children), source).toBe(false);
    document.finish();
    const final = document.render();
    expect(final[0]?.type === "paragraph" && hasEmphasis(final[0].children), source).toBe(true);
  }
});
