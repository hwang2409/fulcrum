import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/react.js";
import commonmark from "./fixtures/commonmark-0.31.2.json";
import gfm from "./fixtures/gfm-0.29.json";

type Example = { markdown: string; html: string; example: number; section: string };
const window = new Window();

function normalized(html: string) {
  const body = window.document.createElement("body");
  body.innerHTML = html;
  for (const preload of body.querySelectorAll('link[rel="preload"]')) preload.remove();
  for (const element of body.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      if (attribute.name.startsWith("data-") || attribute.name === "readonly" || attribute.name === "class" && attribute.value.startsWith("language-")) element.removeAttribute(attribute.name);
    }
  }
  const visit = (node: Node): unknown => {
    if (node.nodeType === 3) {
      const hasElementSibling = [...(node.parentNode?.childNodes ?? [])].some((child) => child.nodeType === 1);
      return hasElementSibling ? node.textContent?.replace(/^\n|\n$/g, "") : node.textContent;
    }
    const element = node as Element;
    const hasElements = [...node.childNodes].some((child) => child.nodeType === 1);
    return {
      name: node.nodeName.toLowerCase(),
      attributes: [...(element.attributes ?? [])].map(({ name, value }) => [name, value]).sort(),
      children: [...node.childNodes]
        .filter((child) => !((hasElements || ["body", "blockquote", "ul", "ol", "li", "table", "thead", "tbody", "tr"].includes(node.nodeName.toLowerCase())) && child.nodeType === 3 && !child.textContent?.trim()))
        .map(visit),
    };
  };
  return visit(body);
}

const requiresRawHtml = ({ markdown }: Example) => /<!--|<\/?[A-Za-z][A-Za-z\d-]*(?:\s[^>]*|\s*\/?)>/.test(markdown);

function runSuite(examples: Example[]) {
  const excluded = examples.filter(({ section }) => section === "HTML blocks" || section === "Raw HTML" || section === "Disallowed Raw HTML").concat(examples.filter(requiresRawHtml));
  const included = examples.filter((example) => !excluded.includes(example));
  const failures = included.filter(({ markdown, html }) => JSON.stringify(normalized(renderToStaticMarkup(<Markdown source={markdown} />))) !== JSON.stringify(normalized(html)));
  return { included, excluded, failures, rate: (included.length - failures.length) / included.length };
}

for (const [name, examples] of [["commonmark 0.31.2", commonmark], ["gfm 0.29", gfm]] as const) {
  test(`${name} spec conformance is at least 95%`, () => {
    const result = runSuite(examples as Example[]);
    console.log(`${name}: ${result.included.length - result.failures.length}/${result.included.length}; excluded raw-html examples: ${result.excluded.map(({ example }) => example).join(", ")}`);
    if (result.rate < 0.95) console.log(`failed examples: ${result.failures.map(({ example }) => example).join(", ")}`);
    expect(result.rate).toBeGreaterThanOrEqual(0.95);
  });
}
