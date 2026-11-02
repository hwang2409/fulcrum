import { expect, test } from "bun:test";
import type { Highlight, HighlightContext, Token } from "@fulcrum/highlight";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createStreamingDocument,
  parseMarkdown,
  type Block,
} from "../src/index.js";
import { Markdown } from "../src/react.js";
import corpus from "./fixtures/agent-corpus.json";

const json = (blocks: readonly Block[]) => JSON.stringify(blocks, (key, value) => key === "open" ? undefined : value);
const window = new Window();
const visibleText = (source: string, streaming = false) => {
  const element = window.document.createElement("div");
  element.innerHTML = renderToStaticMarkup(<Markdown source={source} streaming={streaming} />);
  return element.textContent;
};
const isSubsequence = (value: string, expected: string) => {
  let index = 0;
  for (const character of expected) if (character === value[index]) index++;
  return index === value.length;
};

const conformance: Record<string, Array<[string, string]>> = {
  headings: [["# alpha", "<h1 data-part=\"md-heading\">alpha</h1>"], ["## beta", "<h2 data-part=\"md-heading\">beta</h2>"], ["setext\n===", "<h1 data-part=\"md-heading\">setext</h1>"]],
  paragraphs: [["alpha\nbeta", "<p data-part=\"md-paragraph\">alpha\nbeta</p>"]],
  emphasis: [["*a* **b** ~~c~~", "<p data-part=\"md-paragraph\"><em data-part=\"md-emphasis\">a</em> <strong data-part=\"md-strong\">b</strong> <del data-part=\"md-strike\">c</del></p>"]],
  codeSpans: [["`` a ` b ``", "<p data-part=\"md-paragraph\"><code data-part=\"md-code-inline\">a ` b</code></p>"]],
  entities: [["&lt;b&gt; &amp;", "<p data-part=\"md-paragraph\">&lt;b&gt; &amp;</p>"]],
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
  expect(html).toContain('<pre data-part="md-code-block" data-language="ts"><code>const n = 1;\n</code></pre>');
});

test("covers gfm references, literal autolinks, images, escaped tables, and indented code", () => {
  const source = [
    "[docs]: https://example.com/docs",
    "",
    "[reference][docs] and www.example.com and dev@example.com",
    "",
    "![logo](/logo.png)",
    "",
    "| expression | result |",
    "| --- | --- |",
    "| a \\| b | ok |",
    "",
    "    const indented = true;",
  ].join("\n");
  const html = renderToStaticMarkup(<Markdown source={source} />);
  expect(html).toContain('href="https://example.com/docs"');
  expect(html).toContain('href="http://www.example.com"');
  expect(html).toContain('href="mailto:dev@example.com"');
  expect(html).toContain('data-part="md-image"');
  expect(html).toContain("a | b");
  expect(html).toContain('<pre data-part="md-code-block"><code>const indented = true;\n</code></pre>');
});

test("streaming never changes the source", () => {
  const source = "# result\n\nThe build fails because `vite.config.ts` imports `node:path` in a browser bundle. Move **the import** into [the config](./vite), or use `new";
  const document = createStreamingDocument();
  for (let index = 0; index <= source.length; index++) {
    if (index) document.append(source[index - 1]!);
    document.render();
    expect(document.source).toBe(source.slice(0, index));
  }
});

test("holds unmatched emphasis and link syntax while rendering open code", () => {
  expect(renderToStaticMarkup(<Markdown source="**bold" streaming />)).toBe('<p data-part="md-paragraph">bold</p>');
  expect(renderToStaticMarkup(<Markdown source="[docs](https://example.com" streaming />)).toBe('<p data-part="md-paragraph">docs</p>');
  expect(renderToStaticMarkup(<Markdown source="use ``a ` b" streaming />)).toContain('<code data-part="md-code-inline">a ` b</code>');
  expect(renderToStaticMarkup(<Markdown source={'```ts\nconst x = 1;'} streaming />)).toContain('<pre data-part="md-code-block" data-language="ts">');
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
  expect(document.stats.tailParses).toBe(parsed);
});

test("escapes html and removes unsafe hrefs", () => {
  const attacks = [
    "<img src=x onerror=alert(1)>",
    "[x](javascript:alert(1))",
    "[x](data:text/html,boom)",
    "[x](java\tscript:alert(1))",
    "[x](java\nscript:alert(1))",
    "[x](//example.com/remote)",
    "![x](javascript:alert(1))",
    "<script>alert(1)</script>",
  ];
  for (const source of attacks) {
    const html = renderToStaticMarkup(<Markdown source={source} />);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/href=\"(?:javascript|data):/i);
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

test("renders the review's commonmark failures correctly", () => {
  const source = [
    "[docs](https://example.com/a_(b))",
    "",
    "***important***  ",
    "hard break",
    "",
    "1. Verify:",
    "   ```sh",
    "   bun test",
    "   ```",
    "",
    "   loose continuation",
    "",
    "![logo](/logo.png) [reference][docs]",
    "",
    "[docs]: https://example.com/reference",
  ].join("\n");
  const html = renderToStaticMarkup(<Markdown source={source} />);
  expect(html).toContain('href="https://example.com/a_(b)"');
  expect(html).toContain("<em data-part=\"md-emphasis\"><strong data-part=\"md-strong\">important</strong></em><br data-part=\"md-break\"/>");
  expect(html).toContain('<pre data-part="md-code-block" data-language="sh"><code>bun test\n</code></pre>');
  expect(html).toContain('<img data-part="md-image" src="/logo.png" alt="logo"/>');
  expect(html).toContain('href="https://example.com/reference"');
});

test("does not freeze a blank line inside a fenced block", () => {
  const source = "```sh\nline1\n\nline2\n```";
  const document = createStreamingDocument();
  for (const character of source) {
    document.append(character);
    document.render();
  }
  document.finish();
  expect(json(document.render())).toBe(json(parseMarkdown(source)));
  expect(document.render()).toHaveLength(1);
  expect(document.render()[0]?.type).toBe("code");
});

test("the agent corpus has the expected shape 20/20", () => {
  const expected = [
    ["md-heading", "md-list", "md-code-inline", "md-strong"],
    ["md-heading", "md-list", "md-code-inline", "md-link"],
    ["md-heading", "md-code-block"],
    ["md-code-block", "md-paragraph"],
    ["md-table"],
    ["checkbox"],
    ["md-blockquote", "md-link"],
    ["md-code-inline"],
    ["md-code-inline", "https://api.example.com/v1/items_(archived)"],
    ["md-list", "md-code-inline"],
    ["md-emphasis", "md-strong", "md-strike", "md-rule"],
    ["data-language=\"json\""],
    ["data-language=\"sh\"", "md-list"],
    ["md-table", "md-code-inline", "md-strong"],
    ["mailto:dev@example.com", "http://www.example.org/docs"],
    ["&lt;script&gt;", "bad"],
    ["md-code-inline", "md-strong"],
    ["md-list", "md-code-inline"],
    ["href=\"https://example.com/a_(b)\"", "md-code-block"],
    ["md-code-inline"],
  ];
  corpus.forEach((source, index) => {
    const html = renderToStaticMarkup(<Markdown source={source} streaming={index === 19} />);
    for (const part of expected[index]!) expect(html, `corpus reply ${index + 1}`).toContain(part);
  });
});

test("every streamed prefix only reveals final visible text", () => {
  const exactExample = "The build fails because `vite.config.ts` imports `node:path` in a browser bundle. Move the import into the config's server block, or use `new";
  for (const source of [exactExample, ...corpus]) {
    const finalText = visibleText(source, true);
    for (let length = 0; length <= source.length; length++) {
      const prefixText = visibleText(source.slice(0, length), true);
      expect(isSubsequence(prefixText, finalText), `visible prefix ${length} of ${JSON.stringify(source)}`).toBe(true);
    }
  }
});

test("every corpus character prefix streams once and finishes identically", () => {
  for (const source of corpus) {
    const document = createStreamingDocument();
    for (const character of source) {
      const parses = document.stats.tailParses;
      document.append(character);
      const current = document.render();
      expect(document.stats.tailParses - parses).toBeLessThanOrEqual(1);
      expect(current).toBe(document.render());
    }
    document.finish();
    expect(json(document.render())).toBe(json(parseMarkdown(source)));
  }
  for (const delimiter of ["`", "**", "*", "_", "[", "```", "~~~"]) {
    expect(createStreamingDocument().source).toBe("");
    expect(renderToStaticMarkup(<Markdown source={delimiter} streaming />)).toBe("");
  }
});

test("renders a real typescript fence with the shared highlighter", async () => {
  const build = Bun.spawnSync(["bun", "run", "build"], { cwd: new URL("../../highlight/", import.meta.url).pathname });
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());
  const { createHighlighter } = await import("../../highlight/dist/index.js");
  const browser = new Window();
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true });
  const container = browser.document.createElement("div");
  const root = createRoot(container);
  const highlight = createHighlighter({ worker: false });
  await act(async () => root.render(<Markdown source={'```typescript\nconst value: string = "ok";\n```'} highlight={highlight} />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(container.querySelector('[data-language="typescript"]')?.textContent).toBe('const value: string = "ok";\n');
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1_500)));
  await act(async () => root.unmount());
  highlight.dispose();
}, 15_000);

test("a stale streaming highlight cannot replace the done result", async () => {
  const browser = new Window();
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true });
  const container = browser.document.createElement("div");
  const root = createRoot(container);
  const pending: Array<(tokens: Token[]) => void> = [];
  const highlight: Highlight = Object.assign(
    () => new Promise<Token[]>((resolve) => pending.push(resolve)),
    { dispose() {} },
  );

  await act(async () => root.render(<Markdown source={'```ts\nconst value = 1;\n'} streaming highlight={highlight} />));
  await act(async () => root.render(<Markdown source={'```ts\nconst value = 1;\n```'} highlight={highlight} />));
  await act(async () => pending[1]!([{ text: "done", type: "string" }]));
  expect(container.innerHTML).toContain("tok-string");
  await act(async () => pending[0]!([{ text: "stale", type: "keyword" }]));
  expect(container.innerHTML).toContain("tok-string");
  expect(container.innerHTML).not.toContain("tok-keyword");
  await act(async () => root.unmount());
});

test("highlighter uses the shared cumulative source contract", async () => {
  const calls: Array<{ code: string; context?: HighlightContext }> = [];
  const highlight: Highlight = Object.assign(
    (code: string, _language: string | undefined, context?: HighlightContext) => {
      calls.push({ code, context });
      return [{ type: "keyword" as const, text: code }];
    },
    { dispose() {} },
  );
  renderToStaticMarkup(<Markdown id="message:one" source={'```ts\nconst a = 1;\npartial'} streaming highlight={highlight} />);
  renderToStaticMarkup(<Markdown id="message:one" source={'```ts\nconst a = 1;\npartial\n```'} highlight={highlight} />);
  await Promise.resolve();
  expect(calls).toEqual([
    { code: "const a = 1;\npartial", context: { id: "message:one:0", version: 1, state: "streaming" } },
    { code: "const a = 1;\npartial\n", context: { id: "message:one:0", version: 1, state: "done" } },
  ]);
});
