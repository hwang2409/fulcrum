import { afterEach, expect, test } from "bun:test";
import { domShimAlarm, shimGlobal, shimProperty } from "../../../test-support/dom-shim.js";
domShimAlarm(import.meta.path);
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, type FenceProps, type Fences } from "../src/react.js";

let restoreBrowser: (() => void) | undefined;
afterEach(() => { restoreBrowser?.(); restoreBrowser = undefined; });

const calls: FenceProps[] = [];
const Diagram = (props: FenceProps) => {
  calls.push(props);
  return <figure data-done={String(props.done)} data-language={props.language}>{props.code}|{props.source}</figure>;
};
const fences: Fences = { mermaid: Diagram };
const doc = "before\n\n```mermaid\ngraph TD\nA-->B\n```\n\n```ts\nconst a = 1;\n```\n";

test("without a renderer for its language a fence is today's code block", () => {
  const plain = renderToStaticMarkup(<Markdown source={doc} />);
  expect(renderToStaticMarkup(<Markdown source={doc} fences={{}} />)).toBe(plain);
  expect(renderToStaticMarkup(<Markdown source={doc} fences={{ ts2: Diagram }} />)).toBe(plain);
  expect(plain).toContain('<pre data-part="md-code-block" data-language="mermaid">');
});

test("a renderer gets the fence text, its language, done, and the default block as source", () => {
  calls.length = 0;
  const html = renderToStaticMarkup(<Markdown source={doc} fences={fences} />);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ code: "graph TD\nA-->B\n", language: "mermaid", done: true });
  expect(html).toContain('<figure data-done="true" data-language="mermaid">graph TD\nA--&gt;B\n|<pre data-part="md-code-block" data-language="mermaid"><code>graph TD\nA--&gt;B\n</code></pre></figure>');
  // the ts fence has no renderer and is unchanged
  expect(html).toContain('<pre data-part="md-code-block" data-language="ts">');
});

test("an open fence is not done; the language matches in any case; fences nest in lists and quotes", () => {
  calls.length = 0;
  renderToStaticMarkup(<Markdown streaming source={"```Mermaid\ngraph TD\nA-->"} fences={fences} />);
  expect(calls.at(-1)).toMatchObject({ code: "graph TD\nA-->", language: "Mermaid", done: false });
  calls.length = 0;
  renderToStaticMarkup(<Markdown source={"- item\n\n  ```mermaid\n  pie\n  ```\n\n> ```mermaid\n> pie\n> ```\n"} fences={fences} />);
  expect(calls.map((call) => call.code)).toEqual(["pie\n", "pie\n"]);
});

test("only a code block that overflows is a named keyboard tab stop", async () => {
  const { Window } = await import("happy-dom");
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const window = new Window();
  const observed = new Set<Element>();
  let observers = 0;
  const restores = [
    shimGlobal("window", window),
    shimGlobal("document", window.document),
    shimGlobal("IS_REACT_ACT_ENVIRONMENT", true),
    shimProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 100 }),
    shimProperty(window.HTMLElement.prototype, "scrollWidth", { configurable: true, get(this: HTMLElement) { return this.textContent!.length > 20 ? 200 : 100; } }),
    shimGlobal("ResizeObserver", class {
      constructor(private callback: ResizeObserverCallback) { observers++; }
      observe(target: Element) { observed.add(target); this.callback([{ target }] as ResizeObserverEntry[], this as unknown as ResizeObserver); }
      unobserve(target: Element) { observed.delete(target); }
      disconnect() { observed.clear(); }
    } as unknown as typeof ResizeObserver),
  ];
  restoreBrowser = () => { for (const restore of restores.reverse()) restore(); };
  const container = window.document.createElement("div") as unknown as HTMLElement;
  const root = createRoot(container);
  await act(() => root.render(<Markdown source={"```ts\nconst deliberatelyLongName = true\n```\n\n```sh\necho ok\n```"} />));
  const blocks = container.querySelectorAll<HTMLElement>('[data-part="md-code-block"]');
  expect(blocks[0]!.tabIndex).toBe(0);
  expect(blocks[0]!.getAttribute("aria-label")).toBe("ts code, scrollable");
  expect(blocks[1]!.hasAttribute("tabindex")).toBe(false);
  expect(blocks[1]!.hasAttribute("aria-label")).toBe(false);
  expect(observers).toBe(1);
  await act(() => root.unmount());
  expect(observed.size).toBe(0);
});

test("a closed fence does not render again while later text streams in", async () => {
  const { Window } = await import("happy-dom");
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const window = new Window();
  const restores = [shimGlobal("window", window), shimGlobal("document", window.document), shimGlobal("IS_REACT_ACT_ENVIRONMENT", true)];
  restoreBrowser = () => { for (const restore of restores.reverse()) restore(); };
  const root = createRoot(window.document.createElement("div") as unknown as Element);
  let source = "```mermaid\ngraph TD\n";
  await act(() => root.render(<Markdown streaming source={source} fences={fences} />));
  source += "A-->B\n```\n\nafter";
  calls.length = 0;
  await act(() => root.render(<Markdown streaming source={source} fences={fences} />));
  expect(calls.map((call) => call.done)).toEqual([true]);
  for (const word of [" one", " two", " three"]) {
    source += word;
    await act(() => root.render(<Markdown streaming source={source} fences={fences} />));
  }
  expect(calls).toHaveLength(1);
  await act(() => root.unmount());
});

test("a code block says it streams only while its fence is open, so a streaming cursor can leave it once the fence closes", () => {
  const state = (source: string, streaming: boolean) => /<pre data-part="md-code-block"[^>]*>/.exec(renderToStaticMarkup(<Markdown source={source} streaming={streaming} />))?.[0].match(/data-state="(\w+)"/)?.[1];
  expect(state("run:\n\n```sh\nbun test\n", true)).toBe("streaming");
  expect(state("run:\n\n```sh\nbun test\n```", true)).toBeUndefined();
  expect(state("run:\n\n```sh\nbun test\n```\n\nthen", true)).toBeUndefined();
  expect(state("run:\n\n```sh\nbun test\n", false)).toBeUndefined();
});

test("while the document streams, a fence's final line break follows the cursor's anchor, open or closed", () => {
  for (const source of ["```sh\nbun run typecheck\n", "```sh\nbun run typecheck\n```\n"]) {
    const html = renderToStaticMarkup(<Markdown source={source} streaming />);
    expect(html, source).toContain('<code>bun run typecheck<span data-part="md-code-end">\n</span></code>');
  }
  // A trailing blank line keeps its line before the anchor; mid-line, the anchor ends the line.
  expect(renderToStaticMarkup(<Markdown source={"```sh\nbun\n\n"} streaming />)).toContain('<code>bun\n<span data-part="md-code-end">\n</span></code>');
  expect(renderToStaticMarkup(<Markdown source={"```sh\nbun ru"} streaming />)).toContain('<code>bun ru<span data-part="md-code-end"></span></code>');
  // A finished document renders exactly the fence text.
  expect(renderToStaticMarkup(<Markdown source={"```sh\nbun run typecheck\n```\n"} />)).toContain("<code>bun run typecheck\n</code>");
});
