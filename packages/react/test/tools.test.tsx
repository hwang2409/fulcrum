import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { shimProperty } from "../../../test-support/dom-shim.js";
import { readFileSync } from "node:fs";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRunStore, type ApprovalDecision, type RunEvent, type ToolView } from "@fulcrum/core";
import { Approval, deliveryNoteText, Fallback, RunProvider, Timeline, ToolCall, useItem, type Renderers } from "../src/index.js";
import { boundLines } from "../src/tools/common.js";
import { segmentText } from "../src/tools/text-viewer.js";

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

function mount(node: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

type End = { content?: string; is_error?: boolean; is_canceled?: boolean } | false;
const tool = (id: string, name: string, view: ToolView | undefined, output = "", end: End = {}): RunEvent[] => {
  const tool_call = { id, name, arguments: { path: "src/a.ts", extra: true } };
  return [
    { type: "tool_start", tool_call, view },
    ...(output ? [{ type: "tool_output", tool_call, output } as RunEvent] : []),
    ...(end ? [{ type: "tool_end", tool_call, tool_result: { tool_call_id: id, content: end.content ?? output, is_error: end.is_error ?? false, is_canceled: end.is_canceled } } as RunEvent] : []),
  ];
};

function render(events: RunEvent[], ids: string[]) {
  const store = createRunStore(() => {});
  events.forEach(store.dispatch);
  mount(<RunProvider store={store}>{ids.map((id) => id.startsWith("approval:") ? <Approval key={id} id={id} onApprove={() => {}} /> : <ToolCall key={id} id={id} />)}</RunProvider>);
}
const q = (selector: string) => container.querySelector(selector) as HTMLElement;
const all = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)].map((el) => el.textContent);
const openCard = (id: string) => {
  const card = q(`[data-id="${id}"]`) as HTMLDetailsElement;
  if (card.open) return;
  act(() => {
    card.open = true;
    card.dispatchEvent(new Event("toggle"));
  });
};

const views: ToolView[] = [
  { kind: "shell", command: "bun test" },
  { kind: "read", path: "src/a.ts", range: { offset: 10, limit: 20 } },
  { kind: "edit", path: "src/a.ts", diff: "@@ -1 +1 @@\n-old\n+new" },
  { kind: "write", path: "src/a.ts", content: "x\n" },
  { kind: "search", pattern: "TODO", path: "src" },
  { kind: "fetch", url: "https://example.com", status: 200 },
];

test("every view renders only its body inside the one shared header", () => {
  render(views.flatMap((view, i) => tool(`v${i}`, view.kind, view, "line one\nline two")), views.map((_, i) => `tool:v${i}`));
  for (const [i, view] of views.entries()) {
    const card = q(`[data-id="tool:v${i}"]`);
    expect(card.getAttribute("data-tool-view")).toBe(view.kind);
    expect(card.querySelectorAll('[data-part="tool-header"]')).toHaveLength(1);
    expect(card.querySelector("header, section, footer header")).toBeNull();
    expect(card.querySelector('[data-part="tool-body"] [data-part="tool-name"], [data-part="tool-body"] [data-part="tool-status"]')).toBeNull();
  }
});

test("shell shows output, then stderr apart, then the exit code", () => {
  const view: ToolView = { kind: "shell", command: "bun test", exitCode: 1, stdout: "1 pass\n", stderr: "1 fail\n" };
  render(tool("s", "bash", view, "1 pass\n1 fail\n", { content: "stdout:\n1 pass\n\nstderr:\n1 fail\n", is_error: true }), ["tool:s"]);
  expect(q('[data-part="tool-output"]:not([data-stream])').textContent).toBe("1 pass\n");
  expect(q('[data-part="tool-output"][data-stream="stderr"]').textContent).toBe("1 fail\n");
  expect(q('[data-part="tool-exit"]').textContent).toBe("exit 1");
  expect(q('[data-part="tool-exit"]').getAttribute("data-exit-code")).toBe("1");
  expect(container.textContent).not.toContain("stdout:");
});

test("shell with only streamed output shows it; empty output says so in words", () => {
  render([
    ...tool("a", "bash", { kind: "shell", command: "ls" }, "README.md\n"),
    ...tool("b", "bash", { kind: "shell", command: "true", exitCode: 0 }),
    ...tool("c", "bash", { kind: "shell", command: "sleep 9" }, "", false),
  ], ["tool:a", "tool:b", "tool:c"]);
  openCard("tool:b");
  expect(q('[data-id="tool:a"] [data-part="tool-output"]').textContent).toBe("README.md\n");
  expect(q('[data-id="tool:b"] [data-part="tool-empty"]').textContent).toBe("no output");
  expect(q('[data-id="tool:b"] [data-part="tool-exit"]').textContent).toBe("exit 0");
  expect(q('[data-id="tool:c"] [data-part="tool-empty"]').textContent).toBe("waiting for output");
});

test("read numbers lines from the range start", () => {
  render(tool("r", "read", { kind: "read", path: "src/a.ts", range: { offset: 10, limit: 2 } }, "const a = 1;\nconst b = 2;\n"), ["tool:r"]);
  expect(all('[data-part="line-number"]')).toEqual(["11", "12"]);
  expect(all('[data-part="line-text"]')).toEqual(["const a = 1;", "const b = 2;"]);
  act(() => root!.unmount());
  root = undefined;
  render(tool("rc", "read", { kind: "read", path: "src/a.ts" }, "", { content: "canceled by user", is_canceled: true }), ["tool:rc"]);
  expect(container.querySelector('[data-part="line-number"]')).toBeNull();
  expect(q('[data-part="tool-output"]').textContent).toBe("canceled by user");
});

test("edit renders a unified diff with gutters, line numbers, and changed words", () => {
  const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -10,3 +10,3 @@\n keep\n-const limit = 10;\n+const limit = 20;\n end";
  render(tool("e", "edit", { kind: "edit", path: "a.ts", diff }), ["tool:e"]);
  openCard("tool:e");
  const rows = [...container.querySelectorAll('[data-part="diff-line"]')].map((row) => [
    row.getAttribute("data-change"),
    ...[...row.querySelectorAll('[data-part="diff-gutter"]')].map((cell) => cell.textContent),
    row.querySelector('[data-part="diff-text"]')!.textContent,
  ]);
  expect(rows).toEqual([
    ["hunk", "", "", "@@ -10,3 +10,3 @@"],
    ["context", "10", "10", "keep"],
    ["delete", "11", "", "const limit = 10;"],
    ["insert", "", "11", "const limit = 20;"],
    ["context", "12", "12", "end"],
  ]);
  expect(all('[data-part="diff-word"]')).toEqual(["1", "2"]);
  expect(container.textContent).not.toContain("+++");
  act(() => root!.unmount());
  root = undefined;
  render(tool("ending", "edit", { kind: "edit", path: "a.ts", diff: "\\ Line endings changed from CRLF to LF" }), ["tool:ending"]);
  openCard("tool:ending");
  expect(q('[data-change="notice"] [data-part="diff-text"]').textContent).toBe("Line endings changed from CRLF to LF");
});

test("search groups grep-style matches by file", () => {
  const output = "src/a.ts:3:// TODO one\nsrc/a.ts:9:// TODO two\nsrc/b.ts:1:// TODO three\n";
  render(tool("g", "grep", { kind: "search", pattern: "TODO", path: "src" }, output), ["tool:g"]);
  expect(all('[data-part="search-file"] [data-part="search-path"]')).toEqual(["src/a.ts", "src/b.ts"]);
  expect(all('[data-part="search-count"]')).toEqual(["2", "1"]);
  expect(all('[data-part="line-number"]')).toEqual(["3", "9", "1"]);
  expect(all('[data-part="line-text"]')).toEqual(["// TODO one", "// TODO two", "// TODO three"]);
});

test("fetch shows the status, the full url, and the body", () => {
  render(tool("f", "fetch", { kind: "fetch", url: "https://example.com/a", status: 404, title: "Not found" }, "<html>gone</html>"), ["tool:f"]);
  expect(q('[data-part="fetch-status"]').textContent).toBe("HTTP 404");
  expect(q('[data-part="fetch-url"]').textContent).toBe("https://example.com/a");
  expect(q('[data-part="tool-output"]').textContent).toBe("<html>gone</html>");
});

test("copy buttons copy the command, the path, and the full output", async () => {
  const copied: string[] = [];
  restoreShims.push(shimProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } }));
  const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  render([
    ...tool("c1", "bash", { kind: "shell", command: "ls -la" }, long),
    ...tool("c2", "read", { kind: "read", path: "src/a.ts" }, "x"),
  ], ["tool:c1", "tool:c2"]);
  openCard("tool:c1");
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('[data-action="copy"]')];
  expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["copy command", "copy output", "copy path", "copy output"]);
  for (const button of buttons) await act(async () => button.click());
  expect(copied).toEqual(["ls -la", long, "src/a.ts", "x"]);
  expect(buttons[0]!.textContent).toBe("copied");
});

test("large output opens in the shared bounded viewer", () => {
  const output = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
  render(tool("large", "bash", { kind: "shell", command: "log" }, output), ["tool:large"]);
  openCard("tool:large");
  const preview = () => q('[data-part="tool-output"]').textContent!;
  expect(preview()).toContain("line 0\n");
  expect(preview()).toContain("line 499");
  expect(preview()).toContain("… 439 more lines of 500 …");
  expect(preview()).not.toContain("line 250");
  const button = q('[data-action="open-viewer"]') as HTMLButtonElement;
  expect(button.textContent).toBe("open all 500 lines / 4,389 characters");
  act(() => button.click());
  const viewer = q('[data-part="text-viewer"]');
  expect(viewer.getAttribute("role")).toBe("region");
  expect(viewer.getAttribute("aria-label")).toBe("output viewer");
  expect(viewer.getAttribute("tabindex")).toBe("0");
  expect(q('[data-action="show-more"]')).toBeNull();
});

test("giant lines split into grapheme-safe fixed-size viewer rows", () => {
  const text = `${"x".repeat(1_999)}e\u0301${"y".repeat(1_997)}👩🏽‍💻${"z".repeat(2_001)}`;
  const segments = segmentText(text, 1);
  const values = segments.map((segment, index) => text.slice(segment.start, segments[index + 1]?.start));
  const boundaries = new Set([0, ...[...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(({ index }) => index), text.length]);
  expect(values.every((value) => value.length <= 2_000)).toBe(true);
  expect(values.join("")).toBe(text);
  expect(segments.every(({ start }) => boundaries.has(start))).toBe(true);
  expect(segmentText(`${"x".repeat(1_999)}\r\n${"y".repeat(2_000)}`, 2)[1]!.start).toBe(1_999);
});

test("tool names use one bounded label in calls and approvals", () => {
  const name = `tool-${"x".repeat(2_000_000)}`;
  const call = { id: "named", name, arguments: {} };
  render([
    { type: "tool_start", tool_call: call },
    { type: "approval_request", request_id: "named", tool_call: { ...call, id: "approval" }, delegated: false },
  ], ["tool:named", "approval:named"]);
  const cards = [...container.querySelectorAll<HTMLElement>('[data-part="tool"], [data-part="approval"]')];
  expect(cards).toHaveLength(2);
  for (const card of cards) {
    const label = card.querySelector<HTMLElement>('[data-part="tool-name"]')!;
    expect(label.textContent!.length).toBeLessThanOrEqual(240);
    // The hover title shows more of a cut name, but never the multi-megabyte raw value.
    expect(label.title.startsWith("tool-xxx")).toBe(true);
    expect(label.title.length).toBeLessThanOrEqual(1_000);
    expect(card.dataset.tool!.length).toBeLessThanOrEqual(240);
    expect(card.outerHTML.length).toBeLessThan(20_000);
  }
});

test("a short tool name has no redundant title", () => {
  render([{ type: "tool_start", tool_call: { id: "short", name: "bash", arguments: {} } }], ["tool:short"]);
  const label = container.querySelector<HTMLElement>('[data-part="tool-name"]')!;
  expect(label.textContent).toBe("bash");
  expect(label.hasAttribute("title")).toBe(false);
});

test("the compact line preview stays bounded", () => {
  const window = boundLines(Array.from({ length: 1_000_000 }, () => "x"));
  expect(window.head.length + window.tail.length).toBeLessThanOrEqual(60);
  expect(window.hidden).toBe(999_940);
});

test("multi-megabyte output stays bounded in the dom and says what it left out", () => {
  const output = Array.from({ length: 30_000 }, (_, index) => `${index} ${"x".repeat(60)}`).join("\n");
  render(tool("huge", "bash", { kind: "shell", command: "log" }, output), ["tool:huge"]);
  openCard("tool:huge");
  expect(output.length).toBeGreaterThan(1_000_000);
  expect(container.textContent!.length).toBeLessThan(110_000);
  act(() => (q('[data-action="open-viewer"]') as HTMLButtonElement).click());
  expect(container.querySelectorAll('[data-part="text-viewer-row"]').length).toBeLessThanOrEqual(200);
  expect(container.textContent!.length).toBeLessThan(110_000);
  expect(container.querySelector('[data-action="show-more"]')).toBeNull();
  // One huge line is cut too.
  act(() => root!.unmount());
  root = undefined;
  render(tool("wide", "bash", { kind: "shell", command: "cat min.js" }, "y".repeat(2_000_000)), ["tool:wide"]);
  openCard("tool:wide");
  expect(container.textContent!.length).toBeLessThan(110_000);
});

test("every card and approval bounds multi-megabyte presentation surfaces", async () => {
  const huge = `${"x".repeat(1_999_999)}\ud83d\ude00`;
  const cases: Array<[string, ToolView | undefined]> = [
    ["generic", undefined],
    ["shell", { kind: "shell", command: huge }],
    ["read", { kind: "read", path: huge }],
    ["edit", { kind: "edit", path: "a.ts", diff: `@@ -1 +1 @@\n-${huge}\n+new` }],
    ["write", { kind: "write", path: "a.ts", content: huge }],
    ["search", { kind: "search", pattern: huge }],
    ["fetch", { kind: "fetch", url: `https://example.com/${huge}` }],
  ];
  const copied: string[] = [];
  restoreShims.push(shimProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } }));

  for (const [name, view] of cases) {
    const tool_call = { id: name, name, arguments: { value: huge } };
    render([
      { type: "tool_start", tool_call, view },
      { type: "tool_output", tool_call, output: huge },
      { type: "tool_end", tool_call, tool_result: { tool_call_id: name, content: huge, is_error: false } },
      { type: "approval_request", request_id: name, tool_call: { ...tool_call, id: `${name}-approval` }, view, delegated: false },
    ], [`tool:${name}`, `approval:${name}`]);
    openCard(`tool:${name}`);

    act(() => {
      for (const details of container.querySelectorAll<HTMLDetailsElement>('[data-part="tool-args-details"]')) {
        details.open = true;
        details.dispatchEvent(new Event("toggle"));
      }
    });
    for (const surface of container.querySelectorAll<HTMLElement>(
      '[data-part="tool-summary"], [data-part="tool-args"], [data-part="tool-output"], [data-part="shell-command"], [data-part="tool-lines"], [data-part="tool-diff"], [data-part="tool-path"], [data-part="search-pattern"], [data-part="fetch-url"]',
    )) {
      expect(surface.textContent!.length).toBeLessThanOrEqual(100_000);
      expect(surface.textContent).not.toContain("\ud83d…");
    }
    expect(container.textContent).toMatch(/(?:showing \d+ of \d+ characters|[\d,]+ more lines of [\d,]+ …)/);
    expect(container.querySelector('[data-action="show-more"]')).toBeNull();
    expect(container.querySelector('[data-action="open-viewer"]')).not.toBeNull();
    const copyArguments = container.querySelector<HTMLButtonElement>('[aria-label="copy arguments"]');
    expect(copyArguments).not.toBeNull();
    await act(async () => copyArguments!.click());
    expect(copied.at(-1)).toBe(JSON.stringify(tool_call.arguments, null, 2));

    act(() => root!.unmount());
    root = undefined;
    container.remove();
  }
});

test("large write, edit, and grouped search bodies all open the shared viewer", () => {
  const huge = "x".repeat(60_000);
  const grep = Array.from({ length: 2_000 }, (_, index) => `src/a.ts:${index + 1}:${huge.slice(0, 40)}`).join("\n");
  const events: RunEvent[] = [
    { type: "approval_request", request_id: "write-viewer", tool_call: { id: "write-viewer", name: "write", arguments: {} }, view: { kind: "write", path: "a.ts", content: huge }, delegated: false },
    { type: "approval_request", request_id: "edit-viewer", tool_call: { id: "edit-viewer", name: "edit", arguments: {} }, view: { kind: "edit", path: "a.ts", diff: `@@ -1 +1 @@\n-${huge}\n+new` }, delegated: false },
    ...tool("search-viewer", "search", { kind: "search", pattern: "x", path: "src" }, grep),
  ];
  render(events, ["approval:write-viewer", "approval:edit-viewer", "tool:search-viewer"]);
  openCard("tool:search-viewer");
  for (const id of ["approval:write-viewer", "approval:edit-viewer", "tool:search-viewer"]) {
    const card = q(`[data-id="${id}"]`);
    const open = card.querySelector<HTMLButtonElement>('[data-action="open-viewer"]');
    expect(open).not.toBeNull();
    act(() => open!.click());
    expect(card.querySelector('[data-part="text-viewer"]')).not.toBeNull();
    expect(card.querySelector('[data-action="show-more"]')).toBeNull();
  }
});

test("a large diff uses the shared viewer with an honest preview", () => {
  const deletions = Array.from({ length: 3_000 }, (_, i) => `-${i} ${"old".repeat(12)}`);
  const insertions = Array.from({ length: 3_000 }, (_, i) => `+${i} ${"new".repeat(12)}`);
  const diff = ["@@ -1,3000 +1,3000 @@", ...deletions, ...insertions].join("\n");
  const tool_call = { id: "large-edit", name: "edit", arguments: { path: "large.ts" } };
  render([
    { type: "approval_request", request_id: "large-edit", tool_call, view: { kind: "edit", path: "large.ts", diff }, delegated: false },
  ], ["approval:large-edit"]);
  // The preview is the first 40 and last 20 diff rows, drawn as diff rows.
  expect(container.querySelectorAll('[data-part="tool-diff"] > [data-part="diff-line"]')).toHaveLength(60);
  expect(q('[data-part="tool-diff"]').textContent!.length).toBeLessThanOrEqual(50_100);
  expect(q('[data-part="tool-diff"] > [data-part="tool-gap"]').textContent).toMatch(/^… 5,941 more lines of 6,001 …$/);
  expect(q('[data-action="open-viewer"]')).not.toBeNull();
});

test("open arguments serialize once across 1,000 output tokens and once per arguments identity", () => {
  const arguments_ = { path: "src/a.ts", value: "x".repeat(10_000) };
  const tool_call = { id: "lazy", name: "custom", arguments: arguments_ };
  const store = createRunStore((callback) => callback());
  store.dispatch({ type: "tool_start", tool_call });
  const original = JSON.stringify;
  let serializations = 0;
  JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
    if (value && typeof value === "object" && "path" in value && "value" in value) serializations++;
    return original(value, ...(rest as [((key: string, value: unknown) => unknown) | null, string | number | undefined]));
  }) as typeof JSON.stringify;
  try {
    mount(<RunProvider store={store}><ToolCall id="tool:lazy" /></RunProvider>);
    expect(serializations).toBe(0);
    const details = q('[data-part="tool-args-details"]') as HTMLDetailsElement;
    act(() => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(serializations).toBe(1);
    for (let index = 0; index < 1_000; index++) act(() => store.dispatch({ type: "tool_output", tool_call, output: "x" }));
    expect(serializations).toBe(1);
    const nextArguments = { ...arguments_, value: "updated" };
    act(() => store.dispatch({ type: "tool_input", tool_call: { ...tool_call, arguments: nextArguments }, input: "" }));
    expect(serializations).toBe(2);
    expect(q('[data-part="tool-args"]').textContent).toContain("updated");
  } finally {
    JSON.stringify = original;
  }
});

test("unknown tools show output and collapsed json arguments", () => {
  render(tool("unknown", "custom", undefined, "done"), ["tool:unknown"]);
  const card = q('[data-id="tool:unknown"]');
  expect(card.hasAttribute("data-tool-view")).toBe(false);
  expect(card.querySelector('[data-part="tool-output"]')!.textContent).toBe("done");
  const details = card.querySelector('[data-part="tool-args-details"]') as HTMLDetailsElement;
  expect(details.open).toBe(false);
  expect(card.textContent).not.toContain('"extra": true');
  act(() => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  expect(card.textContent).toContain('"extra": true');
});

test("approvals show the semantic body and the full requested arguments", () => {
  const command = `deploy ${"--flag ".repeat(40)}`;
  const tool_call = { id: "a1", name: "bash", arguments: { command, cwd: "/srv" } };
  const edit = { id: "a2", name: "edit", arguments: { path: "a.ts" } };
  render([
    { type: "approval_request", request_id: "a1", tool_call, view: { kind: "shell", command, cwd: "/srv" }, delegated: false },
    { type: "approval_request", request_id: "a2", tool_call: edit, view: { kind: "edit", path: "a.ts", diff: "@@ -1 +1 @@\n-a\n+b" }, delegated: false },
  ], ["approval:a1", "approval:a2"]);
  expect(q('[data-id="approval:a1"] [data-part="shell-command"]').textContent).toBe(command);
  const details = q('[data-id="approval:a1"] [data-part="tool-args-details"]') as HTMLDetailsElement;
  act(() => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  expect(q('[data-id="approval:a1"] [data-part="tool-args"]').textContent).toBe(JSON.stringify(tool_call.arguments, null, 2));
  expect(q('[data-id="approval:a1"] [data-part="tool-empty"]')).toBeNull();
  expect(container.querySelectorAll('[data-id="approval:a2"] [data-part="diff-line"]')).toHaveLength(3);
});

test("tool-specific timeline renderer still wins", () => {
  const store = createRunStore(() => {});
  tool("override", "bash", { kind: "shell", command: "false" }).forEach(store.dispatch);
  mount(
    <RunProvider store={store}>
      <Timeline renderers={{ "tool:bash": ({ id }) => <b data-override>{id}</b> }} />
    </RunProvider>,
  );
  expect(container.querySelector("[data-override]")?.textContent).toBe("tool:override");
  expect(container.querySelector("[data-tool-view]")).toBeNull();
});

test("a command taller than its clamp gets a control that shows all of it", () => {
  const command = Array.from({ length: 20 }, (_, i) => `echo ${i}`).join("\n");
  // happy-dom has no layout: the command reports 20 lines of content in an 8-line box until the clamp is removed.
  const proto = HTMLElement.prototype;
  const restoreScrollHeight = shimProperty(proto, "scrollHeight", { configurable: true, get() { return 400; } });
  const restoreClientHeight = shimProperty(proto, "clientHeight", { configurable: true, get(this: Element) { return this.hasAttribute("data-expanded") ? 400 : 160; } });
  try {
    render(tool("sh", "bash", { kind: "shell", command }, "ok\n"), ["tool:sh"]);
    openCard("tool:sh");
    const button = q('[data-action="show-command"]');
    expect(button.textContent).toBe("show full command");
    expect(q('[data-part="shell-command"]').hasAttribute("data-expanded")).toBe(false);
    act(() => button.click());
    expect(q('[data-part="shell-command"]').hasAttribute("data-expanded")).toBe(true);
    expect(q('[data-action="show-command"]')).toBeNull();
    expect(q('[data-part="shell-command"]').textContent).toBe(command);
  } finally {
    restoreClientHeight();
    restoreScrollHeight();
  }
});

test("a command that fits its clamp has no show control", () => {
  render(tool("sh", "bash", { kind: "shell", command: `rg ${"x".repeat(80)}` }, "ok\n"), ["tool:sh"]);
  openCard("tool:sh");
  expect(q('[data-part="shell-command"]')).not.toBeNull();
  expect(q('[data-action="show-command"]')).toBeNull();
});

test("output restarted into the same tool id (a replay, a reconnect, a demo loop) shows each line once", () => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const tool_call = { id: "r", name: "bash", arguments: { command: "bun test" } };
    const lines = Array.from({ length: 24 }, (_, i) => `\x1b[32mok\x1b[0m case ${i + 1}\n`);
    const store = () => createRunStore((flush) => flush());
    let current = store();
    const view = () => <RunProvider store={current}><ToolCall id="tool:r" /></RunProvider>;
    for (let loop = 0; loop < 3; loop++) {
      current = store();
      current.dispatch({ type: "tool_start", tool_call, view: { kind: "shell", command: "bun test" } });
      if (loop) act(() => root!.render(view()));
      else mount(view());
      openCard("tool:r");
      for (const line of lines) act(() => current.dispatch({ type: "tool_output", tool_call, output: line }));
      expect(q('[data-part="tool-output"]').textContent).toBe(lines.map((line) => line.replace(/\x1b\[\d+m/g, "")).join(""));
    }
    expect(errors).toEqual([]);
  } finally {
    console.error = original;
  }
});

test("a resolved approval says how it ended, and a folded one marks its tool card", () => {
  const call = (id: string) => ({ id, name: "bash", arguments: { command: "ls" } });
  const ask = (id: string): RunEvent => ({ type: "approval_request", request_id: id, tool_call: call(`${id}-call`), view: { kind: "shell", command: "ls" }, delegated: false });
  // The adapter's raw data keeps the harness's own word (zeta says "allow"); the card reads only `decision`.
  const end = (id: string, decision: ApprovalDecision, data: Record<string, unknown> = {}): RunEvent => ({ type: "approval_end", request_id: id, decision, data: { decision: decision === "approve" ? "allow" : decision, ...data } });
  render([
    ask("yes"), end("yes", "approve"),
    ask("no"), end("no", "deny"),
    ask("lost"), end("lost", "abort", { reason: "controller_disconnected" }),
    ask("abort"), end("abort", "abort"),
    ask("ran"), end("ran", "approve"), ...tool("ran-call", "bash", { kind: "shell", command: "ls" }, "a\n").map((event) => ({ ...event, tool_call: call("ran-call") }) as RunEvent),
  ], ["approval:yes", "approval:no", "approval:lost", "approval:abort", "tool:ran-call"]);
  const status = (id: string) => q(`[data-id="${id}"] [data-part="tool-status"]`).textContent;
  expect(status("approval:yes")).toBe("approved");
  expect(status("approval:no")).toBe("denied");
  expect(status("approval:lost")).toBe("connection lost");
  expect(status("approval:abort")).toBe("canceled");
  expect(q('[data-id="approval:no"]').getAttribute("data-decision")).toBe("deny");
  expect(q('[data-id="tool:ran-call"] [data-part="tool-approval"]').textContent).toBe("approved");
  expect(status("tool:ran-call")).toBe("approved·done");
});

test("an approval's decision word is colored by styles.css: approved ok, denied danger, other endings muted", () => {
  const style = document.createElement("style");
  style.textContent = ":root { --fulcrum-ok: rgb(0, 128, 0); --fulcrum-danger: rgb(255, 0, 0); --fulcrum-muted: rgb(128, 128, 128); }" + readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  document.head.append(style);
  try {
    const call = (id: string) => ({ id, name: "bash", arguments: { command: "ls" } });
    const ask = (id: string): RunEvent => ({ type: "approval_request", request_id: id, tool_call: call(`${id}-call`), delegated: false });
    render([
      ask("yes"), { type: "approval_end", request_id: "yes", decision: "approve" },
      ask("no"), { type: "approval_end", request_id: "no", decision: "deny" },
      ask("abort"), { type: "approval_end", request_id: "abort", decision: "abort" },
      ask("ran"), { type: "approval_end", request_id: "ran", decision: "approve" }, { type: "tool_start", tool_call: call("ran-call") },
      // A call whose approval was lost, then canceled: the card's mark is hollow (transparent), its word is not.
      ask("lost"), { type: "approval_end", request_id: "lost", decision: "abort", data: { reason: "controller_disconnected" } }, { type: "tool_start", tool_call: call("lost-call") },
      { type: "tool_end", tool_call: call("lost-call"), tool_result: { tool_call_id: "lost-call", content: "", is_error: false, is_canceled: true } },
    ], ["approval:yes", "approval:no", "approval:abort", "tool:ran-call", "tool:lost-call"]);
    const color = (selector: string) => getComputedStyle(q(selector)).color;
    expect(color('[data-id="approval:yes"] [data-part="tool-status"]')).toBe("rgb(0, 128, 0)");
    expect(color('[data-id="approval:no"] [data-part="tool-status"]')).toBe("rgb(255, 0, 0)");
    expect(color('[data-id="approval:abort"] [data-part="tool-status"]')).toBe("rgb(128, 128, 128)");
    expect(color('[data-id="tool:ran-call"] [data-part="tool-approval"]')).toBe("rgb(0, 128, 0)");
    expect(q('[data-id="tool:lost-call"]').dataset.state).toBe("canceled");
    expect(q('[data-id="tool:lost-call"] [data-part="tool-approval"]').textContent).toBe("connection lost");
    expect(color('[data-id="tool:lost-call"] [data-part="tool-approval"]')).toBe("rgb(128, 128, 128)");
  } finally {
    style.remove();
  }
});

test("styles.css keeps a host's own approve-* button quiet; only the approval's three actions are loud", () => {
  const style = document.createElement("style");
  style.textContent = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  document.head.append(style);
  try {
    const card = mount(
      <div data-part="approval">
        <button type="button" data-action="approve-changes">approve changes</button>
        <div data-part="approval-actions">
          <button type="button" data-action="approve">approve</button>
          <button type="button" data-action="approve-always">always allow</button>
          <button type="button" data-action="deny">deny</button>
        </div>
      </div>,
    );
    const minHeight = (action: string) => getComputedStyle(card.querySelector<HTMLElement>(`[data-action="${action}"]`)!).minHeight;
    expect(minHeight("approve-changes")).toBe("32px");
    for (const action of ["approve", "approve-always", "deny"]) expect(minHeight(action)).toBe("36px");
  } finally {
    style.remove();
  }
});

test("a denied call, replayed from history, says denied once and keeps the harness's note closed", () => {
  const tool_call = { id: "bash-3", name: "bash", arguments: { command: "rm -rf packages/core/dist" } };
  // zeta's history: the call, its error result (src/zeta/tools/registry.py "tool execution denied"), then the approval.
  render([
    { type: "tool_start", tool_call, view: { kind: "shell", command: "rm -rf packages/core/dist" } },
    { type: "tool_end", tool_call, tool_result: { tool_call_id: "bash-3", content: "tool execution denied", is_error: true } },
    { type: "approval_request", request_id: "bash-3", tool_call, delegated: false },
    { type: "approval_end", request_id: "bash-3", decision: "deny" },
  ], ["tool:bash-3"]);
  expect(q('[data-id="tool:bash-3"] [data-part="tool-status"]').textContent).toBe("denied");
  expect((q('[data-id="tool:bash-3"]') as HTMLDetailsElement).open).toBe(false);
});

test("a pending approval shows a short command once, and a footer without facts has no empty left side", () => {
  const tool_call = { id: "s1", name: "bash", arguments: { command: "rm -rf dist" } };
  render([{ type: "approval_request", request_id: "s1", tool_call, view: { kind: "shell", command: "rm -rf dist" }, delegated: false }], ["approval:s1"]);
  expect(q('[data-id="approval:s1"] [data-part="tool-summary"]').textContent).toBe("$ rm -rf dist");
  expect(q('[data-id="approval:s1"] [data-part="shell-command"]')).toBeNull();
  expect(q('[data-id="approval:s1"] [data-part="tool-foot"] [data-part="tool-meta"]')).toBeNull();
});

test("a pending read, write, or search shows a short path once, and a long one also in the body", () => {
  const long = `packages/${"deep/".repeat(16)}README.md`;
  const ask = (id: string, name: string, view: ToolView): RunEvent => ({ type: "approval_request", request_id: id, tool_call: { id, name, arguments: {} }, view, delegated: false });
  render([
    ask("r", "read", { kind: "read", path: "README.md" }),
    ask("w", "write", { kind: "write", path: "notes.md", content: "a\n" }),
    ask("s", "grep", { kind: "search", pattern: "TODO", path: "src" }),
    ask("long", "read", { kind: "read", path: long }),
  ], ["approval:r", "approval:w", "approval:s", "approval:long"]);
  for (const id of ["r", "w", "s"]) expect(q(`[data-id="approval:${id}"] [data-part="tool-path"]`)).toBeNull();
  expect(q('[data-id="approval:r"] [data-part="tool-summary"]').textContent).toBe("README.md");
  expect(q('[data-id="approval:long"] [data-part="tool-path"]').textContent).toBe(long);
});

test("a generic tool's summary is colored, and a list argument reads as a count and its first item", () => {
  const store = (id: string, args: Record<string, unknown>): RunEvent => ({ type: "tool_start", tool_call: { id, name: id, arguments: args } });
  render([
    store("todo", { items: [{ content: "cap the pending queue", status: "in_progress" }] }),
    store("todos", { items: [{ status: "done", content: "one" }, { content: "two" }] }),
    store("write_file", { path: "fixtures/session.json", content: "{}" }),
  ], ["tool:todo", "tool:todos", "tool:write_file"]);
  const summary = (id: string) => q(`[data-id="tool:${id}"] [data-part="tool-summary"]`);
  expect(summary("todo").textContent).toBe("1 item · cap the pending queue");
  expect(summary("todos").textContent).toBe("2 items · one");
  expect(summary("todo").querySelector('[data-part="summary-count"]')?.textContent).toBe("1 item");
  expect(summary("write_file").querySelector('[data-part="summary-path"]')?.textContent).toBe("fixtures/session.json");
});

test("dropped steering is explicit live and compact after reload", () => {
  const store = createRunStore(() => {});
  [
    { type: "user_message", text: "this steer must be dropped", mode: "steer", delivery_id: "dropped-steer" },
    { type: "delivery_status", delivery_id: "dropped-steer", method: "steer", status: "dropped", content: "steer dropped: abort", reason: "abort" },
    { type: "delivery_status", delivery_id: "history-only", method: "steer", status: "dropped", content: "steer dropped: abort", reason: "abort" },
  ].forEach((event) => store.dispatch(event as RunEvent));
  mount(<RunProvider store={store}><Fallback id="user:delivery:dropped-steer" /><Fallback id="user:delivery:history-only" /></RunProvider>);
  expect(q('[data-id="user:delivery:dropped-steer"] [data-part="message-content"]').textContent).toBe("this steer must be dropped");
  expect(q('[data-id="user:delivery:dropped-steer"] [data-part="delivery-note"]').textContent).toBe("not delivered · the run was stopped");
  expect(q('[data-id="user:delivery:history-only"] [data-part="message-content"]')).toBeNull();
  expect(q('[data-id="user:delivery:history-only"] [data-part="delivery-note"]').textContent).toBe("not delivered · the run was stopped · text not kept");
});

const droppedSteer = (reason?: string): RunEvent => ({ type: "user_message", text: "steer", mode: "steer", delivery_id: "d", delivery_status: "dropped", ...(reason === undefined ? {} : { delivery_reason: reason }) });
const deliveryNote = (within: HTMLElement) => within.querySelector('[data-id="user:delivery:d"] [data-part="delivery-note"]');

test.each([
  ["turn_end", "the turn ended first"],
  ["abort", "the run was stopped"],
  ["clear", "the pending steers were cleared"],
  ["disconnect", "the connection was lost"],
  ["failed", "the turn failed"],
  ["restart", "the server restarted"],
])("a steer dropped for %s reads as words, not the token", (reason, words) => {
  const store = createRunStore(() => {});
  store.dispatch(droppedSteer(reason));
  const view = mount(<RunProvider store={store}><Fallback id="user:delivery:d" /></RunProvider>);
  expect(deliveryNote(view)?.textContent).toBe(`not delivered · ${words}`);
  expect(view.querySelector('[data-part="message-content"]')?.textContent).toBe("steer");
});

test("an unconfirmed delivery uses readable words and never exposes an unknown reason token", () => {
  expect(deliveryNoteText("unknown")).toBe("not confirmed");
  expect(deliveryNoteText("unknown", "future_reason")).toBe("not confirmed");
});

test("an unknown or missing drop reason says only not delivered", () => {
  for (const reason of ["quota_exhausted", undefined]) {
    const store = createRunStore(() => {});
    store.dispatch(droppedSteer(reason));
    const view = mount(<RunProvider store={store}><Fallback id="user:delivery:d" /></RunProvider>);
    expect(deliveryNote(view)?.textContent).toBe("not delivered");
    if (reason) expect(view.textContent).not.toContain(reason);
  }
});

test("renderDeliveryNote replaces the delivery note, and null hides it", () => {
  const store = createRunStore(() => {});
  store.dispatch(droppedSteer("turn_end"));
  store.dispatch({ type: "user_message", text: "delivered", mode: "send", delivery_id: "ok", delivery_status: "delivered" });
  const seen: string[] = [];
  const view = mount(<RunProvider store={store}>
    <Fallback id="user:delivery:d" renderDeliveryNote={(item) => { seen.push(item.id); return <>lost · <button type="button">resend</button></>; }} />
    <Fallback id="user:delivery:ok" renderDeliveryNote={(item) => { seen.push(item.id); return null; }} />
  </RunProvider>);
  expect(deliveryNote(view)?.textContent).toBe("lost · resend");
  expect(deliveryNote(view)?.querySelector("button")?.textContent).toBe("resend");
  expect(seen).toEqual(["user:delivery:d", "user:delivery:ok"]);
  expect(view.querySelector('[data-id="user:delivery:ok"] [data-part="delivery-note"]')).toBeNull();
  const hidden = mount(<RunProvider store={store}><Fallback id="user:delivery:d" renderDeliveryNote={() => null} /></RunProvider>);
  expect(deliveryNote(hidden)).toBeNull();
  expect(hidden.textContent).toBe("> steer");
});

test("renderDeliveryNote replaces a text-omitted note", () => {
  const store = createRunStore(() => {});
  store.dispatch({ type: "delivery_status", delivery_id: "d", method: "steer", status: "dropped", content: "steer dropped: abort", reason: "abort" });

  const replaced = mount(<RunProvider store={store}><Fallback id="user:delivery:d" renderDeliveryNote={() => <>host lost it</>} /></RunProvider>);
  expect(replaced.querySelector('[data-part="delivery-note"]')?.textContent).toBe("host lost it");
});

test("a null delivery note hides a text-omitted row in the default renderer", () => {
  const store = createRunStore(() => {});
  store.dispatch({ type: "user_message", text: "", text_omitted: true, mode: "steer", delivery_id: "d", delivery_status: "dropped" });

  const hidden = mount(<RunProvider store={store}><Fallback id="user:delivery:d" renderDeliveryNote={() => null} /></RunProvider>);
  expect(hidden.querySelector('[data-id="user:delivery:d"]')).toBeNull();
});

test("a text-omitted row reaches a custom user renderer and its nested Fallback", () => {
  const store = createRunStore(() => {});
  store.dispatch({ type: "delivery_status", delivery_id: "d", method: "steer", status: "dropped", content: "steer dropped: clear", reason: "clear" });
  const seen: Array<{ type?: string; textOmitted?: true }> = [];
  const User = ({ id }: { id: string }) => {
    const item = useItem(id);
    seen.push({ type: item?.type, textOmitted: item?.type === "user" && item.event.type === "user_message" ? (item.event as { text_omitted?: true }).text_omitted : undefined });
    return <Fallback id={id} renderDeliveryNote={() => <>host note</>} />;
  };
  const renderers: Renderers = { user: User };

  const view = mount(<RunProvider store={store}><Timeline virtual={false} renderers={renderers} /></RunProvider>);
  expect(seen.at(-1)).toEqual({ type: "user", textOmitted: true });
  expect(view.querySelector('[data-part="delivery-note"]')?.textContent).toBe("host note");
});

test("a notification row says what the notification says", () => {
  const store = createRunStore(() => {});
  [
    { type: "notification", notification_id: "n1", data: { text: "Context compacted" } },
    { type: "notification", notification_id: "n2", data: { kind: "agent_completion", summary: "worker finished" } },
    { type: "notification", notification_id: "n3", data: { count: 3 } },
  ].forEach((event) => store.dispatch(event as RunEvent));
  mount(<RunProvider store={store}>{[1, 2, 3].map((index) => <Fallback key={index} id={`notification:${index}`} />)}</RunProvider>);
  expect(q('[data-id="notification:1"]').textContent).toBe("Context compacted");
  expect(q('[data-id="notification:2"]').textContent).toBe("worker finished");
  expect(q('[data-id="notification:3"]').textContent).toBe("notification");
});

test("a part asked for an id the store does not have renders nothing", () => {
  mount(<RunProvider store={createRunStore(() => {})}><ToolCall id="tool:missing" /><Fallback id="notification:9" /></RunProvider>);
  expect(container.innerHTML).toBe("");
});
