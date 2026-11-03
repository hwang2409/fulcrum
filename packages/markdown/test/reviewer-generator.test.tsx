import { expect, test } from "bun:test";
import { createStreamingDocument, parseMarkdown, type Block, type Inline } from "../src/index.js";

type Case = { name: string; source: string; depth: number; flash?: boolean };
const splits = [1, 2, 3, 7, 20, 1000];
const json = (x: readonly Block[]) => JSON.stringify(x, (k, v) => k === "open" ? undefined : v);
const inline = (xs: readonly Inline[]): string => xs.map((x) => x.type === "text" || x.type === "pending-reference" || x.type === "code" ? x.value : x.type === "image" ? x.alt : x.type === "break" ? "\n" : inline(x.children)).join("");
const visible = (bs: readonly Block[]): string => bs.map((b) => b.type === "paragraph" || b.type === "heading" ? inline(b.children) : b.type === "code" ? b.value : b.type === "blockquote" ? visible(b.children) : b.type === "list" ? b.items.map((i) => visible(i.children)).join("") : b.type === "table" ? [...b.header, ...b.rows.flat()].map(inline).join("") : "").join("");
const compact = (s: string) => s.replace(/\s/g, "");
const subsequence = (needle: string, haystack: string) => { let i = 0; for (const c of haystack) if (c === needle[i]) i++; return i === needle.length; };
const wrap = (source: string, depth: number) => {
  for (let level = 0; level < depth; level++) {
    const lines = source.split("\n");
    if (level % 3 === 0) source = lines.map((line) => `> ${line}`).join("\n");
    else if (level % 3 === 1) source = lines.map((line, i) => `${i ? "  " : "- "}${line}`).join("\n");
    else source = lines.map((line, i) => `${i ? "   " : "3. "}${line}`).join("\n");
  }
  return source;
};
const leaves: [string, string, boolean?][] = [
  ["inline", "plain **strong** *emphasis* ~~strike~~ `code` and AT&amp;T."],
  ["escape", "before \\*literal\\* and \\_under\\_ after."],
  ["table", "| check | result |\n| :--- | ---: |\n| package | **passing** |"],
  ["fence", "```ts\nconst value = \"<safe>\";\n```"],
  ["setext", "streaming title\n==="],
  ["indented", "    alpha\n    beta"],
  ["html", "<div class=\"safe\">literal</div>", false],
  ["ref-before", "[known]: https://example.com/docs\n\nUse [known]."],
  ["ref-after", "Use [later].\n\n[later]: https://example.com/docs"],
  ["lazy-list", "- first line\nlazy continuation with **weight**"],
  ["list-fence", "- command\n\n  ```sh\n  printf safe\n  ```"],
];
const cases: Case[] = [];
for (let depth = 0; depth <= 8; depth++) for (const leaf of leaves) {
  const [name, source, flash = true] = leaf;
  cases.push({ name: `d${depth}-${name}`, source: wrap(source, depth), depth, flash });
}
cases.push({ name: "ref-definition-only", depth: 0, source: "[x]: https://example.com/docs" });
cases.push({ name: "cross-list-ref-after", depth: 1, source: "- first uses [later].\n- [later]: https://example.com/docs" });
cases.push({ name: "cross-list-ref-before", depth: 1, source: "- [known]: https://example.com/docs\n- then [known]." });
cases.push({ name: "ordered-start", depth: 1, source: "3. third\n4. fourth" });
cases.push({ name: "loose-list", depth: 1, source: "- first\n\n  second paragraph" });

test("reviewer generator prefixes only reveal final visible text", () => {
  for (const current of cases) {
    const expectedVisible = compact(visible(parseMarkdown(current.source)));
    if (current.flash === false) continue;
    for (const split of splits) {
      const document = createStreamingDocument();
      for (let offset = 0; offset < current.source.length; offset += split) {
        document.append(current.source.slice(offset, offset + split));
        const shown = compact(visible(document.render()));
        expect(subsequence(shown, expectedVisible), `${current.name}, split ${split}, offset ${Math.min(offset + split, current.source.length)}, shown ${JSON.stringify(shown)}`).toBe(true);
      }
    }
  }
}, 30_000);

const quoted = (source: string, depth: number) => source.split("\n").map((line) => `${"> ".repeat(depth)}${line}`).join("\n");
const stream = (source: string, split: number) => {
  const document = createStreamingDocument();
  for (let offset = 0; offset < source.length; offset += split) {
    document.append(source.slice(offset, offset + split));
    document.render();
  }
  document.finish();
  return document.render();
};
const sharedHref = (blocks: readonly Block[]): string | undefined => {
  const visitInline = (nodes: readonly Inline[]): string | undefined => {
    for (const node of nodes) {
      if (node.type === "link" && inline(node.children) === "shared") return node.href;
      if ("children" in node) {
        const href = visitInline(node.children);
        if (href) return href;
      }
    }
  };
  for (const block of blocks) {
    if (block.type === "paragraph" || block.type === "heading") {
      const href = visitInline(block.children);
      if (href) return href;
    } else if (block.type === "blockquote") {
      const href = sharedHref(block.children);
      if (href) return href;
    } else if (block.type === "list") for (const item of block.items) {
      const href = sharedHref(item.children);
      if (href) return href;
    }
  }
};

test("168 streamed reference orders finish like one-shot parsing", () => {
  let checked = 0;
  for (let depth = 0; depth <= 6; depth++) for (const split of splits) for (const definitionFirst of [false, true]) for (const inList of [false, true]) {
    const definition = inList ? "- [shared]: https://example.com/docs" : "[shared]: https://example.com/docs";
    const use = inList ? "- second uses [shared]." : "second uses [shared].";
    const separator = inList ? "\n" : "\n\n";
    const source = quoted(definitionFirst ? `${definition}${separator}${use}` : `${use}${separator}${definition}\n`, depth);
    const expected = "https://example.com/docs";
    expect(sharedHref(stream(source, split)), `depth ${depth}, split ${split}, definitionFirst ${definitionFirst}, inList ${inList}`).toBe(expected);
    checked++;
  }
  expect(checked).toBe(168);
});

test("168 streamed list closures replay the rejected line once", () => {
  let checked = 0;
  for (let depth = 0; depth <= 6; depth++) for (const split of splits) for (const marker of ["-", "3."]) for (const outside of ["outside", "## outside"]) {
    const source = quoted(`${marker} item\n\n${outside}`, depth);
    expect(json(stream(source, split)), `depth ${depth}, split ${split}, marker ${marker}, outside ${outside}`).toBe(json(parseMarkdown(source)));
    checked++;
  }
  expect(checked).toBe(168);
});

test("streaming lists preserve ordered starts and loose paragraphs", () => {
  for (const source of ["3. third\n4. fourth", "- first\n\n  second paragraph"]) {
    const document = createStreamingDocument();
    for (const character of source) {
      document.append(character);
      document.render();
    }
    document.finish();
    expect(json(document.render())).toBe(json(parseMarkdown(source)));
  }
});

test("streaming work counts source appends", () => {
  const document = createStreamingDocument();
  const before = document.stats.scannedCharacters;
  document.append("plain appended text");
  expect(document.stats.scannedCharacters - before).toBe("plain appended text".length * 3);
});
