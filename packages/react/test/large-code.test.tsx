import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { shimProperty } from "../../../test-support/dom-shim.js";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRunStore, type RunEvent, type ToolView } from "@fulcrum/core";
import type { Highlight, Token } from "@fulcrum/highlight";
import { Markdown } from "../../markdown/src/react.js";
import { RunProvider, ToolCall } from "../src/index.js";

// happy-dom does no layout: a viewer's scroll box is as tall as styles.css makes it, so its visible rows mount.
afterAll(() => GlobalRegistrator.unregister());
let root: Root | undefined;
let container: HTMLElement;
const restoreShims: Array<() => void> = [];
beforeEach(() => restoreShims.push(shimProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get(this: HTMLElement) { return this.dataset.part === "text-viewer" ? 320 : 0; } })));
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  restoreShims.splice(0).reverse().forEach((restore) => restore());
});
const mount = (node: ReactNode) => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
};

const repo = new URL("../../../", import.meta.url).pathname;
const RENDERERS = new Set(["Tokens", "MarkedTokens", "Code", "useTokens", "tokenLines"]);

// Every module that draws highlight tokens, and what keeps its one commit small. A new one fails here until it is
// listed with its bound, and gets a case in the test below.
const consumers: Record<string, string> = {
  "packages/react/src/code.ts": "re-exports the shared module for @fulcrum/markdown",
  "packages/react/src/tools/text-viewer.tsx": "the shared module: one range per highlight block, at most INLINE_CHARS inline, the virtual viewer above",
  "packages/react/src/tools/common.tsx": "NumberedLines draws inline only under needsTextViewer",
  "packages/react/src/tools/edit.tsx": "diff rows, drawn by TextViewer in bounded groups",
  "packages/react/src/tools/search.tsx": "search rows, drawn by TextViewer in bounded groups",
  "packages/react/src/tools/shell.tsx": "the command is inline only under isLargeCode, CodeViewer above",
  "packages/react/src/parts.tsx": "the summary is one line, cut to MAX_SUMMARY_CHARS",
  "packages/markdown/src/react.tsx": "a fence is inline only under isLargeCode, CodeViewer above",
  "apps/playground/src/highlight-demo.tsx": "four fixed small samples",
};

test("every token surface goes through the shared token module", async () => {
  const found: string[] = [];
  for (const file of new Bun.Glob("{packages,apps}/*/src/**/*.{ts,tsx}").scanSync(repo)) {
    if (file.includes("/vendor/")) continue;
    const text = await Bun.file(repo + file).text();
    // Token spans are made in one place.
    if (/tok-\$\{/.test(text)) expect(file).toBe("packages/react/src/highlight.tsx");
    for (const match of text.matchAll(/(?:import|export) \{([^}]*)\} from "([^"]+)"/g)) {
      const names = match[1]!.split(",").map((name) => name.trim().replace(/^type /, "").split(" ")[0]!);
      const from = match[2]!;
      if ((from.endsWith("/highlight.js") || from === "@fulcrum/react/code") && names.some((name) => RENDERERS.has(name))) found.push(file);
    }
  }
  expect(found.sort()).toEqual(Object.keys(consumers).sort());
});

// One typed token per word and per symbol: the dense cpp line below is 33 tokens, so 9,999 lines are about 330k tokens.
const tokens = (code: string): Token[] => code.match(/\w+|\W/g)!.map((text) => /\w/.test(text) ? { text, type: "keyword" as const } : { text });
let asked = 0;
const highlight: Highlight = Object.assign((code: string) => { asked += code.length; return tokens(code); }, { dispose() {}, subscribe: () => () => {} });
const line = "A<B<C,D>,E<F>>::g(h++,--i,j+=k,l?m:n); // x\n";
const large = line.repeat(9_999);
const longRows = Array.from({ length: 100 }, () => line.repeat(200).replaceAll("\n", " ")); // 100 rows of 9,000 characters
const spans = () => container.querySelectorAll("[class^=tok-]").length;
// The most token spans any one surface may mount: about INLINE_CHARS of the densest code. 330k are on offer.
const BOUND = 12_000;

const tool = (id: string, view: ToolView, output = ""): RunEvent[] => {
  const tool_call = { id, name: view.kind, arguments: {} };
  return [
    { type: "tool_start", tool_call, view },
    ...(output ? [{ type: "tool_output", tool_call, output } as RunEvent] : []),
    { type: "tool_end", tool_call, tool_result: { tool_call_id: id, content: output, is_error: false } },
  ];
};
const card = (events: RunEvent[], id: string) => {
  const store = createRunStore(() => {});
  events.forEach(store.dispatch);
  mount(<RunProvider store={store} highlight={highlight}><ToolCall id={id} /></RunProvider>);
  const details = container.querySelector<HTMLDetailsElement>(`[data-id="${id}"]`)!;
  act(() => { details.open = true; details.dispatchEvent(new Event("toggle")); });
};

test.each([
  ["markdown fence", () => mount(<Markdown id="m" source={"```cpp\n" + large + "```\n"} highlight={highlight} />)],
  ["streaming markdown fence", () => mount(<Markdown id="m" source={"```cpp\n" + large} streaming highlight={highlight} />)],
  ["shell command", () => card(tool("c", { kind: "shell", command: large }), "tool:c")],
  ["json output", () => card(tool("o", { kind: "shell", command: "cat a.json" }, JSON.stringify(Array.from({ length: 40_000 }, (_, id) => ({ id, ok: true })), null, 2)), "tool:o")],
  ["read", () => card(tool("r", { kind: "read", path: "a.cpp" }, large), "tool:r")],
  ["write", () => card(tool("w", { kind: "write", path: "a.cpp", content: large }), "tool:w")],
  ["edit with long rows", () => card(tool("e", { kind: "edit", path: "a.cpp", diff: ["@@ -1,100 +1,100 @@", ...longRows.map((row) => `-${row}`), ...longRows.map((row) => `+${row}`)].join("\n") }), "tool:e")],
  ["search with long rows", () => card(tool("s", { kind: "search", pattern: "x", path: "src" }, longRows.map((row, index) => `src/a.cpp:${index + 1}:${row}`).join("\n")), "tool:s")],
] as Array<[string, () => void]>)("a 330k-token %s mounts a bounded number of token spans, closed and open", (_, show) => {
  asked = 0;
  show();
  expect(spans()).toBeLessThanOrEqual(BOUND);
  const open = container.querySelector<HTMLButtonElement>('[data-action="open-viewer"]');
  if (open) act(() => open.click());
  const viewer = container.querySelector('[data-part="text-viewer"]')!;
  expect(viewer.querySelector("[class^=tok-]")).not.toBeNull(); // the visible rows are highlighted, not left plain
  expect(spans()).toBeLessThanOrEqual(BOUND);
  expect(asked).toBeLessThan(large.length / 2); // only the drawn ranges are highlighted, never the whole text at once
});

test("a large fence shows an honest line count and copies the whole text", async () => {
  const copied: string[] = [];
  restoreShims.push(shimProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } }));
  mount(<Markdown id="m" source={"```cpp\n" + large + "```\n"} highlight={highlight} />);
  const block = container.querySelector('[data-part="md-code-block"]')!;
  expect(block.getAttribute("data-size")).toBe("large");
  expect(block.querySelector('[data-part="text-viewer-count"]')!.textContent).toBe("9,999 lines · 439,956 characters");
  const viewer = block.querySelector('[data-part="text-viewer"]')!;
  expect(viewer.getAttribute("tabindex")).toBe("0"); // keyboard scrolling
  await act(async () => block.querySelector<HTMLButtonElement>('[aria-label="copy code"]')!.click());
  expect(copied).toEqual([large]);
});

test("a fence under the limits stays one inline block", () => {
  const code = "int a = 1;\n".repeat(39);
  mount(<Markdown id="m" source={"```cpp\n" + code + "```\n"} highlight={highlight} />);
  expect(container.querySelector('[data-part="text-viewer"]') === null).toBe(true);
  expect(container.querySelector("pre[data-part=md-code-block] > code")!.textContent).toBe(code);
});

// A stand-in grammar with state that spans lines: a /* */ comment and a """ """ docstring color everything inside them.
const stateful: Highlight = Object.assign((code: string) => code.match(/\/\*[\s\S]*?(?:\*\/|$)|"""[\s\S]*?(?:"""|$)|\w+|\W/g)!.map((text): Token =>
  text.startsWith("/*") ? { text, type: "comment" } : text.startsWith('"""') ? { text, type: "string" } : /\w/.test(text) ? { text, type: "keyword" } : { text }), { dispose() {}, subscribe: () => () => {} });

test.each([
  // A 2,000-character construct crosses three range edges; 45 more lines put the fence over INLINE_LINES.
  ["a 2,000-character block comment", "cpp", "/*" + " x".repeat(998) + " */\n" + "int a;\n".repeat(45)],
  ["a 2,000-character python docstring", "python", '"""' + " x".repeat(998) + ' """\n' + "a = 1\n".repeat(45)],
])("%s that crosses range edges in a large fence gets the whole block's colors", async (_, language, code) => {
  mount(<Markdown id="m" source={"```" + language + "\n" + code + "```\n"} highlight={stateful} />);
  await act(async () => {}); // the whole block is asked for once the mounted ranges have colored
  expect(container.querySelector('[data-part="md-code-block"]')!.getAttribute("data-size")).toBe("large");
  const rows = container.querySelectorAll('[data-part="text-viewer-row"]');
  expect(rows[2]?.textContent).toContain(" x x"); // the third mounted range is still inside the construct
  const miscolored = [...container.querySelectorAll(".tok-keyword")].filter((node) => node.textContent === "x");
  expect(miscolored.length).toBe(0);
});

test("a colored cold-grammar result stays colored on the next streamed append", () => {
  let warmed = false;
  let notify: (() => void) | undefined;
  const first = "const x = 1;\n";
  const cold: Highlight = Object.assign((code: string) => warmed && code === first ? [{ text: code, type: "keyword" as const }] : [{ text: code }], {
    dispose() {},
    subscribe: (_id: string, listener: () => void) => { notify = listener; return () => {}; },
  });
  mount(<Markdown id="cold" source={"```ts\n" + first} streaming highlight={cold} />);
  expect(spans()).toBe(0);
  act(() => { warmed = true; notify!(); });
  expect(spans()).toBeGreaterThan(0);
  act(() => root!.render(<Markdown id="cold" source={"```ts\n" + first + "const y = 2;\n"} streaming highlight={cold} />));
  expect(spans()).toBeGreaterThan(0);
});

test("a streaming fence over the limits follows its newest line", () => {
  mount(<Markdown id="m" source={"```cpp\n" + line.repeat(300)} streaming highlight={highlight} />);
  expect(container.querySelector('[data-part="text-viewer-position"]')!.textContent).toBe("at bottom");
});

// Streaming answers at once; any other request (a viewer range, the whole block) stays pending, so only colors carried
// over from the inline block can show.
const streamingOnly: Highlight = Object.assign((code: string, _language: string | undefined, context?: { state?: string }) =>
  context?.state === "streaming" ? tokens(code) : new Promise<Token[]>(() => {}), { dispose() {}, subscribe: () => () => {} });

test("a streaming fence that crosses the line limit keeps its colors as it becomes the viewer", () => {
  const code = "int a = 1;\n".repeat(39);
  mount(<Markdown id="m" source={"```cpp\n" + code} streaming highlight={streamingOnly} />);
  expect(container.querySelector('[data-part="md-code-block"]')!.getAttribute("data-size")).toBe(null);
  expect(spans()).toBeGreaterThan(0);
  act(() => root!.render(<Markdown id="m" source={"```cpp\n" + code + "int b = 2;\nint c"} streaming highlight={streamingOnly} />));
  expect(container.querySelector('[data-part="md-code-block"]')!.getAttribute("data-size")).toBe("large");
  expect(container.querySelector('[data-part="text-viewer-row"] .tok-keyword')).not.toBeNull();
});

test("a fence under the line limit with more than INLINE_SPANS tokens is the viewer, colored from its own tokens", () => {
  const dense = line.repeat(35); // 35 lines of the densest code: about 1,150 tokens
  mount(<Markdown id="m" source={"```cpp\n" + dense + "```\n"} highlight={highlight} />);
  const block = container.querySelector('[data-part="md-code-block"]')!;
  expect(block.getAttribute("data-size")).toBe("large");
  expect(spans()).toBeLessThan(1_000);
  expect(block.querySelector('[data-part="text-viewer-row"] .tok-keyword')).not.toBeNull();
});

// Records what is asked for, in order, and answers when told: the order the worker would see.
function deferred() {
  const asked: Array<{ id: string; code: string; resolve: (tokens: Token[]) => void }> = [];
  const highlight: Highlight = Object.assign((code: string, _language: string | undefined, context?: { id: string }) =>
    new Promise<Token[]>((resolve) => { asked.push({ id: context!.id, code, resolve }); }), { dispose() {}, subscribe: () => () => {} });
  const answer = async (match: (id: string) => boolean, tokens: (code: string) => Token[]) => {
    for (const request of asked.filter(({ id }) => match(id))) request.resolve(tokens(request.code));
    await act(async () => {});
  };
  return { asked, highlight, answer };
}
const isWhole = (id: string) => id.endsWith(":whole");
const underCap = "int a = 1; // c\n".repeat(200); // 200 lines, 3,200 characters: the viewer, under the whole-block cap

test("a viewer under the whole-block cap asks for the whole block only after its mounted ranges colored", async () => {
  const { asked, highlight, answer } = deferred();
  mount(<Markdown id="m" source={"```cpp\n" + underCap + "```\n"} highlight={highlight} />);
  expect(container.querySelector('[data-part="md-code-block"]')!.getAttribute("data-size")).toBe("large");
  expect(asked.length).toBeGreaterThan(0);
  expect(asked.filter(({ id }) => isWhole(id))).toEqual([]); // the visible ranges go to the worker first, alone
  await answer((id) => !isWhole(id), tokens);
  expect(asked.filter(({ id }) => isWhole(id)).map(({ code }) => code)).toEqual([underCap]);
  await answer(isWhole, tokens);
  expect(container.querySelector('[data-part="text-viewer-row"] .tok-keyword')).not.toBeNull();
});

test("a viewer that unmounts or changes before its ranges colored never asks for the whole block", async () => {
  const { asked, highlight, answer } = deferred();
  mount(<Markdown id="m" source={"```cpp\n" + underCap + "```\n"} highlight={highlight} />);
  act(() => root!.render(<Markdown id="m" source={"```cpp\n" + underCap + "int b = 2;\n```\n"} highlight={highlight} />));
  act(() => root!.render(<></>));
  await answer(() => true, tokens);
  expect(asked.filter(({ id }) => isWhole(id))).toEqual([]);
});

test("a whole-block answer that is one untyped token (the highlighter's plain text) keeps the ranges' colors", async () => {
  const { highlight, answer } = deferred();
  mount(<Markdown id="m" source={"```cpp\n" + underCap + "```\n"} highlight={highlight} />);
  await answer((id) => !isWhole(id), tokens);
  await answer(isWhole, (code) => [{ text: code }]);
  expect(container.querySelector('[data-part="text-viewer-row"] .tok-keyword')).not.toBeNull();
});

test("a block over 10,000 lines (the highlighter answers it plain) keeps its ranges' colors", async () => {
  // As the controller does (packages/highlight/src/controller.ts MAX_LINES): a block over 10,000 lines is plain at once.
  const plainOver: Highlight = Object.assign((code: string) => code.split("\n").length > 10_000 ? [{ text: code }] : tokens(code), { dispose() {}, subscribe: () => () => {} });
  const short = "1,\n".repeat(10_001); // 30,003 characters
  mount(<Markdown id="m" source={"```json\n" + short + "```\n"} highlight={plainOver} />);
  await act(async () => {});
  expect(container.querySelector('[data-part="text-viewer-row"] .tok-keyword')).not.toBeNull();
});
