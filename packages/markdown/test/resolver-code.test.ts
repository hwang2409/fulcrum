import { parseMarkdown } from "../src/index.js";
import { MarkdownLineResolver } from "../src/resolver.js";

function decisions(source: string) {
  const resolver = new MarkdownLineResolver();
  const result = resolver.append(source);
  const final = resolver.finish();
  if (final) result.push(final);
  return result;
}

test("owns fenced code lines inside the matched container path", () => {
  const source = "> ```ts\n> const value = 1;\n> ```\n";
  const resolved = decisions(source);
  expect(resolved.map((line) => line.leaf?.kind)).toEqual(["fence-open", "fence-line", "fence-close"]);
  expect(resolved[0]?.leaf).toMatchObject({ language: "ts", marker: "```" });
  expect(resolved[1]?.leaf?.content).toBe("const value = 1;");
  expect(resolved.every((line) => line.leaf?.path.map((frame) => frame.kind).join("/") === "document/quote")).toBe(true);
  expect(parseMarkdown(source)).toEqual([{
    type: "blockquote",
    children: [{ type: "code", language: "ts", value: "const value = 1;\n", open: false }],
  }]);
});

test("classifies indented code without publishing indentation", () => {
  const source = "    first\n    second\n";
  const resolved = decisions(source);
  expect(resolved.map((line) => line.leaf && { kind: line.leaf.kind, content: line.leaf.content })).toEqual([
    { kind: "indented-code", content: "first" },
    { kind: "indented-code", content: "second" },
  ]);
  expect(parseMarkdown(source)).toEqual([{ type: "code", language: undefined, value: "first\nsecond\n", open: false }]);
});
