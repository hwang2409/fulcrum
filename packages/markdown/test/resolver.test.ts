import { parseMarkdown, type Block, type Inline } from "../src/index.js";
import { MarkdownLineResolver, type ContainerFrame, type LineResolution } from "../src/resolver.js";

type Leaf = { path: string; content: string };

function text(nodes: readonly Inline[]): string {
  return nodes.map((node) => node.type === "text" || node.type === "code" || node.type === "pending-reference"
    ? node.value
    : node.type === "break" ? "\n"
    : node.type === "image" ? node.alt
    : text(node.children)).join("");
}

function flatten(blocks: readonly Block[], path = "document", leaves: Leaf[] = []): Leaf[] {
  for (const block of blocks) {
    if (block.type === "paragraph") leaves.push({ path, content: text(block.children) });
    else if (block.type === "blockquote") flatten(block.children, `${path}/quote`, leaves);
    else if (block.type === "list") {
      const listPath = `${path}/list:${block.ordered ? "ordered" : "bullet"}`;
      for (const item of block.items) flatten(item.children, `${listPath}/item`, leaves);
    }
  }
  return leaves;
}

function path(frames: readonly ContainerFrame[]) {
  return frames.map((frame) => frame.kind === "list" ? `list:${frame.ordered ? "ordered" : "bullet"}` : frame.kind).join("/");
}

function resolve(source: string): Leaf[] {
  const resolver = new MarkdownLineResolver();
  const decisions: LineResolution[] = [];
  for (let offset = 0; offset < source.length;) {
    const size = Math.min(1 + offset % 7, source.length - offset);
    decisions.push(...resolver.append(source.slice(offset, offset + size)));
    offset += size;
  }
  const final = resolver.finish();
  if (final) decisions.push(final);
  const leaves: Leaf[] = [];
  for (const decision of decisions) {
    if (!decision.leaf) continue;
    const leaf = { path: path(decision.leaf.path), content: decision.leaf.content };
    const previous = leaves.at(-1);
    if (decision.continued && previous?.path === leaf.path) previous.content += `\n${leaf.content}`;
    else leaves.push(leaf);
  }
  return leaves;
}

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function generated(seed: number, count: number) {
  const rng = random(seed);
  const documents: string[] = [];
  for (let index = 0; index < count; index++) {
    const sections: string[] = [];
    for (let section = 0; section < 1 + Math.floor(rng() * 4); section++) {
      let line = `words ${index} ${section}`;
      for (let depth = 0; depth < Math.floor(rng() * 8); depth++) {
        const kind = Math.floor(rng() * 3);
        line = kind === 0 ? `> ${line}` : kind === 1 ? `- ${line}` : `${1 + Math.floor(rng() * 5)}. ${line}`;
      }
      sections.push(line);
    }
    documents.push(sections.join("\n\n") + (rng() < 0.5 ? "\n" : ""));
  }
  return documents;
}

test("resolves each container paragraph line like markdown-it", () => {
  const documents = [
    "plain words",
    "> quote words",
    "- list words",
    "1. ordered words",
    "> - > 3. deeply nested words",
    "- first\n- second",
    "> first\n> second",
    ...generated(0x51a9e, 500),
  ];
  for (const source of documents)
    expect(resolve(source), source).toEqual(flatten(parseMarkdown(source)));
});

test("keeps partial marker scanning read-only until a physical line commits", () => {
  const resolver = new MarkdownLineResolver();
  expect(resolver.append("  12")).toEqual([]);
  expect(resolver.pending).toMatchObject({ length: 4, scan: { indentColumns: 2, marker: "possible" } });
  expect(resolver.append(". > words")).toEqual([]);
  expect(resolver.pending.scan.marker).toBe("ordered");
  const [decision] = resolver.append("\n");
  expect(decision?.opened.map((frame) => frame.kind)).toEqual(["list", "item", "quote"]);
  expect(decision?.leaf?.content).toBe("words");
});

test("reports lazy continuation without closing unmatched containers", () => {
  const resolver = new MarkdownLineResolver();
  resolver.append("> paragraph\n");
  const [decision] = resolver.append("lazy continuation\n");
  expect(decision).toMatchObject({ continued: true, lazy: true, closedToDepth: 2 });
  expect(decision?.leaf && path(decision.leaf.path)).toBe("document/quote");
});
