import { parseMarkdown } from "../src/index.js";
import { MarkdownLineResolver } from "../src/resolver.js";

function resolve(source: string) {
  const resolver = new MarkdownLineResolver();
  const result = resolver.append(source);
  const final = resolver.finish();
  if (final) result.push(final);
  return { resolver, result };
}

test("stores nested definitions in one document-wide reference index", () => {
  const source = "> [Shared Label]: https://example.com/docs\n\nUse [shared label].\n";
  const { resolver, result } = resolve(source);
  expect(result.map((line) => line.leaf?.kind).filter(Boolean)).toEqual(["reference-definition", "paragraph"]);
  expect(resolver.references.get("SHARED LABEL")).toEqual({ href: "https://example.com/docs", title: "" });
  expect(parseMarkdown(source)).toEqual([
    { type: "blockquote", children: [] },
    { type: "paragraph", tight: undefined, children: [
      { type: "text", value: "Use " },
      { type: "link", href: "https://example.com/docs", title: undefined, children: [{ type: "text", value: "shared label" }] },
      { type: "text", value: "." },
    ] },
  ]);
});

test("commits a following-line reference title through the same index", () => {
  const source = "[shared]: https://example.com/docs\n\"next title\"\n\nUse [shared].\n";
  const { resolver, result } = resolve(source);
  expect(result.map((line) => line.leaf?.kind).filter(Boolean)).toEqual(["reference-definition", "reference-title", "paragraph"]);
  expect(resolver.references.get("SHARED")).toEqual({ href: "https://example.com/docs", title: "next title" });
  expect(parseMarkdown(source)).toEqual([{
    type: "paragraph",
    children: [
      { type: "text", value: "Use " },
      { type: "link", href: "https://example.com/docs", title: "next title", children: [{ type: "text", value: "shared" }] },
      { type: "text", value: "." },
    ],
  }]);
});
