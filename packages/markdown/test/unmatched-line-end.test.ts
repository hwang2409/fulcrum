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

test("the reviewer split keeps an unmatched resolved suffix run literal", () => {
  const chunks = ["`owner\n\\", "`", "still", "`", "tail"];
  const document = createStreamingDocument();
  for (const chunk of chunks) {
    document.append(chunk);
    document.render();
  }
  expect(document.render(), "reviewer split final tree matches the complete parse")
    .toEqual(parseMarkdown(chunks.join("")));
});

const splitSweep = (source: string) => {
  const chunkings: string[][] = [];
  for (let first = 1; first < source.length; first++) {
    chunkings.push([source.slice(0, first), source.slice(first)]);
    for (let second = first + 1; second < source.length; second++)
      chunkings.push([source.slice(0, first), source.slice(first, second), source.slice(second)]);
  }
  chunkings.push([...source]);
  return chunkings;
};

test("backtick escapes stream like the complete parse across every split", () => {
  const cases: Array<[name: string, checkpoints: string[]]> = [];
  for (let count = 0; count <= 4; count++) {
    const backslashes = "\\".repeat(count);
    cases.push(
      [`before opener, ${count} backslashes`, ["plain\n", `plain\n\n${backslashes}\`open\\\` tail`]],
      [`before closer, ${count} backslashes`, ["`owner\n", `\`owner\n${backslashes}\`tail`]],
      [`closer chunk boundary, ${count} backslashes`, ["`owner\n", `\`owner\n${backslashes}\`tail`]],
      [`line end before closer, ${count} backslashes`, [`\`owner${backslashes}\n\`tail`]],
      [`mixed run lengths, ${count} backslashes`, ["``owner\n", `\`\`owner\n${backslashes}\`middle\`\`tail`]],
      [`later escaped run, ${count} backslashes`, ["`owner\n", `\`owner\n${backslashes}\`still\\\`tail`]],
    );
  }
  cases.push(["resolved owner with an unmatched suffix run", ["`owner\n", "`owner\n\\`still`tail"]]);

  for (const [name, checkpoints] of cases) for (const [checkpoint, source] of checkpoints.entries()) {
    for (const chunks of splitSweep(source)) {
      const document = createStreamingDocument();
      for (const chunk of chunks) {
        document.append(chunk);
        document.render();
      }
      expect(document.render(), `${name}, checkpoint ${checkpoint + 1}, split ${chunks.map(({ length }) => length).join("/")}`)
        .toEqual(parseMarkdown(source));
    }
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
