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

test("a code block is a named tab stop only while it overflows, measured only when the observer reports", async () => {
  const { Window } = await import("happy-dom");
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const window = new Window();
  const observed = new Set<Element>();
  const callbacks: ResizeObserverCallback[] = [];
  const content = new Map<Element, number>(); // scrollWidth by box; 100 when unset
  const box = new Map<Element, number>(); // clientWidth by box; 100 when unset
  let reads = 0;
  const restores = [
    shimGlobal("window", window),
    shimGlobal("document", window.document),
    shimGlobal("IS_REACT_ACT_ENVIRONMENT", true),
    shimProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get(this: HTMLElement) { reads++; return box.get(this) ?? 100; } }),
    shimProperty(window.HTMLElement.prototype, "scrollWidth", { configurable: true, get(this: HTMLElement) { reads++; return content.get(this) ?? 100; } }),
    // Like the browser's, this observer reports later, never inside observe().
    shimGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { callbacks.push(callback); }
      observe(target: Element) { observed.add(target); }
      unobserve(target: Element) { observed.delete(target); }
      disconnect() { observed.clear(); }
    } as unknown as typeof ResizeObserver),
  ];
  restoreBrowser = () => { for (const restore of restores.reverse()) restore(); };
  const report = (...targets: Element[]) => act(() => callbacks.at(-1)!(targets.map((target) => ({ target })) as ResizeObserverEntry[], {} as ResizeObserver));
  const container = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.appendChild(container as never);
  const root = createRoot(container);
  const source = (language: string) => `\`\`\`${language}\nconst deliberatelyLongName = true\n\`\`\`\n\n\`\`\`sh\necho ok\n\`\`\``;
  await act(() => root.render(<Markdown source={source("ts")} />));
  const [long, short] = container.querySelectorAll<HTMLElement>('[data-part="md-code-block"]');
  // A mount reads no layout: a row that content-visibility skips is never laid out early.
  expect(reads).toBe(0);
  expect(long!.hasAttribute("tabindex")).toBe(false);
  expect(callbacks).toHaveLength(1); // one observer for every box
  expect(observed).toEqual(new Set([long!, long!.firstElementChild!, short!, short!.firstElementChild!]));

  content.set(long!, 200);
  await report(long!, short!);
  expect(long!.tabIndex).toBe(0);
  expect(long!.getAttribute("aria-label")).toBe("ts code, scrollable");
  expect(short!.hasAttribute("tabindex")).toBe(false);
  expect(short!.hasAttribute("aria-label")).toBe(false);

  // Grows past its box (the code inside it reports): a tab stop.
  content.set(short!, 150);
  await report(short!.firstElementChild!);
  expect(short!.tabIndex).toBe(0);
  expect(short!.getAttribute("aria-label")).toBe("sh code, scrollable");

  // Shrinks back while focused: it keeps the tab stop, so focus stays, until focus leaves.
  short!.focus();
  content.delete(short!);
  await report(short!.firstElementChild!);
  expect(window.document.activeElement).toBe(short as never);
  expect(short!.tabIndex).toBe(0);
  short!.blur();
  expect(short!.hasAttribute("tabindex")).toBe(false);
  expect(short!.hasAttribute("aria-label")).toBe(false);

  // Its own box narrows (a container resize): a tab stop again.
  box.set(short!, 50);
  await report(short!);
  expect(short!.tabIndex).toBe(0);

  // A new language renames the stop without measuring.
  reads = 0;
  await act(() => root.render(<Markdown source={source("py")} />));
  expect(long!.getAttribute("aria-label")).toBe("py code, scrollable");
  expect(reads).toBe(0);

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
