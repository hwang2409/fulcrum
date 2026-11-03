import { parseMarkdown } from "../src/index.js";
import { MarkdownLineResolver } from "../src/resolver.js";

function resolve(source: string) {
  const resolver = new MarkdownLineResolver();
  const result = resolver.append(source);
  const final = resolver.finish();
  if (final) result.push(final);
  return result;
}

test("promotes a paragraph header and owns complete table rows", () => {
  const source = "> | name | result |\n> | --- | ---: |\n> | test | pass |\n";
  const resolved = resolve(source);
  expect(resolved.map((line) => line.leaf?.kind)).toEqual(["paragraph", "table-delimiter", "table-row"]);
  expect(parseMarkdown(source)).toEqual([{
    type: "blockquote",
    children: [{
      type: "table",
      header: [[{ type: "text", value: "name" }], [{ type: "text", value: "result" }]],
      rows: [[[{ type: "text", value: "test" }], [{ type: "text", value: "pass" }]]],
      align: [undefined, "right"],
    }],
  }]);
});

test("rejects a container line so it cannot become a table row", () => {
  const source = "| one |\n| - |\n2. > ---\n";
  const resolved = resolve(source);
  expect(resolved.map((line) => line.leaf?.kind)).toEqual(["paragraph", "table-delimiter", "thematic-break"]);
  expect(resolved[2]?.opened.map((frame) => frame.kind)).toEqual(["list", "item", "quote"]);
  expect(parseMarkdown(source)[1]).toMatchObject({
    type: "list",
    ordered: true,
    items: [{ children: [{ type: "blockquote", children: [{ type: "rule" }] }] }],
  });
});
