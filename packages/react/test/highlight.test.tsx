import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { shimProperty } from "../../../test-support/dom-shim.js";
import { act } from "react";
import { createRunStore, type RunEvent, type ToolView } from "@fulcrum/core";
import type { Highlight, HighlightContext, Token } from "@fulcrum/highlight";
import { createRoot, type Root } from "react-dom/client";
import { Code, HighlightContext as HighlightProvider, RunProvider, ToolCall } from "../src/index.js";

afterAll(() => GlobalRegistrator.unregister());
let root: Root | undefined;
let container: HTMLElement;
const restoreShims: Array<() => void> = [];
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  restoreShims.splice(0).reverse().forEach((restore) => restore());
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
  highlight.subscribe = () => () => {};
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
    ...done("fo", "fetch", { kind: "fetch", url: "https://example.test/src/app.ts?raw=1", status: 200, contentType: "application/octet-stream" }, "const a = 1;\n"),
    ...done("ge", "custom", undefined, '[{"id":1}]', { id: 1 }),
    ...done("txt", "custom", undefined, "not json: {\"a\":1}"),
  ], ["tool:sh", "tool:py", "tool:mk", "tool:wr", "tool:fj", "tool:fh", "tool:fo", "tool:ge", "tool:txt"], highlight);
  expect(languages(calls, "sh")).toEqual(["shell", undefined].filter(Boolean) as string[]);
  expect(languages(calls, "py")).toEqual(["python"]);
  expect(languages(calls, "mk")).toEqual(["makefile"]);
  expect(languages(calls, "wr")).toEqual(["tsx"]);
  expect(languages(calls, "fj")).toEqual(["json"]);
  expect(languages(calls, "fh")).toEqual(["html"]);
  // A content type with no language falls back to the url's extension.
  expect(languages(calls, "fo")).toEqual(["typescript"]);
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

test("collapsed output does no JSON or highlight work in its first render", () => {
  const output = JSON.stringify({ value: "x".repeat(2_000) });
  const { highlight, calls } = fakeHighlighter();
  const parse = JSON.parse;
  let parses = 0;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => { parses++; return parse(...args); }) as typeof JSON.parse;
  try {
    render(done("lazy", "custom", undefined, output), ["tool:lazy"], highlight);
    const card = q('[data-id="tool:lazy"]') as HTMLDetailsElement;
    expect(card.open).toBe(false);
    expect(card.querySelector('[data-part="tool-body"]')).toBeNull();
    expect(parses).toBe(0);
    expect(calls).toHaveLength(0);
    act(() => {
      card.open = true;
      card.dispatchEvent(new Event("toggle"));
    });
    expect(parses).toBe(1);
    expect(calls).toHaveLength(1);
  } finally {
    JSON.parse = parse;
  }
});

test("shell output renders ANSI colors as themed spans and copies plain text", async () => {
  const copied: string[] = [];
  restoreShims.push(shimProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } }));
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
  restoreShims.push(shimProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 320 }));
  const { highlight, calls } = fakeHighlighter();
  const line = "export const value = 1; // padding padding padding padding\n";
  const text = line.repeat(Math.ceil(2_000_000 / line.length));
  render(done("big", "read", { kind: "read", path: "src/big.ts" }, text), ["tool:big"], highlight);
  expect(calls).toHaveLength(0);
  openCard();
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
});

function openCard() {
  const card = q('[data-part="tool"]') as HTMLDetailsElement;
  if (card.open) return;
  act(() => {
    card.open = true;
    card.dispatchEvent(new Event("toggle"));
  });
}

// Opens the large viewer of the rendered card with a 320 px viewport.
function openViewer() {
  const restoreClientHeight = shimProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 320 });
  openCard();
  act(() => q('[data-action="open-viewer"]').click());
  restoreClientHeight();
  return q('[data-part="text-viewer"]');
}

test("a large edit keeps its language, row kinds, and changed spans in the preview and the viewer", () => {
  const { highlight, calls } = fakeHighlighter();
  const hunks = Array.from({ length: 2_000 }, (_, i) => `@@ -${i * 3 + 1},2 +${i * 3 + 1},2 @@\n const a${i} = 1;\n-let count = ${i};\n+let count = ${i + 1};\n`).join("");
  render(done("bigedit", "edit", { kind: "edit", path: "src/store.ts", diff: hunks }, "ok"), ["tool:bigedit"], highlight);
  for (const scope of [q('[data-id="tool:bigedit"]'), openViewer()]) {
    expect(scope.querySelector('[data-part="diff-line"][data-change="insert"] [data-part="diff-text"] .tok-keyword')).not.toBeNull();
    expect(scope.querySelector('[data-part="diff-line"][data-change="delete"] mark[data-part="diff-word"]')).not.toBeNull();
    expect(scope.querySelector('[data-part="diff-line"][data-change="insert"] mark[data-part="diff-word"]')).not.toBeNull();
  }
  expect(languages(calls, "bigedit")).toEqual(["typescript"]);
  // Only mounted rows are highlighted.
  expect(calls.reduce((sum, call) => sum + call.code.length, 0)).toBeLessThan(hunks.length / 4);
});

test("a large search keeps each file's language, its heads, and the match marks in the preview and the viewer", () => {
  const { highlight, calls } = fakeHighlighter();
  const lines = Array.from({ length: 4_000 }, (_, i) => (i % 2 ? `docs/n${i >> 4}.md:${i}:FIXME later ${i}` : `src/f${i >> 4}.ts:${i}:  // TODO: cap ${i}`)).join("\n");
  render(done("bigsearch", "grep", { kind: "search", pattern: "TODO|FIXME" }, lines), ["tool:bigsearch"], highlight);
  for (const scope of [q('[data-id="tool:bigsearch"]'), openViewer()]) {
    expect(scope.querySelector('[data-part="search-head"] [data-part="search-path"]')).not.toBeNull();
    expect(scope.querySelector('[data-part="line-text"] .tok-keyword')).not.toBeNull();
    expect([...scope.querySelectorAll('mark[data-part="search-match"]')].slice(0, 2).map((mark) => mark.textContent)).toEqual(["TODO", "FIXME"]);
  }
  expect(languages(calls, "bigsearch")).toEqual(["typescript", "markdown"]);
  expect(calls.reduce((sum, call) => sum + call.code.length, 0)).toBeLessThan(lines.length / 4);
  expect(q('[data-part="search-total"]').textContent).toBe("4000 matches in 4000 files");
});

test("segmenting a 2M-character line with no newline stays linear", async () => {
  const { segmentText } = await import("../src/tools/text-viewer.js");
  const text = "x".repeat(2_000_000);
  // Counted, not timed: each segment scans back at most half a segment for a newline, so the text is read at most once.
  // lastIndexOf has no lower bound, so it would rescan the whole text per segment.
  const original = { charCodeAt: String.prototype.charCodeAt, lastIndexOf: String.prototype.lastIndexOf };
  const calls = { charCodeAt: 0, lastIndexOf: 0 };
  const restoreCharCodeAt = shimProperty(String.prototype, "charCodeAt", {
    ...Object.getOwnPropertyDescriptor(String.prototype, "charCodeAt"),
    value: function (this: string, index: number) { calls.charCodeAt++; return original.charCodeAt.call(this, index); },
  });
  const restoreLastIndexOf = shimProperty(String.prototype, "lastIndexOf", {
    ...Object.getOwnPropertyDescriptor(String.prototype, "lastIndexOf"),
    value: function (this: string, ...args: [string, number?]) { calls.lastIndexOf++; return original.lastIndexOf.apply(this, args); },
  });
  let segments;
  try { segments = segmentText(text, 1); } finally { restoreLastIndexOf(); restoreCharCodeAt(); }
  expect(segments).toHaveLength(1_000);
  expect(calls.charCodeAt).toBeLessThanOrEqual(text.length);
  expect(calls.lastIndexOf).toBe(0);
});

// Every view kind, small and large, collapsed when it mounts.
const lines = (count: number, line: (i: number) => string) => Array.from({ length: count }, (_, i) => `${line(i)}\n`).join("");
const warmFixtures: Array<[string, RunEvent[]]> = [
  ["shell ansi", done("w-sh", "bash", { kind: "shell", command: "bun test" }, lines(20, (i) => `\x1b[32mpass\x1b[0m test ${i}`))],
  ["shell split, long command", done("w-split", "bash", { kind: "shell", command: `rg ${"x".repeat(80)}`, stdout: lines(30, (i) => `out ${i}`), stderr: lines(12, (i) => `err ${i}`) }, "")],
  ["shell huge", done("w-huge", "bash", { kind: "shell", command: "seq" }, lines(5_000, (i) => `line ${i}`))],
  ["read", done("w-read", "read", { kind: "read", path: "src/a.ts" }, lines(30, (i) => `const a${i} = ${i};`))],
  ["read large", done("w-big", "read", { kind: "read", path: "src/b.ts" }, lines(400, (i) => `export const b${i} = ${i};`))],
  ["write", done("w-write", "write", { kind: "write", path: "src/c.py", content: lines(20, (i) => `x${i} = ${i}`) }, "")],
  ["edit", done("w-edit", "edit", { kind: "edit", path: "src/d.ts", diff: "@@ -1,2 +1,2 @@\n const a = 1;\n-let n = 1;\n+let n = 2;\n" }, "")],
  ["edit large", done("w-bigedit", "edit", { kind: "edit", path: "src/e.ts", diff: lines(200, (i) => `@@ -${i * 3 + 1},2 +${i * 3 + 1},2 @@\n const a${i} = 1;\n-let n = ${i};\n+let n = ${i + 1};`) }, "")],
  ["search", done("w-grep", "grep", { kind: "search", pattern: "TODO" }, lines(20, (i) => (i % 2 ? `docs/n.md:${i}:TODO ${i}` : `src/f.ts:${i}:  // TODO ${i}`)))],
  ["search large", done("w-biggrep", "grep", { kind: "search", pattern: "TODO" }, lines(300, (i) => `src/f${i >> 3}.ts:${i}:// TODO ${i}`))],
  ["search, not grep output", done("w-plaingrep", "grep", { kind: "search", pattern: "TODO" }, lines(20, (i) => `no match format ${i}`))],
  ["fetch json", done("w-fetch", "fetch", { kind: "fetch", url: "https://api.example.com/runs", contentType: "application/json" }, JSON.stringify({ runs: Array.from({ length: 200 }, (_, i) => ({ id: i })) }))],
  ["fetch html", done("w-html", "fetch", { kind: "fetch", url: "https://example.com/" , contentType: "text/html" }, lines(20, (i) => `<p>${i}</p>`))],
  ["generic json", done("w-gen", "custom", undefined, JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ id: i })) }))],
];
const blockKey = (call: Call) => JSON.stringify([call.code, call.language, call.context]);

test("idle warming asks for exactly the blocks the body asks for when it opens", async () => {
  const { highlight, calls } = fakeHighlighter();
  const body = (call: Call) => !call.context?.id.endsWith(":summary");
  render(warmFixtures.flatMap(([, events]) => events), warmFixtures.map(([, events]) => `tool:${(events[0] as { tool_call: { id: string } }).tool_call.id}`), highlight);
  const cards = [...container.querySelectorAll<HTMLDetailsElement>('[data-part="tool"]')];
  expect(cards.map((card) => card.open)).toEqual(warmFixtures.map(() => false));
  expect(calls.filter(body)).toHaveLength(0);
  await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
  const warmed = calls.filter(body).map(blockKey);
  calls.length = 0;
  const plain: string[] = [];
  for (const card of cards) act(() => {
    card.open = true;
    card.dispatchEvent(new Event("toggle"));
  });
  for (const [name, events] of warmFixtures) {
    const id = (events[0] as { tool_call: { id: string } }).tool_call.id;
    const of = (keys: string[]) => keys.filter((key) => key.includes(`"tool:${id}:`)).sort();
    const opened = of(calls.filter(body).map(blockKey));
    expect({ name, blocks: of(warmed) }).toEqual({ name, blocks: opened });
    if (opened.length === 0) plain.push(name);
  }
  // ANSI colors and plain text have no language, so they ask for no highlighting.
  expect(plain).toEqual(["shell ansi", "shell huge", "search, not grep output"]);
});

test("hover warms a collapsed body at once, and only once per revision", () => {
  const { highlight, calls } = fakeHighlighter();
  render(warmFixtures[3]![1], ["tool:w-read"], highlight);
  const summary = q('[data-id="tool:w-read"] > summary');
  expect(calls.filter((call) => call.context?.id === "tool:w-read:content")).toHaveLength(0);
  act(() => summary.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
  act(() => summary.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
  expect(calls.filter((call) => call.context?.id === "tool:w-read:content")).toHaveLength(1);
  expect(q('[data-id="tool:w-read"] [data-part="tool-body"]')).toBeNull();
});

test("two different same-length sources on one surface never show the first source's tokens", async () => {
  const { useTokens } = await import("../src/highlight.js");
  const { HighlightContext } = await import("../src/highlight.js");
  // A caching highlighter keyed by (id, version, language) only, like the real controller's cache key.
  const cache = new Map<string, Token[]>();
  const highlight = ((code: string, language: string | undefined, context?: HighlightContext) => {
    const key = `${context?.id}\0${context?.version}\0${language}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const tokens: Token[] = [{ text: code, type: "keyword" }];
    cache.set(key, tokens);
    return tokens;
  }) as Highlight;
  highlight.dispose = () => {};
  highlight.subscribe = () => () => {};
  const seen: string[] = [];
  function Probe({ code }: { code: string }) {
    const tokens = useTokens(code, "typescript", "surface:1");
    seen.push(tokens ? tokens.map((token) => token.text).join("") : code);
    return null;
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<HighlightContext.Provider value={highlight}><Probe code="let a = 1;" /></HighlightContext.Provider>));
  act(() => root!.render(<HighlightContext.Provider value={highlight}><Probe code="var b = 2;" /></HighlightContext.Provider>));
  expect(seen.at(-1)).toBe("var b = 2;");
});

// A highlighter whose block can be updated later, as the worker does once a cold grammar is warm.
function updatableHighlighter(first: Token[]) {
  let tokens = first;
  const listeners = new Map<string, Set<() => void>>();
  const highlight = (() => tokens) as unknown as Highlight;
  highlight.dispose = () => {};
  highlight.subscribe = (id, listener) => {
    const set = listeners.get(id) ?? new Set();
    listeners.set(id, set.add(listener));
    return () => set.delete(listener);
  };
  return { highlight, update: (id: string, next: Token[]) => { tokens = next; for (const listener of listeners.get(id) ?? []) listener(); } };
}

test("useTokens repaints a block when the highlighter updates it, with the same text", async () => {
  const { useTokens, Tokens, HighlightContext: Provider } = await import("../src/highlight.js");
  const code = "const a = 1;\nlet b = 2;\n";
  const { highlight, update } = updatableHighlighter([{ text: code }]);
  function Probe() {
    const tokens = useTokens(code, "typescript", "surface:update");
    return <pre>{tokens ? <Tokens tokens={tokens} /> : code}</pre>;
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<Provider.Provider value={highlight}><Probe /></Provider.Provider>));
  expect(container.querySelectorAll("[class^=tok-]")).toHaveLength(0);
  act(() => update("surface:other", [{ text: code, type: "string" }]));
  expect(container.querySelectorAll("[class^=tok-]")).toHaveLength(0);
  act(() => update("surface:update", [{ text: "const", type: "keyword" }, { text: " a = 1;\n" }, { text: "let", type: "keyword" }, { text: " b = 2;\n" }]));
  expect([...container.querySelectorAll(".tok-keyword")].map((node) => node.textContent)).toEqual(["const", "let"]);
  expect(container.textContent).toBe(code);
});

test("a multi-line command is tokenized as written, then joined onto the header's one line", () => {
  // A stand-in shell grammar: a "#" starts a comment that runs to the end of its line.
  const highlight = ((code: string) => code.split(/(\n)/).flatMap((line): Token[] => {
    if (line === "\n") return [{ text: line }];
    const at = line.indexOf("#");
    return at === -1 ? (line ? [{ text: line, type: "keyword" }] : []) : [...(at ? [{ text: line.slice(0, at), type: "keyword" as const }] : []), { text: line.slice(at), type: "comment" }];
  })) as Highlight;
  highlight.dispose = () => {};
  highlight.subscribe = () => () => {};
  const command = "cat > release.sh <<'EOF'\n#!/usr/bin/env bash\nset -euo pipefail\nEOF";
  render([{ type: "tool_start", tool_call: { id: "h", name: "bash", arguments: { command } }, view: { kind: "shell", command } }], ["tool:h"], highlight);
  const summary = q('[data-id="tool:h"] [data-part="tool-summary"]');
  expect(summary.textContent).toBe("$ cat > release.sh <<'EOF' #!/usr/bin/env bash set -euo pipefail EOF");
  expect([...summary.querySelectorAll(".tok-comment")].map((node) => node.textContent)).toEqual(["#!/usr/bin/env bash"]);
});

test("a block whose done colors are pending keeps its streaming colors: no blink to plain at close", () => {
  const pendingDone = ((code: string, _language: string | undefined, context?: HighlightContext) =>
    context?.state === "done" ? new Promise<Token[]>(() => {}) : [{ text: code, type: "keyword" }]) as Highlight;
  pendingDone.dispose = () => {};
  pendingDone.subscribe = () => () => {};
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<HighlightProvider.Provider value={pendingDone}><Code text="let a = 1;" language="ts" id="c" done={false} /></HighlightProvider.Provider>));
  expect(container.querySelector(".tok-keyword")).not.toBeNull();
  act(() => root!.render(<HighlightProvider.Provider value={pendingDone}><Code text="let a = 1;" language="ts" id="c" /></HighlightProvider.Provider>));
  expect(container.querySelector(".tok-keyword")?.textContent).toBe("let a = 1;");
});
