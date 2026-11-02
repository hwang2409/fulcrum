import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRunStore, type RunEvent, type ToolView } from "@fulcrum/core";
import { Approval, RunProvider, Timeline, ToolCall } from "../src/index.js";
import { boundLines } from "../src/tools/common.js";
import { segmentText } from "../src/tools/text-viewer.js";

afterAll(() => GlobalRegistrator.unregister());
let root: Root | undefined;
let container: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
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
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } });
  const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  render([
    ...tool("c1", "bash", { kind: "shell", command: "ls -la" }, long),
    ...tool("c2", "read", { kind: "read", path: "src/a.ts" }, "x"),
  ], ["tool:c1", "tool:c2"]);
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('[data-action="copy"]')];
  expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["copy command", "copy output", "copy path", "copy output"]);
  for (const button of buttons) await act(async () => button.click());
  expect(copied).toEqual(["ls -la", long, "src/a.ts", "x"]);
  expect(buttons[0]!.textContent).toBe("copied");
});

test("large output opens in the shared bounded viewer", () => {
  const output = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
  render(tool("large", "bash", { kind: "shell", command: "log" }, output), ["tool:large"]);
  const preview = () => q('[data-part="tool-output"]').textContent!;
  expect(preview()).toContain("line 0\n");
  expect(preview()).toContain("line 499");
  expect(preview()).toContain("500 lines / 4,389 characters; open to view all");
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
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } });

  for (const [name, view] of cases) {
    const tool_call = { id: name, name, arguments: { value: huge } };
    render([
      { type: "tool_start", tool_call, view },
      { type: "tool_output", tool_call, output: huge },
      { type: "tool_end", tool_call, tool_result: { tool_call_id: name, content: huge, is_error: false } },
      { type: "approval_request", request_id: name, tool_call: { ...tool_call, id: `${name}-approval` }, view, delegated: false },
    ], [`tool:${name}`, `approval:${name}`]);

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
    expect(container.textContent).toMatch(/(?:showing \d+ of \d+ characters|[\d,]+ lines \/ [\d,]+ characters; open to view all)/);
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
  expect(q('[data-part="tool-output"]').textContent!.length).toBeLessThanOrEqual(50_100);
  expect(q('[data-part="tool-output"]').textContent).toMatch(/6,001 lines \/ [\d,]+ characters; open to view all/);
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
    act(() => store.dispatch({ type: "tool_output", tool_call: { ...tool_call, arguments: nextArguments }, output: "x" }));
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
