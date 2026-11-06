import { expect, test } from "bun:test";
import { parseMarkdown } from "../src/index.js";
import { MarkdownLineResolver } from "../src/resolver.js";

const source = (label: string, suffix = "") => `[${label}]: /url${suffix}\n\nUse [${label}].`;
const resolve = (input: string) => {
  const resolver = new MarkdownLineResolver();
  const result = [...resolver.append(input), resolver.finish()].filter(Boolean);
  return { result, references: resolver.references };
};

test("enforces the CommonMark 999-code-point label limit in both paths", () => {
  for (const count of [999, 1000]) {
    const label = "a".repeat(count);
    const oneShot = parseMarkdown(source(label));
    const streaming = resolve(source(label));
    expect(oneShot[0]?.type).toBe("paragraph");
    expect(streaming.references.has(label.toUpperCase())).toBe(count === 999);
  }
});

test("supports escaped labels, next-line destinations, and multiline titles", () => {
  const input = "[a\\]b]:\n</url>\n\"multi\nline\"\n\nUse [a\\]b].";
  expect(parseMarkdown(input).at(-1)).toEqual({ type: "paragraph", children: [
    { type: "text", value: "Use " },
    { type: "link", href: "/url", title: "multi\nline", children: [{ type: "text", value: "a]b" }] },
    { type: "text", value: "." },
  ] });
});

test.each([
  ["R", "[r]:\n[", "%5B"],
  ["D", "[d]:\n\"", "%22"],
] as const)("accepts a punctuation-only next-line bare destination: %s", (label, input, href) => {
  expect(parseMarkdown(input)).toEqual([]);
  const resolved = resolve(input);
  expect(resolved.result.map((line) => line.leaf?.kind)).toEqual(["reference-definition"]);
  expect(resolved.references.get(label)).toEqual({ href, title: "" });
});

test("consumes duplicate definitions while keeping the first definition", () => {
  const input = "[shared]:s \"e\"\n[shared]:s\n\"\"";
  expect(parseMarkdown(input)).toEqual([]);
  const resolved = resolve(input);
  expect(resolved.result.map((line) => line.leaf?.kind)).toEqual(["reference-definition", "reference-definition", "reference-title"]);
  expect(resolved.references.get("SHARED")).toEqual({ href: "s", title: "e" });
});
