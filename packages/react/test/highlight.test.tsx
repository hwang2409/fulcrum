import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRunStore, type RunEvent, type ToolView } from "@fulcrum/core";
import type { Highlight, HighlightContext, Token } from "@fulcrum/highlight";
import { createRoot, type Root } from "react-dom/client";
import { RunProvider, ToolCall } from "../src/index.js";

afterAll(() => GlobalRegistrator.unregister());
let root: Root | undefined;
let container: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
});

type Call = { code: string; language: string | undefined; context?: HighlightContext };
// A synchronous stand-in for the worker highlighter: every word is a keyword, so colored text is easy to find.
function fakeHighlighter() {
  const calls: Call[] = [];
  const highlight = ((code: string, language: string | undefined, context?: HighlightContext) => {
    calls.push({ code, language, context });
    return code.split(/(\s+)/).filter(Boolean).map((text): Token => (/\s/.test(text) ? { text } : { text, type: "keyword" }));
  }) as Highlight;
  highlight.dispose = () => {};
  return { highlight, calls };
}

function render(events: RunEvent[], ids: string[], highlight?: Highlight) {
  const store = createRunStore(() => {});
  events.forEach(store.dispatch);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<RunProvider store={store} highlight={highlight}>{ids.map((id) => <ToolCall key={id} id={id} />)}</RunProvider>));
}
const done = (id: string, name: string, view: ToolView | undefined, output: string, args: Record<string, unknown> = {}): RunEvent[] => {
  const tool_call = { id, name, arguments: args };
  return [
    { type: "tool_start", tool_call, view },
    { type: "tool_end", tool_call, tool_result: { tool_call_id: id, content: output, is_error: false } },
  ];
};
const q = (selector: string) => container.querySelector(selector) as HTMLElement;
const languages = (calls: Call[], id: string) => [...new Set(calls.filter((call) => call.context?.id.startsWith(`tool:${id}:`)).map((call) => call.language))];

test("each card asks for the language its content structurally has", () => {
  const { highlight, calls } = fakeHighlighter();
  render([
    ...done("sh", "bash", { kind: "shell", command: "cat <<'EOF'\nhi\nEOF" }, "plain words\n"),
    ...done("py", "read", { kind: "read", path: "tools/run.py" }, "def main():\n    pass\n"),
    ...done("mk", "read", { kind: "read", path: "Makefile" }, "all:\n\tbun test\n"),
    ...done("wr", "write", { kind: "write", path: "web/app.tsx", content: "export const A = 1;\n" }, "wrote"),
    ...done("fj", "fetch", { kind: "fetch", url: "https://api.example.com/v1/runs", status: 200, contentType: "application/json; charset=utf-8" }, '{"ok":true}'),
    ...done("fh", "fetch", { kind: "fetch", url: "https://example.com/", status: 200, contentType: "text/html" }, "<p>hi</p>"),
    ...done("ge", "custom", undefined, '[{"id":1}]', { id: 1 }),
    ...done("txt", "custom", undefined, "not json: {\"a\":1}"),
  ], ["tool:sh", "tool:py", "tool:mk", "tool:wr", "tool:fj", "tool:fh", "tool:ge", "tool:txt"], highlight);
  expect(languages(calls, "sh")).toEqual(["shell", undefined].filter(Boolean) as string[]);
  expect(languages(calls, "py")).toEqual(["python"]);
  expect(languages(calls, "mk")).toEqual(["makefile"]);
  expect(languages(calls, "wr")).toEqual(["tsx"]);
  expect(languages(calls, "fj")).toEqual(["json"]);
  expect(languages(calls, "fh")).toEqual(["html"]);
  expect(languages(calls, "ge")).toEqual(["json"]);
  expect(languages(calls, "txt")).toEqual([]);
  // The shell command is highlighted in the header; compact JSON from a server is indented for reading.
  expect(q('[data-id="tool:sh"] [data-part="tool-summary"] .tok-keyword')).not.toBeNull();
  expect(q('[data-id="tool:fj"] [data-part="tool-output"]').textContent).toBe('{\n  "ok": true\n}');
  expect(q('[data-id="tool:py"] [data-part="line-text"] .tok-keyword')!.textContent).toBe("def");
});

test("with no highlighter every card renders the same text, plain", () => {
  render(done("py", "read", { kind: "read", path: "tools/run.py" }, "def main():\n    pass\n"), ["tool:py"]);
  expect(q('[data-part="tool-lines"]').textContent).toBe("1def main():2    pass");
  expect(container.querySelector(".tok-keyword")).toBeNull();
});

test("shell output renders ANSI colors as themed spans and copies plain text", async () => {
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } });
  render(done("ansi", "bash", { kind: "shell", command: "bun run build" }, "\x1b[1m\x1b[31merror\x1b[39m\x1b[22m: failed\n\x1b[2K\x1b[32mok\x1b[0m\n"), ["tool:ansi"]);
  const output = q('[data-part="tool-output"]');
  expect(output.textContent).toBe("error: failed\nok\n");
  expect(output.querySelector(".ansi-red.ansi-bold")!.textContent).toBe("error");
  expect(output.querySelector(".ansi-green")!.textContent).toBe("ok");
  await act(async () => (container.querySelectorAll<HTMLButtonElement>('[data-action="copy"]')[1]!).click());
  expect(copied).toEqual(["error: failed\nok\n"]);
});

test("edit highlights by the file's language and keeps the changed span marked", () => {
  const { highlight, calls } = fakeHighlighter();
  render(done("ed", "edit", { kind: "edit", path: "src/store.ts", diff: "@@ -1,2 +1,2 @@\n const a = 1;\n-let count = 1;\n+let count = 2;\n" }, "ok"), ["tool:ed"], highlight);
  expect(languages(calls, "ed")).toEqual(["typescript"]);
  const insert = q('[data-part="diff-line"][data-change="insert"]');
  expect(insert.querySelector('[data-part="diff-text"]')!.textContent).toBe("let count = 2;");
  expect(insert.querySelector('mark[data-part="diff-word"]')!.textContent).toBe("2");
  expect(insert.querySelector(".tok-keyword")).not.toBeNull();
});

test("search highlights each file by its language and marks the match", () => {
  const { highlight, calls } = fakeHighlighter();
  render(done("se", "grep", { kind: "search", pattern: "TODO|FIXME" }, "src/a.ts:3:  // TODO: cap\ndocs/b.md:9:FIXME later\n"), ["tool:se"], highlight);
  expect(calls.filter((call) => call.context?.id.startsWith("tool:se:file")).map((call) => call.language)).toEqual(["typescript", "markdown"]);
  expect([...container.querySelectorAll('mark[data-part="search-match"]')].map((mark) => mark.textContent)).toEqual(["TODO", "FIXME"]);
  expect(q('[data-part="search-total"]').textContent).toBe("2 matches in 2 files");
});

test("the large viewer highlights only its mounted rows, never the whole text", () => {
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 320 });
  const { highlight, calls } = fakeHighlighter();
  const line = "export const value = 1; // padding padding padding padding\n";
  const text = line.repeat(Math.ceil(2_000_000 / line.length));
  render(done("big", "read", { kind: "read", path: "src/big.ts" }, text), ["tool:big"], highlight);
  expect(calls.reduce((sum, call) => sum + call.code.length, 0)).toBeLessThan(100_000); // the preview: head and tail only
  const start = calls.length;
  act(() => q('[data-action="open-viewer"]').click());
  const viewerCalls = calls.slice(start);
  const highlighted = viewerCalls.reduce((sum, call) => sum + call.code.length, 0);
  const rows = container.querySelectorAll('[data-part="text-viewer-row"]').length;
  expect(rows).toBeGreaterThan(0);
  expect(highlighted).toBeLessThanOrEqual(rows * 2_000);
  expect(highlighted).toBeLessThan(text.length / 4);
  expect(viewerCalls.every((call) => call.code.length <= 2_000)).toBe(true);
  expect(q('[data-part="text-viewer-head"]').textContent).toContain(`${(text.length / line.length).toLocaleString("en-US")} lines`);
  if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
});
