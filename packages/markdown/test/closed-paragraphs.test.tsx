import { expect, test } from "bun:test";
import { createStreamingDocument, parseMarkdown, type Block, type Inline } from "../src/index.js";
import { expectGrowthBelow } from "../../../test-support/scaling.js";
import { withoutDefinitionLabels } from "./accepted-changes.js";

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

// Streams `source` and returns the stable paragraph texts after the last delta, before finish(). `accepted` removes text
// a frame may lose by an accepted change (accepted-changes.ts).
function streamed(source: string, split: number, accepted = (text: string) => text) {
  const document = createStreamingDocument();
  let previous = "";
  for (let offset = 0; offset < source.length; offset += split) {
    document.append(source.slice(offset, offset + split));
    // Whitespace is normalized like the strict fuzz checker: HTML collapses it.
    const stable = paragraphs(document.render()).join(" ").replace(/\s+/g, " ").trim();
    expect(isSubsequence(accepted(previous), stable), `${JSON.stringify(source)}, split ${split}: ${JSON.stringify(previous)} -> ${JSON.stringify(stable)}`).toBe(true);
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

test("a closed paragraph linkifies gfm autolinks before finish", () => {
  for (const value of ["https://example.com/a", "www.example.com/a", "foo@example.com"]) {
    const source = `open ${value} now\n\nnext paragraph`;
    const document = createStreamingDocument();
    document.append(source);
    expect(document.render()[0], value).toEqual(parseMarkdown(source)[0]);
  }
});

test("a paragraph closed by a block start or a container keeps its literal characters", () => {
  for (const source of ["use a | b and 2 * 3 here\n# heading\n", "- use a | b and 2 * 3 here\n\n  next\n", "> use a | b and 2 * 3 here\n\nnext\n"]) {
    for (const split of splits)
      expect(paragraphs(streamed(source, split).render()).join("\n"), `${JSON.stringify(source)}, split ${split}`).toContain("use a | b and 2 * 3 here");
  }
});

// A reference label is text until a definition for it settles: its brackets show (the bracket wait never waits for a
// definition).
test("a committed line keeps a stray closing bracket and a trailing reference label", () => {
  for (const split of splits) {
    expect(paragraphs(streamed("see a] b and [x]\n", split).render()), `open, split ${split}`).toEqual(["see a] b and [x]"]);
    expect(paragraphs(streamed("see a] b and [x]\n\nnext\n", split).render())[0], `closed, split ${split}`).toBe("see a] b and [x]");
  }
});

test("strict fuzz repro: a committed line keeps the bracket before a link-like word", () => {
  for (const split of splits)
    expect(paragraphs(streamed("d]https:/ [shared].\n", split).render()), `split ${split}`).toEqual(["d]https:/ [shared]."]);
});

// A later definition never makes a bracket wait: the closed paragraph shows `[shared]` as text, the definition may turn
// it into a link (the one accepted change), and finish matches the one-shot parse.
test("a closed paragraph shows reference brackets until a later definition removes them", () => {
  for (const source of ["a\n[shared]: x\n\nnext\n\n[shared]: /u\n", "[s[shared].\n\nnext\n\n[shared]: /u\n"]) {
    const final = paragraphs(parseMarkdown(source)).join(" ").replace(/\s+/g, " ").trim();
    for (const split of splits) {
      const document = streamed(source, split, (text) => withoutDefinitionLabels(source, text).replace(/\s+/g, " ").trim());
      const active = paragraphs(document.render()).join(" ").replace(/\s+/g, " ").trim();
      expect(isSubsequence(active.replace(/\[shared\]/g, "shared"), final), `${JSON.stringify(source)}, split ${split}: ${JSON.stringify(active)} vs ${JSON.stringify(final)}`).toBe(true);
      document.finish();
      expect(JSON.stringify(document.render())).toBe(JSON.stringify(parseMarkdown(source)));
    }
  }
});

test("committing a long rich line is linear in its length", () => {
  const unit = "plain **strong** and *emphasis* with `code`. ";
  expectGrowthBelow([31_250, 1_000_000], (length) => {
    const document = createStreamingDocument();
    document.append(unit.repeat(Math.ceil(length / unit.length)).slice(0, length));
    document.render();
    return () => {
      document.append("\n");
      document.render();
    };
  }, { samples: 3 });
}, 60_000);

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
