import { parseMarkdown } from "../src/index.js";
import { MarkdownLineResolver } from "../src/resolver.js";

function leaves(source: string) {
  const resolver = new MarkdownLineResolver();
  const decisions = resolver.append(source);
  const final = resolver.finish();
  if (final) decisions.push(final);
  return decisions.flatMap((decision) => decision.leaf ? [decision.leaf] : []);
}

test("resolves atx headings at the deepest container", () => {
  const source = "> - ### heading ###\n";
  const resolved = leaves(source);
  expect(resolved).toHaveLength(1);
  expect(resolved[0]).toMatchObject({ kind: "atx-heading", level: 3, content: "heading" });
  expect(resolved[0]?.path.map((frame) => frame.kind)).toEqual(["document", "quote", "list", "item"]);
  expect(parseMarkdown(source)).toEqual([{
    type: "blockquote",
    children: [{ type: "list", ordered: false, start: undefined, items: [{ children: [{ type: "heading", level: 3, children: [{ type: "text", value: "heading" }] }] }] }],
  }]);
});

test("resolves a thematic break when no paragraph can take it as setext", () => {
  const source = "> - * * *\n";
  expect(leaves(source)).toMatchObject([{ kind: "thematic-break", content: "" }]);
  expect(parseMarkdown(source)).toEqual([{
    type: "blockquote",
    children: [{ type: "list", ordered: false, start: undefined, items: [{ children: [{ type: "rule" }] }] }],
  }]);
});

test("turns only the preceding paragraph into a setext heading", () => {
  const source = "> title\n> ===\n";
  const resolved = leaves(source);
  expect(resolved.map(({ kind, level }) => ({ kind, level }))).toEqual([
    { kind: "paragraph", level: undefined },
    { kind: "setext-heading", level: 1 },
  ]);
  expect(parseMarkdown(source)).toEqual([{
    type: "blockquote",
    children: [{ type: "heading", level: 1, children: [{ type: "text", value: "title" }] }],
  }]);
});
