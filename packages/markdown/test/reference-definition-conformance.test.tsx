import { Window } from "happy-dom";
import * as commonmark from "commonmark";
import { renderToStaticMarkup } from "react-dom/server";
import { createStreamingDocument, type Block, parseMarkdown } from "../src/index.js";
import { Markdown } from "../src/react.js";
import { MarkdownLineResolver } from "../src/resolver.js";
import examples from "./fixtures/commonmark-0.31.2.json";

type OracleReference = { destination: string; title: string };
const window = new Window();

function normalized(html: string) {
  const body = window.document.createElement("body");
  body.innerHTML = html;
  for (const preload of body.querySelectorAll('link[rel="preload"]')) preload.remove();
  for (const element of body.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      if (attribute.name.startsWith("data-") || attribute.name === "readonly") element.removeAttribute(attribute.name);
    }
  }
  return body.innerHTML.trim().replace(/>\s+</g, "><");
}

function oracle(source: string) {
  // commonmark.js counts UTF-16 units; map astral code points one-to-one so its 999-character gate follows the spec.
  const astral = new Map<string, string>();
  const encoded = source.replace(/[\u{10000}-\u{10ffff}]/gu, (character) => {
    let replacement = astral.get(character);
    if (!replacement) {
      replacement = String.fromCodePoint(0xe000 + astral.size);
      astral.set(character, replacement);
    }
    return replacement;
  });
  const decode = (value: string) => {
    for (const [character, replacement] of astral) value = value.replaceAll(replacement, character);
    return value;
  };
  const parser = new commonmark.Parser();
  const document = parser.parse(encoded);
  const references = Object.fromEntries(Object.entries(
    (parser as unknown as { refmap: Record<string, OracleReference> }).refmap,
  ).map(([label, value]) => [decode(label), {
    destination: decode(value.destination),
    title: decode(value.title),
  }]));
  return { html: decode(new commonmark.HtmlRenderer().render(document)), references };
}

function resolverReferences(source: string, finish = true) {
  const resolver = new MarkdownLineResolver();
  resolver.append(source.replace(/\r\n?/g, "\n"));
  if (finish) resolver.finish();
  return Object.fromEntries([...resolver.references].map(([label, value]) => [label, {
    destination: value.href,
    title: value.title,
  }]));
}

function links(blocks: Block[]): OracleReference[] {
  const found: OracleReference[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if ("type" in value && value.type === "link" && "href" in value && "title" in value)
      found.push({ destination: String(value.href ?? ""), title: String(value.title ?? "") });
    for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(visit);
  };
  blocks.forEach(visit);
  return found;
}

function expectOracleAgreement(source: string) {
  const expected = oracle(source);
  expect(resolverReferences(source), source).toEqual(expected.references);
  expect(parseMarkdown(source)).toBeArray();
  const safeOracleHtml = expected.html.replace("<bar>(baz)", "&lt;bar&gt;(baz)");
  expect(normalized(renderToStaticMarkup(<Markdown source={source} />))).toBe(normalized(safeOracleHtml));
}

for (const example of examples.filter(({ example }) => example >= 192 && example <= 218)) {
  test(`CommonMark reference definition example ${example.example}`, () => {
    expectOracleAgreement(example.markdown);
  });
}

const generated = [
  "[escaped\\*label]: /url\n\n[escaped\\*label]",
  "[nested]: a(b(c)d)e\n\n[nested]",
  "[brackets]: a[b]'c\"d\n\n[brackets]",
  "[angle]: <a\\>b>\n\n[angle]",
  "[encoded]: my%20url\n\n[encoded]",
  "[double]: /url \"title\"\n\n[double]",
  "[single]: /url 'title'\n\n[single]",
  "[paren]: /url (title)\n\n[paren]",
  "[multiline]: /url \"first\nsecond\"\n\n[multiline]",
  "[junk]: /url \"title\" no\n\n[junk]",
  "paragraph\n[blocked]: /url\n\n[blocked]",
  "> [quote]: /url\n>\n> [quote]",
  "- [list]: /url\n\n  [list]",
  "[duplicate]: /first\n[duplicate]: /second\n\n[duplicate]",
  "[crlf]: /url\r\n\r\n[crlf]",
  "[r]:\n[\n\n[r]",
  "[d]:\n\"\n\n[d]",
  `[${"a".repeat(998)}]: /url\n\n[${"a".repeat(998)}]`,
  `[${"a".repeat(999)}]: /url\n\n[${"a".repeat(999)}]`,
  `[${"a".repeat(1000)}]: /url\n\n[${"a".repeat(1000)}]`,
  `[${"😀".repeat(998)}]: /url\n\n[${"😀".repeat(998)}]`,
  `[${"😀".repeat(999)}]: /url\n\n[${"😀".repeat(999)}]`,
  `[${"😀".repeat(1000)}]: /url\n\n[${"😀".repeat(1000)}]`,
  `[${"\\*".repeat(499)}a]: /url\n\n[${"\\*".repeat(499)}a]`,
  `[${"\\*".repeat(500)}]: /url\n\n[${"\\*".repeat(500)}]`,
  "[ \t ]: /url\n\n[ ]",
  "[]: /url\n\n[]",
  "[foldẞ]: /url\n\n[foldß]",
];

test("generated reference definitions agree with commonmark", () => {
  for (const source of generated) expectOracleAgreement(source);
});

const indentedContinuations = [
  "[ref]: /url '\n title line1\n title line2\n '\n\n[ref]\n",
  ...[1, 2, 3, 4].flatMap((indent) => {
    const spaces = " ".repeat(indent);
    return [
      `[ref]:\n${spaces}/url\n\n[ref]\n`,
      `[ref]: /url\n${spaces}\"title\"\n\n[ref]\n`,
    ];
  }),
  "[ref]:\n\t/url\n\n[ref]\n",
  "[ref]: /url\n\t\"title\"\n\n[ref]\n",
  "> [ref]:\n>  /url\n>\n> [ref]\n",
  "> [ref]: /url\n>  \"title\"\n>\n> [ref]\n",
  "> [ref]: /url '\n>  title line1\n>  title line2\n>  '\n>\n> [ref]\n",
  "- [ref]:\n   /url\n\n  [ref]\n",
  "- [ref]: /url\n   \"title\"\n\n  [ref]\n",
  "- [ref]: /url '\n   title line1\n   title line2\n   '\n\n  [ref]\n",
];

test("publishes block-indent-normalized continuation definitions before finish", () => {
  for (const source of indentedContinuations) {
    const expected = oracle(source).references;
    expect(resolverReferences(source, false), source).toEqual(expected);
    expect(links(parseMarkdown(source)), source).toEqual(Object.values(expected));
  }
});

const matrixSource = (definition: string, _use: string, separator = "\n") => `${definition}${separator}`;
const referenceMatrix: string[] = [];

for (const indent of ["", " ", "  ", "   ", "\t", " \t", "\t ", "  \t", "\t  ", " \t "])
  for (const continuation of ["/url", "'title'"])
    referenceMatrix.push(matrixSource(`[r]:${continuation === "/url" ? "" : " /url"}\n${indent}${continuation}`, "[r]", "\n\n"));

for (const marker of [">", "> ", ">\t", "> \t", ">\t ", " >", "  >", "   >", " \t>", "\t>"])
  for (const continuation of ["/url", "'title'"])
    referenceMatrix.push(matrixSource(`${marker} [r]:${continuation === "/url" ? "" : " /url"}\n${marker} ${continuation}`, `${marker} [r]`));

for (const [marker, indent] of [["- ", "  "], ["-\t", "\t"], ["- \t", "  \t"], ["*\t ", "\t "], ["1. ", "   "], ["1.\t", "\t"], ["10. ", "    "], ["10.\t", "\t"]])
  for (const continuation of ["/url", "'title'"])
    referenceMatrix.push(matrixSource(`${marker}[r]:${continuation === "/url" ? "" : " /url"}\n${indent}${continuation}`, `${indent}[r]`));

referenceMatrix.push(
  "> [r]:\n  /url\n",
  "> [r]: /url\n  'title'\n",
  "> [r]: /url '\n  title\n> '\n",
  "- [r]:\n /url\n\n",
  "- [r]: /url\n 'title'\n\n",
  "1. [r]:\n /url\n\n",
  "1. [r]: /url\n 'title'\n\n",
  "> - [r]: /url\n  'title'\n",
);

for (const depth of [2, 3, 4, 5])
  for (const continuation of ["  /url", "  'title'"])
    referenceMatrix.push(`${"> ".repeat(depth)}[r]:${continuation.includes("title") ? " /url" : ""}\n${continuation}\n`);

for (const source of [
  "> [r]:\r\n  /url\r\n",
  "> [r]: /url\r\n  'title'\r\n",
  "> > [r]:\r\n   /url\r\n",
  "- [r]:\r\n /url\r\n\r\n",
  "1. [r]: /url\r\n 'title'\r\n\r\n",
  ">\t[r]: /url\r\n",
  ">\t  [r]: /url\r\n",
  "-\t[r]: /url\r\n\r\n",
]) referenceMatrix.push(source);

for (const wrap of [
  (body: string) => body,
  (body: string) => `> ${body.replaceAll("\n", "\n> ")}`,
  (body: string) => `- ${body.replaceAll("\n", "\n  ")}`,
  (body: string) => `1. ${body.replaceAll("\n", "\n   ")}`,
  (body: string) => `> - ${body.replaceAll("\n", "\n>   ")}`,
]) for (const indent of [" ", "   ", "\t"])
  referenceMatrix.push(wrap(`[r]: /url 'bad' junk\n${indent}next line\n`));

for (const prefix of [">\t", "> \t", ">\t ", ">\t  ", " >\t", "  >\t", "> \t ", ">\t   "])
  referenceMatrix.push(`${prefix}[r]: /url\n`);

for (const [marker, continuation] of [
  ["-\t", "\t"], ["- \t", "  \t"], ["-\t ", "\t "], ["*\t", "\t"], ["+ \t", "  \t"],
  ["1.\t", "\t"], ["1. \t", "   \t"], ["2)\t ", "\t "], ["10.\t", "\t"], ["10. \t", "    \t"],
]) for (const suffix of ["/url", "'title'"])
  referenceMatrix.push(`${marker}[r]:${suffix === "/url" ? "" : " /url"}\n${continuation}${suffix}\n\n`);

const stableBlocks = (blocks: readonly Block[]) => JSON.stringify(blocks, (key, value) => key === "open" ? undefined : value);

const lazyReferenceContinuations = [
  "> [r]: /dest\nordinary lazy prose\n\n[r]\n",
  "> [r]: /dest \"title\"\nordinary lazy prose\n\n[r]\n",
  "- [r]: /dest\nordinary lazy prose\n\n[r]\n",
  "- > [r]: /dest\nordinary lazy prose\n\n[r]\n",
  "> [r]: /dest\r\nordinary lazy prose\r\n\r\n[r]\r\n",
  "> [r]: /dest '\ncontinued title'\n\n[r]\n",
  "> [r]:\n/dest\n\n[r]\n",
  ...["```\ncode\n```", "---", "# heading", "- item", "> quote"].map((block) => `> [r]: /dest\n${block}\n\n[r]\n`),
  "> [r]: /dest\n\nordinary prose\n\n[r]\n",
];

test("lazy reference continuation trees agree with commonmark before and after finish", () => {
  for (const source of lazyReferenceContinuations) {
    expectOracleAgreement(source);
    const expected = parseMarkdown(source);
    const document = createStreamingDocument();
    document.append(source);
    expect(stableBlocks(document.render()), `before finish: ${JSON.stringify(source)}`).toBe(stableBlocks(expected));
    document.finish();
    expect(stableBlocks(document.render()), `after finish: ${JSON.stringify(source)}`).toBe(stableBlocks(expected));
    expect(resolverReferences(source, false), `resolver before finish: ${JSON.stringify(source)}`).toEqual(oracle(source).references);
    expect(resolverReferences(source), `resolver after finish: ${JSON.stringify(source)}`).toEqual(oracle(source).references);
  }
});

test("123 container-column reference cases match commonmark before finish", () => {
  expect(referenceMatrix).toHaveLength(123);
  for (const source of referenceMatrix) {
    expectOracleAgreement(source);
    const expected = parseMarkdown(source);
    const document = createStreamingDocument();
    document.append(source);
    expect(stableBlocks(document.render()), source).toBe(stableBlocks(expected));
    expect(resolverReferences(source, false), source).toEqual(oracle(source).references);
  }
});
