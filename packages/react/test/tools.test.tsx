import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRunStore, type RunEvent, type ToolView } from "@fulcrum/core";
import { RunProvider, Timeline, ToolBody } from "../src/index.js";

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

const tool = (id: string, name: string, view: ToolView | undefined, output = ""): RunEvent[] => {
  const tool_call = { id, name, arguments: { path: "src/a.ts", extra: true } };
  return [
    { type: "tool_start", tool_call, view },
    ...(output ? [{ type: "tool_output", tool_call, output, view } as RunEvent] : []),
    { type: "tool_end", tool_call, view, tool_result: { tool_call_id: id, content: output, is_error: false } },
  ];
};

function render(events: RunEvent[], body: ReactNode) {
  const store = createRunStore(() => {});
  events.forEach(store.dispatch);
  mount(<RunProvider store={store}>{body}</RunProvider>);
}

const cases: Array<[ToolView, string, string]> = [
  [{ kind: "shell", command: "bun test", cwd: "/repo", exitCode: 0, durationMs: 1250 }, "shell", "$ bun test"],
  [{ kind: "read", path: "src/a.ts", range: { offset: 10, limit: 20 } }, "read", "src/a.ts:10+20"],
  [{ kind: "edit", path: "src/a.ts", diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new" }, "edit", "src/a.ts"],
  [{ kind: "write", path: "src/a.ts", bytes: 12 }, "write", "12 B"],
  [{ kind: "search", pattern: "TODO", path: "src" }, "search", "TODO"],
  [{ kind: "fetch", url: "https://example.com", title: "Example", bytes: 128 }, "fetch", "https://example.com"],
];

for (const [view, kind, text] of cases) {
  test(`${kind} view renders its semantic card`, () => {
    render(tool(kind, kind, view, "line one\nline two"), <ToolBody id={`tool:${kind}`} />);
    const card = container.querySelector(`[data-tool-view="${kind}"]`)!;
    expect(card).toBeTruthy();
    expect(card.textContent).toContain(text);
  });
}

test("shell shows exit status and duration", () => {
  render(tool("shell-meta", "bash", { kind: "shell", command: "true", exitCode: 0, durationMs: 1250 }), <ToolBody id="tool:shell-meta" />);
  expect(container.querySelector('[data-part="tool-exit"]')?.textContent).toBe("exit 0");
  expect(container.querySelector('[data-part="tool-duration"]')?.textContent).toBe("1.3 s");
  expect(container.querySelector('[data-part="tool-empty"]')?.textContent).toBe("no output");
});

test("copy controls copy useful values", async () => {
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } });
  render(tool("copy", "read", { kind: "read", path: "src/a.ts" }), <ToolBody id="tool:copy" />);
  await act(async () => (container.querySelector('[data-action="copy"]') as HTMLButtonElement).click());
  expect(copied).toEqual(["src/a.ts"]);
  expect(container.querySelector('[data-action="copy"]')?.textContent).toBe("copied");
});

test("edit diff exposes inserted and deleted line seams", () => {
  const view: ToolView = { kind: "edit", path: "a.ts", diff: "-old\n context\n+new" };
  render(tool("edit", "edit", view), <ToolBody id="tool:edit" />);
  expect(container.querySelector(".tok-deleted")?.textContent).toBe("-old");
  expect(container.querySelector(".tok-inserted")?.textContent).toBe("+new");
});

test("large output is capped until show all is requested", () => {
  const output = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
  render(tool("large", "bash", { kind: "shell", command: "log" }, output), <ToolBody id="tool:large" />);
  expect(container.textContent).toContain("line 0");
  expect(container.textContent).toContain("line 499");
  expect(container.textContent).not.toContain("line 250");
  const button = container.querySelector('[data-action="show-all"]') as HTMLButtonElement;
  expect(button.textContent).toContain("440");
  act(() => button.click());
  expect(container.textContent).toContain("line 250");
});

test("unknown tools use a one-line summary and collapsed json", () => {
  render(tool("unknown", "custom", undefined), <ToolBody id="tool:unknown" />);
  const card = container.querySelector('[data-tool-view="generic"]')!;
  expect(card.textContent).toContain("path: src/a.ts");
  expect(card.querySelector("details")?.open).toBe(false);
  expect(card.textContent).toContain('"extra": true');
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
