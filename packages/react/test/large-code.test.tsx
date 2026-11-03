import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRunStore, type RunEvent, type ToolView } from "@fulcrum/core";
import type { Highlight, Token } from "@fulcrum/highlight";
import { Markdown } from "../../markdown/src/react.js";
import { RunProvider, ToolCall } from "../src/index.js";

// happy-dom does no layout: a viewer's scroll box is as tall as styles.css makes it, so its visible rows mount.
const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight")!;
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get(this: HTMLElement) { return this.dataset.part === "text-viewer" ? 320 : 0; } });
afterAll(() => { Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight); GlobalRegistrator.unregister(); });
let root: Root | undefined;
let container: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
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
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } });
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
  const code = line.repeat(199);
  mount(<Markdown id="m" source={"```cpp\n" + code + "```\n"} highlight={highlight} />);
  expect(container.querySelector('[data-part="text-viewer"]')).toBeNull();
  expect(container.querySelector("pre[data-part=md-code-block] > code")!.textContent).toBe(code);
});

// A stand-in grammar with state that spans lines: a /* */ comment and a """ """ docstring color everything inside them.
const stateful: Highlight = Object.assign((code: string) => code.match(/\/\*[\s\S]*?(?:\*\/|$)|"""[\s\S]*?(?:"""|$)|\w+|\W/g)!.map((text): Token =>
  text.startsWith("/*") ? { text, type: "comment" } : text.startsWith('"""') ? { text, type: "string" } : /\w/.test(text) ? { text, type: "keyword" } : { text }), { dispose() {}, subscribe: () => () => {} });

test.each([
  // A 2,000-character construct crosses three range edges; one long line after it puts the fence over INLINE_CHARS.
  ["a 2,000-character block comment", "cpp", "/*" + " x".repeat(998) + " */\n" + "int a; ".repeat(1_500) + "\n"],
  ["a 2,000-character python docstring", "python", '"""' + " x".repeat(998) + ' """\n' + "a = 1; ".repeat(1_500) + "\n"],
])("%s that crosses range edges in a large fence gets the whole block's colors", (_, language, code) => {
  mount(<Markdown id="m" source={"```" + language + "\n" + code + "```\n"} highlight={stateful} />);
  expect(container.querySelector('[data-part="md-code-block"]')!.getAttribute("data-size")).toBe("large");
  const rows = container.querySelectorAll('[data-part="text-viewer-row"]');
  expect(rows[2]?.textContent).toContain(" x x"); // the third mounted range is still inside the construct
  const miscolored = [...container.querySelectorAll(".tok-keyword")].filter((node) => node.textContent === "x");
  expect(miscolored.length).toBe(0);
});
