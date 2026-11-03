import { parseMarkdown } from "../src/index.js";
import { MarkdownLineResolver } from "../src/resolver.js";

function resolve(source: string) {
  const resolver = new MarkdownLineResolver();
  const result = resolver.append(source);
  const final = resolver.finish();
  if (final) result.push(final);
  return result;
}

test("keeps html block lines with their deepest matched owner", () => {
  const source = "> <div class=\"safe\">\n> *literal*\n> </div>\n";
  const resolved = resolve(source);
  expect(resolved.map((line) => line.leaf?.kind)).toEqual(["html-open", "html-line", "html-close"]);
  expect(resolved.every((line) => line.leaf?.path.map((frame) => frame.kind).join("/") === "document/quote")).toBe(true);
  expect(parseMarkdown(source)).toEqual([{
    type: "blockquote",
    children: [{
      type: "paragraph",
      children: [
        { type: "text", value: "<div class=\"safe\">\n" },
        { type: "emphasis", children: [{ type: "text", value: "literal" }] },
        { type: "text", value: "\n</div>" },
      ],
    }],
  }]);
});

test("closes a one-line html comment without retaining leaf state", () => {
  const resolved = resolve("<!-- safe -->\nafter\n");
  expect(resolved.map((line) => line.leaf?.kind)).toEqual(["html-open", "paragraph"]);
});
