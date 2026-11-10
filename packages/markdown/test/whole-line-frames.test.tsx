import { afterEach, expect, test } from "bun:test";
import { shimGlobal } from "../../../test-support/dom-shim.js";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/react.js";

let restoreBrowser: (() => void) | undefined;
afterEach(() => { restoreBrowser?.(); restoreBrowser = undefined; });

// A frame that ends exactly at a line break (a server that sends whole lines, or a store that batches a frame) must show
// that line in a live view as it does in a fresh one: a table row, a list item, or a quote line that grew its block in
// place stayed hidden behind the memoized block view until the next line began.
const cases = [
  "Results:\n\n| check | result |\n|---|---|\n| typecheck | pass |\n| tests | 412 pass |\n\nDone.",
  "> | a | b |\n> |---|---|\n> | 1 | 2 |\n> | 3 | 4 |\n",
  "a | b\n--|--\n1 | 2\n3 | 4\n",
  "- item\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n",
  "- one\n- two\n- three\n",
  "> first\n> second\n> third\n",
  "line one\nline two\nline three\n",
];
const lines = (source: string) => source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const plans: Array<[string, (source: string) => string[]]> = [
  ["one whole line per frame", lines],
  ["two lines per frame", (source) => lines(source).reduce<string[]>((frames, line, index) => (index % 2 ? frames[frames.length - 1] += line : frames.push(line), frames), [])],
];

test("a line that ends with its frame shows at once in a live view", async () => {
  const window = new Window();
  const restores = [shimGlobal("window", window), shimGlobal("document", window.document), shimGlobal("IS_REACT_ACT_ENVIRONMENT", true)];
  restoreBrowser = () => { for (const restore of restores.reverse()) restore(); };
  const text = (html: string) => {
    const element = window.document.createElement("div");
    element.innerHTML = html;
    return element.textContent!.replace(/\s/g, "");
  };
  for (const source of cases) for (const [name, plan] of plans) {
    const container = window.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    let sent = "";
    try {
      for (const frame of plan(source)) {
        sent += frame;
        await act(() => root.render(<Markdown streaming source={sent} />));
        const fresh = text(renderToStaticMarkup(<Markdown streaming source={sent} />));
        expect(container.textContent!.replace(/\s/g, ""), `${name}: ${JSON.stringify(sent)}`).toBe(fresh);
      }
    } finally {
      await act(() => root.unmount());
    }
  }
});
