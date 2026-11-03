import { expect, test } from "bun:test";
import { createStreamingDocument, parseMarkdown, type Block } from "../src/index.js";

const splits = [1, 2, 3, 7, 20, 1000];
const json = (blocks: readonly Block[]) => JSON.stringify(blocks, (key, value) => key === "open" ? undefined : value);
const quote = (source: string, depth: number) => source.split("\n").map((line) => `${"> ".repeat(depth)}${line}`).join("\n");

function stream(source: string, split: number) {
  const document = createStreamingDocument();
  for (let offset = 0; offset < source.length; offset += split) {
    document.append(source.slice(offset, offset + split));
    document.render();
  }
  return document.render();
}

function referenceSource(title: string, order: "definition-first" | "use-first", list: "root" | "ul" | "ol", depth: number) {
  const marker = list === "ul" ? "- " : list === "ol" ? "3. " : "";
  const indent = list === "root" ? "" : " ".repeat(marker.length);
  const definition = `${marker}[shared]: https://example.com/docs\n${indent}${title}`;
  const use = `${marker}reader opens [shared].`;
  const separator = list === "root" ? "\n\n" : "\n";
  return quote(order === "definition-first" ? `${definition}${separator}${use}\n` : `${use}${separator}${definition}\n`, depth);
}

test("972 next-line reference titles match one-shot parsing while active", () => {
  let mismatches = 0;
  let cases = 0;
  for (const title of ['"next title"', "'next title'", "(next title)"])
    for (const order of ["definition-first", "use-first"] as const)
      for (const list of ["root", "ul", "ol"] as const)
        for (let depth = 0; depth <= 8; depth++)
          for (const split of splits) {
            const source = referenceSource(title, order, list, depth);
            if (json(stream(source, split)) !== json(parseMarkdown(source))) mismatches++;
            cases++;
          }
  expect(cases).toBe(972);
  expect(mismatches).toBe(0);
});

function deepestParagraphCount(blocks: readonly Block[]): number {
  const block = blocks[0];
  if (block?.type === "blockquote") return deepestParagraphCount(block.children);
  return Array.from(blocks).filter((candidate) => candidate.type === "paragraph").length;
}

test("five depth-four continuations stay in the unfinished physical line", () => {
  const definitions = [
    "[shared]: <https://example.com/docs>",
    '[shared]: https://example.com/docs "title"',
    "[shared]: https://example.com/docs 'title'",
    "[shared]: https://example.com/docs (title)",
  ];
  const sources = definitions.map((definition) => `> > > > reader opens [shared].\n> > > >\n> > > > ${definition}\n`);
  sources.push("> > > > reader opens shared.\n> > > >\n> > > > outside\n");
  let mismatches = 0;
  for (const source of sources) if (deepestParagraphCount(stream(source, 20)) !== deepestParagraphCount(parseMarkdown(source))) mismatches++;
  expect(mismatches).toBe(0);
});

function generatedReferenceSource(first: string, continuation: string | undefined, order: "definition-first" | "use-first", list: "root" | "ul" | "ol", depth: number) {
  const marker = list === "ul" ? "- " : list === "ol" ? "3. " : "";
  const indent = list === "root" ? "" : " ".repeat(marker.length);
  const definition = marker + first + (continuation ? `\n${indent}${continuation}` : "");
  const use = `${marker}reader opens [shared].`;
  const separator = list === "root" ? "\n\n" : "\n";
  return quote(order === "definition-first" ? `${definition}${separator}${use}\n` : `${use}${separator}${definition}\n`, depth);
}

const invariantSources = new Set<string>();
const referenceShapes: Array<[string, string?]> = [
  ["[shared]: <https://example.com/docs>"],
  ['[shared]: https://example.com/docs "double title"'],
  ["[shared]: https://example.com/docs 'single title'"],
  ["[shared]: https://example.com/docs (paren title)"],
  ["[shared]: https://example.com/docs", '"next title"'],
  ["[shared]: https://example.com/docs", "'next title'"],
  ["[shared]: https://example.com/docs", "(next title)"],
  ["[shared]: <https://example.com/docs"],
  ['[shared]: https://example.com/docs "never closes'],
];
for (const [first, continuation] of referenceShapes.slice(0, 7))
  for (const order of ["definition-first", "use-first"] as const)
    for (const list of ["root", "ul", "ol"] as const)
      for (let depth = 0; depth <= 8; depth++) invariantSources.add(generatedReferenceSource(first, continuation, order, list, depth));
for (const source of [
  "plain **strong** *emphasis* ~~strike~~ `code` &amp; end",
  "stream title\n===",
  "| head | value |\n| --- | ---: |\n| row | final |",
  "```ts\nconst x = '<safe>';\n```",
  "~~~sh\nprintf safe\n~~~",
  "- alpha\n\n  second paragraph",
  "3. third\n4. fourth",
  "Use [shared].\n\n[shared]: <https://example.com/docs>\n",
  "[shared]: https://example.com/docs 'title'\n\nUse [shared].",
  "<div>literal html</div>",
]) for (let depth = 0; depth <= 8; depth++) invariantSources.add(quote(source, depth));
for (const marker of ["-", "3."])
  for (const outside of ["outside sentinel", "## outside sentinel", "> outside sentinel"])
    for (let depth = 0; depth <= 8; depth++) invariantSources.add(quote(`${marker} item\n\n${outside}`, depth));
for (const source of ["- first\n\n  second paragraph", "3. first\n\n   second paragraph", "- first\n\noutside", "3. first\n\noutside"])
  for (let depth = 0; depth <= 8; depth++) invariantSources.add(quote(source, depth));

const endsInProvisionalDefinition = (source: string) => /(?:^|\n)(?: {0,3}> ?)*(?: {0,3}(?:[-+*]|\d{1,9}[.)])\s+)?\[[^\]\n]+\]:[^\n]*(?:\n(?: {0,3}> ?)*)?$/.test(source);

test("generator sources match one-shot parsing except a precisely pending eof definition", () => {
  let mismatches = 0;
  let pendingEofDefinitions = 0;
  let cases = 0;
  for (const source of invariantSources) for (const split of splits) {
    const active = json(stream(source, split));
    const expected = json(parseMarkdown(source));
    if (active !== expected) {
      if (endsInProvisionalDefinition(source) && active.includes('"type":"pending-reference","value":"shared"')) pendingEofDefinitions++;
      else mismatches++;
    }
    cases++;
  }
  expect(cases).toBe(3348);
  // These are only definitions whose physical line or possible title continuation has no newline yet.
  expect(pendingEofDefinitions).toBe(216);
  expect(mismatches).toBe(0);
});

test("648 incomplete definitions equal one-shot parsing after finish", () => {
  let cases = 0;
  for (const [first, continuation] of referenceShapes.slice(7))
    for (const order of ["definition-first", "use-first"] as const)
      for (const list of ["root", "ul", "ol"] as const)
        for (let depth = 0; depth <= 8; depth++)
          for (const split of splits) {
            const source = generatedReferenceSource(first, continuation, order, list, depth);
            const document = createStreamingDocument();
            for (let offset = 0; offset < source.length; offset += split) document.append(source.slice(offset, offset + split));
            document.finish();
            expect(json(document.render())).toBe(json(parseMarkdown(source)));
            cases++;
          }
  expect(cases).toBe(648);
});

test("a terminal definition stays pending until its continuation line is decided", () => {
  const source = "reader opens [shared].\n\n[shared]: https://example.com/docs";
  const document = createStreamingDocument();
  document.append(source);
  expect(json(document.render())).toContain('"type":"pending-reference","value":"shared"');
  document.append("\n");
  expect(json(document.render())).toContain('"type":"pending-reference","value":"shared"');
  document.append('"next title"');
  expect(json(document.render())).toBe(json(parseMarkdown(`${source}\n"next title"`)));
});
