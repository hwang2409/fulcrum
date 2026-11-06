import { Window } from "happy-dom";
import * as commonmark from "commonmark";
import { renderToStaticMarkup } from "react-dom/server";
import { parseMarkdown } from "../src/index.js";
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
  const parser = new commonmark.Parser();
  const document = parser.parse(source);
  return {
    html: new commonmark.HtmlRenderer().render(document),
    references: (parser as unknown as { refmap: Record<string, OracleReference> }).refmap,
  };
}

function fulcrumReferences(source: string) {
  const resolver = new MarkdownLineResolver();
  resolver.append(source.replace(/\r\n?/g, "\n"));
  resolver.finish();
  return Object.fromEntries([...resolver.references].map(([label, value]) => [label, {
    destination: value.href,
    title: value.title,
  }]));
}

function expectOracleAgreement(source: string) {
  const expected = oracle(source);
  expect(fulcrumReferences(source)).toEqual(expected.references);
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
  `[${"😀".repeat(999)}]: /url\n\n[${"😀".repeat(999)}]`,
  `[${"😀".repeat(1000)}]: /url\n\n[${"😀".repeat(1000)}]`,
  `[${"\\*".repeat(499)}a]: /url\n\n[${"\\*".repeat(499)}a]`,
  `[${"\\*".repeat(500)}]: /url\n\n[${"\\*".repeat(500)}]`,
  "[ \t ]: /url\n\n[ ]",
  "[]: /url\n\n[]",
  "[foldẞ]: /url\n\n[foldß]",
];

test.each(generated)("generated reference definition agrees with commonmark: %s", (source) => {
  expectOracleAgreement(source);
});
