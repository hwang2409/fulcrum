import { expect, test } from "bun:test";
import { createStreamingDocument, parseMarkdown, type Block, type Inline } from "../src/index.js";

const splits = [1, 2, 3, 7, 20, 1000];

const inlineText = (nodes: readonly Inline[], provisional: boolean): string => nodes.map((node) =>
  node.type === "text" || node.type === "code" || node.type === "pending-reference" ? node.value
  : node.type === "image" ? node.alt
  : node.type === "break" ? "\n"
  : inlineText(node.children, provisional)).join("");

const paragraphs = (blocks: readonly Block[]): string[] => [...blocks].flatMap((block) =>
  block.type === "paragraph" || block.type === "heading" ? [inlineText(block.children, false)]
  : block.type === "blockquote" ? paragraphs(block.children)
  : block.type === "list" ? block.items.flatMap((item) => paragraphs(item.children))
  : []);

function isSubsequence(needle: string, haystack: string) {
  let offset = 0;
  for (const character of haystack) if (character === needle[offset]) offset++;
  return offset === needle.length;
}

// Streams `source` and returns the stable paragraph texts after the last delta, before finish().
function streamed(source: string, split: number) {
  const document = createStreamingDocument();
  let previous = "";
  for (let offset = 0; offset < source.length; offset += split) {
    document.append(source.slice(offset, offset + split));
    // Whitespace is normalized like the strict fuzz checker: HTML collapses it.
    const stable = paragraphs(document.render()).join(" ").replace(/\s+/g, " ").trim();
    expect(isSubsequence(previous, stable), `${JSON.stringify(source)}, split ${split}: ${JSON.stringify(previous)} -> ${JSON.stringify(stable)}`).toBe(true);
    previous = stable;
  }
  return document;
}

test("a closed paragraph keeps literal pipes and asterisks before finish", () => {
  const source = "use a | b and 2 * 3 here\n\nnext para\n";
  const final = JSON.stringify(parseMarkdown(source)[0]);
  for (const split of splits) {
    const document = streamed(source, split);
    expect(JSON.stringify(document.render()[0]), `split ${split}`).toBe(final);
  }
});

test("a paragraph closed by a block start or a container keeps its literal characters", () => {
  for (const source of ["use a | b and 2 * 3 here\n# heading\n", "- use a | b and 2 * 3 here\n\n  next\n", "> use a | b and 2 * 3 here\n\nnext\n"]) {
    for (const split of splits)
      expect(paragraphs(streamed(source, split).render()).join("\n"), `${JSON.stringify(source)}, split ${split}`).toContain("use a | b and 2 * 3 here");
  }
});

test("a committed line keeps a stray closing bracket and a trailing reference label", () => {
  for (const split of splits) {
    expect(paragraphs(streamed("see a] b and [x]\n", split).render()), `open, split ${split}`).toEqual(["see a] b and x"]);
    expect(paragraphs(streamed("see a] b and [x]\n\nnext\n", split).render())[0], `closed, split ${split}`).toBe("see a] b and x");
  }
});

test("strict fuzz repro: a committed line keeps the bracket before a link-like word", () => {
  for (const split of splits)
    expect(paragraphs(streamed("d]https:/ [shared].\n", split).render()), `split ${split}`).toEqual(["d]https:/ shared."]);
});

test("a closed paragraph hides reference brackets that a later definition removes", () => {
  for (const source of ["a\n[shared]: x\n\nnext\n\n[shared]: /u\n", "[s[shared].\n\nnext\n\n[shared]: /u\n"]) {
    const final = paragraphs(parseMarkdown(source)).join(" ").replace(/\s+/g, " ").trim();
    for (const split of splits) {
      const active = paragraphs(streamed(source, split).render()).join(" ").replace(/\s+/g, " ").trim();
      expect(isSubsequence(active, final), `${JSON.stringify(source)}, split ${split}: ${JSON.stringify(active)} vs ${JSON.stringify(final)}`).toBe(true);
    }
  }
});

test("committing a long rich line is linear in its length", () => {
  const unit = "plain **strong** and *emphasis* with `code`. ";
  const commit = (length: number) => {
    const samples = Array.from({ length: 3 }, () => {
      const document = createStreamingDocument();
      document.append(unit.repeat(Math.ceil(length / unit.length)).slice(0, length));
      document.render();
      const start = performance.now();
      document.append("\n");
      document.render();
      return performance.now() - start;
    });
    return samples.sort((a, b) => a - b)[1]!;
  };
  const small = commit(100_000);
  const large = commit(1_000_000);
  // Quadratic commits took ~200 ms at 100k and 6-8 s at 1 MB; linear ones take tens of ms.
  expect(large, `1 MB commit ${large.toFixed(1)} ms, 100k commit ${small.toFixed(1)} ms`).toBeLessThan(1_000);
});

test("an escaped bracket pair never shows a backslash that later disappears", () => {
  for (const source of ["see \\[x\\]\n\nnext\n", "\\[ A = \\pi \\]\n\nnext\n", "a \\[b] and \\\\[c]\n\nnext\n"]) {
    const final = paragraphs(parseMarkdown(source)).join(" ").replace(/\s+/g, " ").trim();
    for (const split of splits) {
      const document = streamed(source, split);
      expect(isSubsequence(paragraphs(document.render()).join(" ").replace(/\s+/g, " ").trim(), final), `${JSON.stringify(source)}, split ${split}`).toBe(true);
    }
  }
});

test("a later definition resolves a label after a stray bracket in the closed paragraph", () => {
  const document = createStreamingDocument();
  document.append("x [s[shared] y\n\n");
  // The line after the definition confirms it (a definition may continue with a title).
  document.append("[shared]: https://example.com\n\nmore\n");
  const first = document.render()[0]!;
  expect(first.type).toBe("paragraph");
  const links = JSON.stringify(first).match(/"type":"link"/g) ?? [];
  expect(links.length).toBe(1);
});
