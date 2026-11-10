import { expect, test } from "bun:test";
import { createStreamingDocument, parseMarkdown } from "../src/index.js";

test("an unmatched multiline code owner streams the committed hard break", () => {
  const document = createStreamingDocument();
  document.append("`a  \n");
  expect(document.render(), "unmatched line checkpoint").toEqual([{
    type: "paragraph",
    children: [{ type: "text", value: "`a" }, { type: "break" }],
    tight: undefined,
  }]);

  document.append("b`");
  expect(document.render(), "matching closer converts the owner").toEqual(parseMarkdown("`a  \nb`"));
});

for (const [name, opener] of [
  ["backtick", "`"],
  ["backtick run", "``"],
  ["asterisk emphasis", "*"],
  ["underscore emphasis", "_"],
  ["bracket", "["],
] as const) {
  for (const [ending, suffix] of [
    ["no trailing space", "\n"],
    ["one trailing space", " \n"],
    ["two trailing spaces", "  \n"],
    ["backslash", "\\\n"],
  ] as const) test(`an unmatched ${name} commits a final ${ending} checkpoint`, () => {
    const source = `prefix ${opener}a${suffix}`;
    const document = createStreamingDocument();
    document.append(source);
    const continuation = "a";
    const expected = parseMarkdown(source + continuation);
    const children = expected[0]?.type === "paragraph" ? expected[0].children : [];
    const sentinel = children.at(-1);
    if (sentinel?.type === "text") {
      sentinel.value = sentinel.value.slice(0, -continuation.length).replace(/\n$/, "");
      if (!sentinel.value) children.pop();
    }
    expect(document.render()).toEqual(expected);
  });
}

for (const source of [
  "`a\n``x`tail",
  "``a\n`x``tail",
  "`a\n```x`tail",
]) test(`a multiline code owner ignores different-length runs in ${JSON.stringify(source)}`, () => {
  const document = createStreamingDocument();
  for (const character of source) {
    document.append(character);
    document.render();
  }
  expect(document.render(), "streaming tree matches the complete parse").toEqual(parseMarkdown(source));
});

function randomLineChunks(source: string, seed: number) {
  let state = seed >>> 0;
  const chunks: string[] = [];
  let offset = 0;
  while (offset < source.length) {
    const newline = source.indexOf("\n", offset);
    const boundary = newline < 0 ? source.length : newline + 1;
    while (offset < boundary) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const end = Math.min(boundary, offset + 1 + state % 5);
      chunks.push(source.slice(offset, end));
      offset = end;
    }
  }
  return chunks;
}

test("escaped backtick runs stream like the complete parse", () => {
  const cases: Array<[name: string, source: string]> = [];
  for (let count = 0; count <= 4; count++) {
    const backslashes = "\\".repeat(count);
    cases.push(
      [`outside owner, ${count} backslashes`, `plain\n\n${backslashes}\`open\` tail${count % 2 ? "`" : ""}`],
      [`inside multiline owner, ${count} backslashes`, `\`owner\n${backslashes}\`still\`tail${count % 2 ? "" : "`"}`],
    );
  }

  for (const [name, source] of cases) for (const [split, chunks] of [
    ["one character", [...source]],
    ...[1, 2, 3, 4].map((seed) => [`random ${seed}`, randomLineChunks(source, seed)] as const),
  ] as const) {
    const document = createStreamingDocument();
    const checkpoint = source.slice(0, source.indexOf("\n") + 1);
    let streamed = "";
    for (const chunk of chunks) {
      document.append(chunk);
      streamed += chunk;
      document.render();
      if (streamed === checkpoint)
        expect(document.render(), `${name}, ${split}, committed ${JSON.stringify(streamed)}`).toEqual(parseMarkdown(streamed));
    }
    expect(document.render(), `${name}, ${split}, final tree`).toEqual(parseMarkdown(source));
  }
});

test("a resolved multiline code owner is never scanned again", () => {
  const document = createStreamingDocument();
  document.append("`owner\n`x");
  document.render();
  const before = document.stats.previewScannedCharacters;

  const suffix = "tail".repeat(100);
  for (const character of suffix) {
    document.append(character);
    document.render();
  }

  expect(document.stats.previewScannedCharacters - before, "only the appended suffix is scanned").toBe(suffix.length);
});
