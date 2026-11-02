import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createStreamingDocument,
  parseMarkdown,
  repairMarkdown,
  type Block,
} from "../src/index.js";
import { Markdown } from "../src/react.js";

const json = (blocks: readonly Block[]) => JSON.stringify(blocks, (key, value) => key === "open" ? undefined : value);

const conformance: Record<string, Array<[string, string]>> = {
  headings: [["# alpha", "<h1 data-part=\"md-heading\">alpha</h1>"], ["## beta", "<h2 data-part=\"md-heading\">beta</h2>"]],
  paragraphs: [["alpha\nbeta", "<p data-part=\"md-paragraph\">alpha\nbeta</p>"]],
  emphasis: [["*a* **b** ~~c~~", "<p data-part=\"md-paragraph\"><em data-part=\"md-emphasis\">a</em> <strong data-part=\"md-strong\">b</strong> <del data-part=\"md-strike\">c</del></p>"]],
  links: [["[site](https://example.com) <me@example.com>", "<p data-part=\"md-paragraph\"><a data-part=\"md-link\" href=\"https://example.com\">site</a> <a data-part=\"md-link\" href=\"mailto:me@example.com\">me@example.com</a></p>"]],
  quotes: [["> alpha", "<blockquote data-part=\"md-blockquote\"><p data-part=\"md-paragraph\">alpha</p></blockquote>"]],
  rules: [["---", "<hr data-part=\"md-rule\"/>"]],
  breaks: [["a  \nb", "<p data-part=\"md-paragraph\">a<br data-part=\"md-break\"/>b</p>"]],
};

for (const [section, examples] of Object.entries(conformance)) {
  test(`commonmark subset: ${section}`, () => {
    for (const [source, html] of examples)
      expect(renderToStaticMarkup(<Markdown source={source} />)).toBe(html);
  });
}

test("renders gfm blocks, nested and task lists, and fenced code language", () => {
  const source = [
    "- [x] done",
    "  - nested",
    "- open",
    "",
    "1. first",
    "2. second",
    "",
    "| a | b |",
    "| - | :-: |",
    "| 1 | 2 |",
    "",
    "```ts",
    "const n = 1;",
    "```",
  ].join("\n");
  const html = renderToStaticMarkup(<Markdown source={source} />);
  expect(html).toContain('<ul data-part="md-list">');
  expect(html).toContain('type="checkbox" disabled="" readOnly="" checked=""');
  expect(html).toContain('<ul data-part="md-list"><li data-part="md-list-item">nested</li></ul>');
  expect(html).toContain('<ol data-part="md-list">');
  expect(html).toContain('<table data-part="md-table">');
  expect(html).toContain('<pre data-part="md-code-block" data-language="ts"><code>const n = 1;</code></pre>');
});

test("repairs every streaming prefix without changing the source", () => {
  const source = "# result\n\nThe build fails because `vite.config.ts` imports `node:path` in a browser bundle. Move **the import** into [the config](./vite), or use `new";
  const document = createStreamingDocument();
  for (let index = 0; index <= source.length; index++) {
    if (index) document.append(source[index - 1]!);
    expect(json(document.render())).toBe(json(parseMarkdown(repairMarkdown(source.slice(0, index)))));
    expect(document.source).toBe(source.slice(0, index));
  }
});

test("an unclosed backtick renders as inline code and never flashes raw syntax", () => {
  const source = "The build fails because `vite.config.ts` imports `node:path` in a browser bundle. Move the import into the config's server block, or use `new";
  const html = renderToStaticMarkup(<Markdown source={source} streaming />);
  expect(html).toContain('<code data-part="md-code-inline">vite.config.ts</code>');
  expect(html).toContain('<code data-part="md-code-inline">node:path</code>');
  expect(html).toContain('<code data-part="md-code-inline">new</code>');
  expect(html).not.toContain("`new");
});

test("finished blocks keep identity and parse count while only the tail reparses", () => {
  const document = createStreamingDocument();
  document.append("first\n\nsecond");
  const first = document.render();
  const frozen = first[0];
  const parsed = document.stats.tailParses;
  expect(document.render()).toBe(first);
  expect(document.stats.tailParses).toBe(parsed);

  document.append(" grows");
  const next = document.render();
  expect(next[0]).toBe(frozen);
  expect(document.stats.frozenParses).toBe(1);
  expect(document.stats.tailParses).toBe(parsed + 1);
});

test("escapes html and removes unsafe hrefs", () => {
  const attacks = [
    "<img src=x onerror=alert(1)>",
    "[x](javascript:alert(1))",
    "[x](data:text/html,boom)",
    "<script>alert(1)</script>",
  ];
  for (const source of attacks) {
    const html = renderToStaticMarkup(<Markdown source={source} />);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text");
  }
  const safe = renderToStaticMarkup(<Markdown source="[a](/relative) [b](mailto:a@b.co)" />);
  expect(safe).toContain('href="/relative"');
  expect(safe).toContain('href="mailto:a@b.co"');
});

test("fuzzed html and scheme fragments never become executable markup", () => {
  let seed = 0x5eed;
  const alphabet = "<>/='\\\" javascript:data:onerror scriptimg[]()abcdefghijklmnopqrstuvwxyz";
  for (let sample = 0; sample < 200; sample++) {
    let source = "";
    for (let index = 0; index < 80; index++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      source += alphabet[seed % alphabet.length];
    }
    source += " [x](javascript:alert(1)) <img src=x onerror=alert(1)>";
    const html = renderToStaticMarkup(<Markdown source={source} />);
    expect(html).not.toMatch(/<(?:script|img)\b/i);
    expect(html).not.toMatch(/href=\"(?:javascript|data):/i);
  }
});

test("highlighter receives only complete lines and emits fixed token classes", async () => {
  const calls: string[] = [];
  const highlight = (code: string) => {
    calls.push(code);
    return [{ type: "keyword" as const, content: code }];
  };
  renderToStaticMarkup(<Markdown source={'```ts\nconst a = 1;\npartial'} streaming highlight={highlight} />);
  await Promise.resolve();
  expect(calls).toEqual(["const a = 1;\n"]);
});
