import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, type FenceProps, type Fences } from "../src/react.js";

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

test("a closed fence does not render again while later text streams in", async () => {
  const { Window } = await import("happy-dom");
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const window = new Window();
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
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
