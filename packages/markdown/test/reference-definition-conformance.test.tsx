import { Window } from "happy-dom";
import * as commonmark from "commonmark";
import { renderToStaticMarkup } from "react-dom/server";
import { type Block, parseMarkdown } from "../src/index.js";
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
  expect(resolverReferences(source)).toEqual(expected.references);
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
