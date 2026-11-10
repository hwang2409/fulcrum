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
