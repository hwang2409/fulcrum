import { expect, test } from "bun:test";
import * as commonmark from "commonmark";
import { createStreamingDocument, parseMarkdown, type Block } from "../src/index.js";
import { MarkdownLineResolver } from "../src/resolver.js";

type Shape = { type: string; children?: Shape[][] | Shape[] };
type OracleReference = { destination: string; title: string };
type SweepCase = { category: string; source: string };

const containerPrefixes = [
  { name: "root", first: "", continuation: "" },
  { name: "quote", first: "> ", continuation: "> " },
  { name: "quote-tab", first: ">\t", continuation: ">\t" },
  { name: "bullet", first: "- ", continuation: "  " },
  { name: "bullet-tab", first: "-\t", continuation: "\t" },
  { name: "ordered", first: "1. ", continuation: "   " },
  { name: "ordered-tab", first: "1.\t", continuation: "\t" },
  { name: "quote-bullet", first: "> - ", continuation: ">   " },
  { name: "quote-bullet-tab", first: ">\t-\t", continuation: ">\t\t" },
  { name: "bullet-quote", first: "- > ", continuation: "  > " },
  { name: "bullet-quote-tab", first: "-\t>\t", continuation: "\t>\t" },
] as const;

const definitions = [
  { name: "complete-destination", lines: ["[r]: /dest"] },
  { name: "complete-title", lines: ["[r]: /dest \"title\""] },
  { name: "open-destination", lines: ["[r]:", "/dest"] },
  { name: "open-title", lines: ["[r]: /dest \"", "title\""] },
  { name: "rejected", lines: ["[r]: /dest \"title\" junk"] },
  { name: "two-definitions", lines: ["[r]: /dest", "[s]: /second"] },
] as const;

const followingLines = [
  { name: "lazy-prose", line: "outside" },
  { name: "prefixed-prose", line: "CONTAINERprose" },
  { name: "blank", line: "" },
  { name: "indented-continuation", line: "INDENTcontinued" },
  { name: "unindented-after-blank", line: "outside", requiresBlank: true },
  { name: "fence", line: "```js" },
  { name: "heading", line: "# heading" },
  { name: "thematic-break", line: "***" },
  { name: "setext-equals", line: "===" },
  { name: "setext-dashes", line: "---" },
  { name: "table-looking", line: "| cell | value |" },
  { name: "another-definition", line: "[t]: /third" },
  { name: "list-start", line: "- child" },
  { name: "quote-start", line: "> child" },
] as const;

function sourceFor(
  container: typeof containerPrefixes[number],
  definition: typeof definitions[number],
  following: typeof followingLines[number],
  optionalBlank: boolean,
) {
  const lines = definition.lines.map((line, index) => `${index ? container.continuation : container.first}${line}`);
  if (optionalBlank || following.requiresBlank) lines.push(container.continuation.trimEnd());
  const line = following.line
    .replace("CONTAINER", container.continuation)
    .replace("INDENT", container.continuation || " ");
  lines.push(line);
  lines.push("", "[r]");
  return `${lines.join("\n")}\n`;
}

const cases: SweepCase[] = [];
for (const container of containerPrefixes)
  for (const definition of definitions)
    for (const following of followingLines)
      for (const optionalBlank of [false, true]) {
        const category = `${container.name}/${definition.name}/${following.name}/${optionalBlank ? "blank" : "direct"}`;
        cases.push({ category, source: sourceFor(container, definition, following, optionalBlank) });
      }

function oracle(source: string) {
  const parser = new commonmark.Parser();
  const document = parser.parse(source);
  const references = Object.fromEntries(Object.entries(
    (parser as unknown as { refmap: Record<string, OracleReference> }).refmap,
  ));
  return { shape: commonmarkShape(document), references };
}

function commonmarkShape(node: commonmark.Node): Shape[] {
  const shapes: Shape[] = [];
  for (let child = node.firstChild; child; child = child.next) {
    if (child.type === "paragraph" && child.firstChild) shapes.push({ type: "paragraph" });
    else if (child.type === "heading") shapes.push({ type: "heading" });
    else if (child.type === "code_block") shapes.push({ type: "code" });
    else if (child.type === "thematic_break") shapes.push({ type: "rule" });
    else if (child.type === "block_quote") shapes.push({ type: "blockquote", children: commonmarkShape(child) });
    else if (child.type === "list") {
      const items: Shape[][] = [];
      for (let item = child.firstChild; item; item = item.next) items.push(commonmarkShape(item));
      shapes.push({ type: "list", children: items });
    }
  }
  return shapes;
}

function blockShape(blocks: readonly Block[]): Shape[] {
  return blocks.map((block) => block.type === "blockquote"
    ? { type: block.type, children: blockShape(block.children) }
    : block.type === "list"
      ? { type: block.type, children: block.items.map((item) => blockShape(item.children)) }
      : { type: block.type });
}

function withoutOpenTail(shapes: Shape[]): Shape[] {
  const copy = structuredClone(shapes) as Shape[];
  let siblings: Shape[] = copy;
  while (siblings.length) {
    const last = siblings.at(-1)!;
    if (last.type === "blockquote" && Array.isArray(last.children)) {
      siblings = last.children as Shape[];
      continue;
    }
    if (last.type === "list" && Array.isArray(last.children) && last.children.length) {
      siblings = (last.children as Shape[][]).at(-1)!;
      continue;
    }
    siblings.pop();
    break;
  }
  return copy;
}

function shapePrefix(actual: Shape[], expected: Shape[]): boolean {
  if (actual.length > expected.length) return false;
  return actual.every((block, index) => {
    const target = expected[index];
    if (!target || block.type !== target.type) return false;
    if (!block.children) return true;
    if (!target.children || block.children.length > target.children.length) return false;
    if (block.type === "list") return (block.children as Shape[][]).every((item, itemIndex) =>
      shapePrefix(item, (target.children as Shape[][])[itemIndex] ?? []));
    return shapePrefix(block.children as Shape[], target.children as Shape[]);
  });
}

function resolverReferences(source: string) {
  const resolver = new MarkdownLineResolver();
  resolver.append(source);
  resolver.finish();
  return Object.fromEntries([...resolver.references].map(([label, value]) => [label, {
    destination: value.href,
    title: value.title,
  }]));
}

const json = (value: unknown) => JSON.stringify(value, (key, item) => key === "open" ? undefined : item);

function lineChunks(source: string) {
  const chunks = source.match(/.*(?:\n|$)/g) ?? [];
  return chunks.filter(Boolean);
}

type Mismatches = Map<string, { count: number; examples: string[] }>;

function record(mismatches: Mismatches, category: string, kind: string) {
  const mismatch = mismatches.get(kind) ?? { count: 0, examples: [] };
  mismatch.count++;
  if (mismatch.examples.length < 5) mismatch.examples.push(category);
  mismatches.set(kind, mismatch);
}

function checkSplit(current: SweepCase, expected: ReturnType<typeof oracle>, oneShot: readonly Block[], split: 1 | "line", mismatches: Mismatches) {
  const document = createStreamingDocument();
  const chunks = split === 1 ? [...current.source] : lineChunks(current.source);
  let prefix = "";
  for (const chunk of chunks) {
    prefix += chunk;
    document.append(chunk);
    const closed = withoutOpenTail(blockShape(document.render()));
    if (!shapePrefix(closed, expected.shape)) record(mismatches, current.category, `closed-tree/${split}`);
    if (prefix.endsWith("\n") && json(resolverReferences(prefix)) !== json(oracle(prefix).references))
      record(mismatches, current.category, `published-references/${split}`);
  }
  document.finish();
  if (json(document.render()) !== json(oneShot)) record(mismatches, current.category, `finish/${split}`);
}

function checkCase(current: SweepCase, mismatches: Mismatches) {
  const expected = oracle(current.source);
  const oneShot = parseMarkdown(current.source);
  if (json(blockShape(oneShot)) !== json(expected.shape)) record(mismatches, current.category, "one-shot/commonmark tree");
  if (json(resolverReferences(current.source)) !== json(expected.references)) record(mismatches, current.category, "finished references");
  checkSplit(current, expected, oneShot, 1, mismatches);
  checkSplit(current, expected, oneShot, "line", mismatches);
}

test(`generated reference/container sweep (${cases.length} documents)`, () => {
  const mismatches: Mismatches = new Map();
  for (const current of cases) checkCase(current, mismatches);
  expect([...mismatches.entries()], [...mismatches.entries()].map(([kind, mismatch]) =>
    `${kind}: ${mismatch.count} (${mismatch.examples.join(", ")})`).join("\n")).toEqual([]);
}, 60_000);
