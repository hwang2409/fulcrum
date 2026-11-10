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
    expect(document.render()).toEqual([{
      type: "paragraph",
      children: [
        { type: "text", value: `prefix ${opener}a` },
        ...ending === "two trailing spaces" ? [{ type: "break" as const }] : [],
      ],
      tight: undefined,
    }]);
  });
}
