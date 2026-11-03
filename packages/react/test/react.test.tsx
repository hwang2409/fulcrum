import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { act, Profiler, StrictMode, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRunStore, initialState, type OutlineChange, type RunEvent, type RunItem, type ToolCall as ToolCallData } from "@fulcrum/core";
import { Markdown } from "../../markdown/src/react.js";
import {
  announcementForItem,
  Approval,
  Message,
  RunProvider,
  Timeline,
  ToolCall,
  useItem,
  useRun,
  useTimeline,
  useVirtualList,
  type Renderers,
  type RunStore,
  type ToolBodyProps,
} from "../src/index.js";

afterAll(() => GlobalRegistrator.unregister());

const message = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const call = (id: string, name: string) => ({ id, name, arguments: {} });

function timelineStore(initialItems: RunItem[], initialChange: OutlineChange | null = null) {
  let items = initialItems;
  let snapshot = { items: items.map(({ id, type: kind }) => ({ id, kind })), change: initialChange };
  const entities = new Map(items.map((item) => [item.id, item]));
  const outlineListeners = new Set<() => void>();
  const itemListeners = new Map<string, Set<() => void>>();
  const store: RunStore = {
    getState: () => initialState,
    getItem: (id) => entities.get(id),
    getOutline: () => snapshot.items,
    getOutlineSnapshot: () => snapshot,
    subscribe(first: string | (() => void), second?: () => void) {
      if (typeof first !== "string") return () => {};
      const listeners = itemListeners.get(first) ?? new Set();
      itemListeners.set(first, listeners);
      listeners.add(second!);
      return () => listeners.delete(second!);
    },
    subscribeOutline(listener) {
      outlineListeners.add(listener);
      return () => outlineListeners.delete(listener);
    },
  };
  return {
    store,
    replace(next: RunItem[], change: OutlineChange | null) {
      items = next;
      for (const item of items) entities.set(item.id, item);
      snapshot = { items: items.map(({ id, type: kind }) => ({ id, kind })), change };
      act(() => outlineListeners.forEach((listener) => listener()));
    },
  };
}

function setup(events: RunEvent[]) {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  const send = (...more: RunEvent[]) =>
    act(() => {
      more.forEach(store.dispatch);
      jobs.splice(0).forEach((job) => job());
    });
  events.forEach(store.dispatch);
  jobs.splice(0).forEach((job) => job());
  return { store, send };
}

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
const q = (selector: string) => container.querySelector(selector) as HTMLElement;
// react-dom keeps the committed props object on each host node; a new object means the owner re-rendered.
const hostProps = (el: Element) =>
  (el as unknown as Record<string, unknown>)[Object.keys(el).find((key) => key.startsWith("__reactProps$"))!];

test("highlighting passes cumulative source with stable identity and monotonic versions", async () => {
  type Context = { id: string; version: number; state: "streaming" | "done" };
  type Token = { type?: "keyword"; text: string };
  const calls: Array<{ code: string; language: string | undefined; context: Context | undefined }> = [];
  const resolves: Array<(result: Token[]) => void> = [];
  const highlight = (code: string, language: string | undefined, context?: Context) => {
    calls.push({ code, language, context });
    return new Promise<Token[]>((resolve) => resolves.push(resolve));
  };
  mount(<Markdown id="message:one" source={"```ts\na\n"} streaming highlight={highlight} />);
  act(() => root!.render(<Markdown id="message:one" source={"```ts\na\nb\npartial"} streaming highlight={highlight} />));
  expect(calls).toEqual([
    { code: "a\n", language: "ts", context: { id: "message:one:0", version: 1, state: "streaming" } },
    { code: "a\nb\npartial", language: "ts", context: { id: "message:one:0", version: 2, state: "streaming" } },
  ]);

  await act(async () => {
    resolves.shift()!([{ type: "keyword", text: "a\n" }]);
    resolves.shift()!([{ type: "keyword", text: "a\nb\npartial" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.textContent).toBe("a\nb\npartial");
  expect(container.querySelectorAll(".tok-keyword")).toHaveLength(1);

  act(() => root!.render(<Markdown id="message:one" source={"```ts\na\nb\npartial\n```"} streaming highlight={highlight} />));
  expect(calls[2]).toEqual({ code: "a\nb\npartial\n", language: "ts", context: { id: "message:one:0", version: 3, state: "done" } });
});

test("async highlighting commits in strict mode", async () => {
  let resolve!: (tokens: Array<{ text: string; type?: "keyword" }>) => void;
  const highlight = () => new Promise<Array<{ text: string; type?: "keyword" }>>((done) => { resolve = done; });
  mount(<StrictMode><Markdown source={"```ts\nconst x = 1;\n```"} highlight={highlight} /></StrictMode>);
  await act(async () => {
    resolve([{ text: "const x = 1;\n", type: "keyword" }]);
    await Promise.resolve();
  });
  expect(container.querySelector(".tok-keyword")?.textContent).toBe("const x = 1;\n");
});

test("streaming markdown keeps a finished block element mounted", () => {
  mount(<Markdown source={"first\n\nsecond"} streaming />);
  const first = q('[data-part="md-paragraph"]');
  act(() => root!.render(<Markdown source={"first\n\nsecond grows"} streaming />));
  expect(q('[data-part="md-paragraph"]')).toBe(first);
  expect(container.querySelectorAll('[data-part="md-paragraph"]')[1]?.textContent).toBe("second grows");
});

test("Message composes assistant markdown while user and explicit plain modes stay text", () => {
  const { store } = setup([
    { type: "message_commit", message_id: "assistant", message: message("use `code`") },
    { type: "message_commit", message_id: "user", message: { role: "user", content: [{ type: "text", text: "use `plain`" }] } },
  ]);
  mount(
    <RunProvider store={store}>
      <Message id="message:assistant" markdown={Markdown} />
      <Message id="message:user" markdown={Markdown} />
      <Message id="message:assistant" markdown={false} className="plain" />
    </RunProvider>,
  );
  expect(q('[data-id="message:assistant"] [data-part="md-code-inline"]')?.textContent).toBe("code");
  expect(q('[data-id="message:user"]').textContent).toBe("use `plain`");
  expect(q(".plain").textContent).toBe("use `code`");
});

test("Message can opt user messages into markdown", () => {
  const { store } = setup([
    { type: "message_commit", message_id: "user", message: { role: "user", content: [{ type: "text", text: "use **strong**" }] } },
  ]);
  mount(
    <RunProvider store={store}>
      <Message id="message:user" markdown={Markdown} markdownFor="all" />
    </RunProvider>,
  );
  expect(q('[data-part="md-strong"]').textContent).toBe("strong");
});

test("a delta re-renders only the streaming item", async () => {
  const { store, send } = setup([
    { type: "message_commit", message_id: "a", message: message("one") },
    { type: "message_commit", message_id: "b", message: message("two") },
    { type: "message_delta", message_id: "c", delta: "x" },
  ]);
  const commits: Record<string, number> = {};
  const rows: Record<string, number> = {};
  const Counted = ({ id }: { id: string }) => {
    rows[id] = (rows[id] ?? 0) + 1;
    return (
      <Profiler id={id} onRender={() => (commits[id] = (commits[id] ?? 0) + 1)}>
        <Message id={id} />
      </Profiler>
    );
  };
  const renderers: Renderers = { message: Counted };
  mount(
    <RunProvider store={store}>
      <Timeline renderers={renderers} />
    </RunProvider>,
  );
  const timelineProps = hostProps(q('[data-part="timeline"]'));
  const before = { commits: { ...commits }, rows: { ...rows } };

  for (let i = 0; i < 5; i++) send({ type: "message_delta", message_id: "c", delta: "y" });

  expect(q('[data-id="message:c"]').textContent).toBe("xyyyyy");
  expect(commits["message:c"]).toBe(before.commits["message:c"]! + 5);
  expect(commits["message:a"]).toBe(before.commits["message:a"]!);
  expect(commits["message:b"]).toBe(before.commits["message:b"]!);
  expect(rows).toEqual(before.rows);
  expect(hostProps(q('[data-part="timeline"]'))).toBe(timelineProps);
  expect(store.getOutline()).toHaveLength(3);
});

test("useRun applies a changed selector without a store update", () => {
  const { store } = setup([{ type: "run_start" }]);
  let selectTurn!: () => void;
  const View = () => {
    const [turn, setTurn] = useState(false);
    selectTurn = () => setTurn(true);
    const value = useRun(turn ? (state) => state.turn : (state) => state.agent);
    return <span>{turn ? `turn=${value}` : `agent=${value}`}</span>;
  };
  mount(
    <RunProvider store={store}>
      <View />
    </RunProvider>,
  );

  expect(container.textContent).toBe("agent=running");
  act(selectTurn);
  expect(container.textContent).toBe("turn=idle");
});

test("dispose leaves the last mounted snapshot and stops notifications", () => {
  const { store } = setup([
    { type: "message_delta", message_id: "m", delta: "x" },
  ]);
  const View = () => {
    const outline = useTimeline();
    const item = useItem("message:m");
    return <span>{outline.length}:{item?.type === "message" ? item.text : "none"}</span>;
  };
  mount(
    <RunProvider store={store}>
      <View />
    </RunProvider>,
  );

  expect(container.textContent).toBe("1:x");
  act(() => store.dispose());
  expect(store.getOutline()).toHaveLength(0);
  expect(store.getItem("message:m")).toBeUndefined();
  expect(container.textContent).toBe("1:x");
});

test("keyed hooks do not read unrelated items or the outline", () => {
  const { store, send } = setup([
    { type: "message_commit", message_id: "a", message: message("one") },
    { type: "message_commit", message_id: "b", message: message("two") },
  ]);
  let aReads = 0;
  let bReads = 0;
  let outlineReads = 0;
  const A = () => {
    aReads++;
    useItem("message:a");
    return null;
  };
  const B = () => {
    bReads++;
    useItem("message:b");
    return null;
  };
  const Outline = () => {
    outlineReads++;
    useTimeline();
    return null;
  };
  mount(
    <RunProvider store={store}>
      <A />
      <B />
      <Outline />
    </RunProvider>,
  );
  const before = [aReads, bReads, outlineReads];

  send({ type: "message_delta", message_id: "a", delta: "+" });

  expect(aReads).toBe(before[0]! + 1);
  expect(bReads).toBe(before[1]);
  expect(outlineReads).toBe(before[2]);
});

test("timeline renders items in order with renderer by kind and by tool name", () => {
  const { store } = setup([
    { type: "message_commit", message_id: "a", message: message("hello") },
    { type: "tool_start", tool_call: call("t1", "bash") },
    { type: "tool_start", tool_call: call("t2", "read") },
    { type: "message_commit", message_id: "b", message: message("bye") },
  ]);
  const renderers: Renderers = {
    message: ({ id }) => <i data-r="message">{id}</i>,
    tool: ({ id }) => <i data-r="tool">{id}</i>,
    "tool:bash": ({ id }) => <i data-r="bash">{id}</i>,
  };
  mount(
    <RunProvider store={store}>
      <Timeline renderers={renderers} />
    </RunProvider>,
  );
  const seen = [...container.querySelectorAll("[data-r]")].map(
    (el) => `${el.getAttribute("data-r")}=${el.textContent}`,
  );
  expect(seen).toEqual(["message=message:a", "bash=tool:t1", "tool=tool:t2", "message=message:b"]);
});

test("unknown item kind uses the fallback renderer", () => {
  const { store } = setup([
    { type: "unknown", name: "future_event", data: {} },
    { type: "user_message", text: "hi there", mode: "chat" },
  ]);
  mount(
    <RunProvider store={store}>
      <Timeline renderers={{ message: () => <i>never</i> }} />
    </RunProvider>,
  );
  const items = [...container.querySelectorAll('[data-part="item"]')];
  expect(items.map((el) => el.getAttribute("data-kind"))).toEqual(["unknown", "user"]);
  expect(items[0]!.textContent).toBe("future_event");
  expect(items[1]!.textContent).toBe("hi there");
});

test("approval calls onApprove or onDeny with the request id", () => {
  const { store } = setup([
    { type: "approval_request", request_id: "r1", tool_call: call("t1", "bash"), delegated: false },
    { type: "approval_request", request_id: "r2", tool_call: call("t2", "bash"), delegated: false },
  ]);
  const calls: string[] = [];
  mount(
    <RunProvider store={store}>
      <Approval id="approval:r1" className="mine" onApprove={(id) => calls.push(`approve:${id}`)} onDeny={(id) => calls.push(`deny:${id}`)} />
      <Approval id="approval:r2" onApprove={(id) => calls.push(`approve:${id}`)} onDeny={(id) => calls.push(`deny:${id}`)} />
    </RunProvider>,
  );
  expect(q('[data-part="approval"]').className).toBe("mine");
  act(() => q('[data-id="approval:r1"] [data-action="approve"]').click());
  act(() => q('[data-id="approval:r2"] [data-action="deny"]').click());
  expect(calls).toEqual(["approve:r1", "deny:r2"]);
});

test("approval is a labelled group and submits once until the handler fails or the request resolves", async () => {
  const { store, send } = setup([
    { type: "approval_request", request_id: "r1", tool_call: { id: "t1", name: "bash", arguments: { command: "rm -rf dist" } }, delegated: false },
  ]);
  const calls: string[] = [];
  let fail: (error: Error) => void = () => {};
  mount(
    <RunProvider store={store}>
      <Approval
        id="approval:r1"
        onApprove={(id) => {
          calls.push(`approve:${id}`);
          return new Promise((_, reject) => (fail = reject));
        }}
        onDeny={(id) => void calls.push(`deny:${id}`)}
      />
    </RunProvider>,
  );
  const group = q('[data-part="approval"]');
  expect(group.getAttribute("role")).toBe("group");
  const label = document.getElementById(group.getAttribute("aria-labelledby")!)!;
  expect(label.getAttribute("data-part")).toBe("tool-header");
  expect(label.textContent).toBe("bashrm -rf distneeds approval");
  expect(q('[data-part="tool-body"] [data-part="tool-args"]').textContent).toContain('"command": "rm -rf dist"');
  expect([...group.querySelectorAll('[data-part="approval-actions"] button')].map((b) => b.textContent)).toEqual(["approve", "deny"]);

  act(() => q('[data-action="approve"]').click());
  act(() => q('[data-action="approve"]').click());
  act(() => q('[data-action="deny"]').click());
  expect(calls).toEqual(["approve:r1"]);
  expect(group.getAttribute("data-state")).toBe("submitting");
  expect(group.getAttribute("aria-busy")).toBe("true");
  expect(q('[data-part="tool-status"]').textContent).toBe("approving");
  expect(q('[data-action="deny"]').getAttribute("aria-disabled")).toBe("true");

  await act(async () => fail(new Error("offline")));
  expect(group.getAttribute("data-state")).toBe("pending");
  act(() => q('[data-action="deny"]').click());
  expect(calls).toEqual(["approve:r1", "deny:r1"]);

  send({ type: "approval_end", request_id: "r1" });
  expect(group.getAttribute("data-state")).toBe("done");
  expect(q('[data-part="tool-status"]').textContent).toBe("resolved");
  expect(group.querySelector("button")).toBeNull();
});

test("tool header shows name, a one-line summary, and status; json loads when expanded", () => {
  const big = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const grep = { id: "t1", name: "grep", arguments: { pattern: "TODO", path: "packages/" } };
  const empty = { id: "t2", name: "noop", arguments: {} };
  const { store } = setup([
    { type: "tool_start", tool_call: grep },
    { type: "tool_end", tool_call: grep, tool_result: { tool_call_id: "t1", content: big, is_error: false } },
    { type: "tool_start", tool_call: empty },
  ]);
  mount(
    <RunProvider store={store}>
      <ToolCall id="tool:t1" />
      <ToolCall id="tool:t2" />
    </RunProvider>,
  );
  const tool = q('[data-id="tool:t1"]') as HTMLDetailsElement;
  const header = tool.querySelector('[data-part="tool-header"]')!;
  expect(tool.tagName).toBe("DETAILS");
  expect(header.tagName).toBe("SUMMARY");
  expect([...header.children].map((el) => `${el.getAttribute("data-part")}=${el.textContent}`)).toEqual([
    "tool-name=grep",
    "tool-summary=TODO",
    "tool-status=done",
  ]);
  expect(header.textContent).not.toContain("{");
  expect(tool.open).toBe(false);
  expect(tool.querySelector('[data-part="tool-body"]')).toBeNull();
  act(() => {
    tool.open = true;
    tool.dispatchEvent(new Event("toggle"));
  });
  const body = tool.querySelector('[data-part="tool-body"]')!;
  expect(body.firstElementChild!.getAttribute("data-part")).toBe("tool-output");
  expect(body.querySelector('[data-part="tool-output"]')!.textContent).toBe(big);
  const args = body.querySelector('[data-part="tool-args-details"]') as HTMLDetailsElement;
  expect(args.open).toBe(false);
  expect(args.querySelector('[data-part="tool-args"]')).toBeNull();
  act(() => {
    args.open = true;
    args.dispatchEvent(new Event("toggle"));
  });
  expect(args.querySelector('[data-part="tool-args"]')!.textContent).toBe(JSON.stringify(grep.arguments, null, 2));
  expect(q('[data-id="tool:t2"] [data-part="tool-summary"]').textContent).toBe("");
});

test("tool opens by default while running, after failure, and for short output, and keeps the user's toggle", () => {
  const bash = call("t1", "bash");
  const { store, send } = setup([
    { type: "tool_start", tool_call: bash },
    { type: "tool_start", tool_call: call("t2", "bash") },
    { type: "tool_end", tool_call: call("t2", "bash"), tool_result: { tool_call_id: "t2", content: "x\n".repeat(50), is_error: true } },
    { type: "tool_start", tool_call: call("t3", "edit") },
    { type: "tool_end", tool_call: call("t3", "edit"), tool_result: { tool_call_id: "t3", content: "1 replacement", is_error: false } },
    { type: "tool_start", tool_call: call("t4", "bash") },
    { type: "tool_end", tool_call: call("t4", "bash"), tool_result: { tool_call_id: "t4", content: "", is_error: false } },
  ]);
  mount(
    <RunProvider store={store}>
      {["t1", "t2", "t3", "t4"].map((t) => <ToolCall key={t} id={`tool:${t}`} />)}
    </RunProvider>,
  );
  const open = (t: string) => (q(`[data-id="tool:${t}"]`) as HTMLDetailsElement).open;
  expect(["t1", "t2", "t3", "t4"].map(open)).toEqual([true, true, true, false]);
  act(() => ((q('[data-id="tool:t1"]') as HTMLDetailsElement).open = false));
  send({ type: "tool_output", tool_call: bash, output: "more\n" }, { type: "tool_end", tool_call: bash, tool_result: { tool_call_id: "t1", content: "", is_error: false } });
  expect(open("t1")).toBe(false);
});

test("canceled comes from the normalized item and wins over the error flag", () => {
  const bash = call("t1", "bash");
  const { store } = setup([
    { type: "tool_start", tool_call: bash },
    { type: "tool_end", tool_call: bash, tool_result: { tool_call_id: "t1", content: "canceled by user", is_error: true, is_canceled: true } },
  ]);
  mount(
    <RunProvider store={store}>
      <ToolCall id="tool:t1" />
    </RunProvider>,
  );
  expect(q('[data-part="tool"]').getAttribute("data-state")).toBe("canceled");
  expect(q('[data-part="tool-status"]').textContent).toBe("canceled");
});

test("tool output keeps the streamed text and appends a final result that adds to it", () => {
  const a = call("t1", "bash");
  const b = call("t2", "grep");
  const { store } = setup([
    { type: "tool_output", tool_call: a, output: "building..." },
    { type: "tool_end", tool_call: a, tool_result: { tool_call_id: "t1", content: "error: exited with code 1", is_error: true } },
    { type: "tool_output", tool_call: b, output: "x.ts:1\n" },
    { type: "tool_end", tool_call: b, tool_result: { tool_call_id: "t2", content: "x.ts:1\n", is_error: false } },
  ]);
  mount(
    <RunProvider store={store}>
      <ToolCall id="tool:t1" />
      <ToolCall id="tool:t2" />
    </RunProvider>,
  );
  expect(q('[data-id="tool:t1"] [data-part="tool-output"]').textContent).toBe("building...\nerror: exited with code 1");
  expect(q('[data-id="tool:t2"] [data-part="tool-output"]').textContent).toBe("x.ts:1\n");
});

test("a tool body gets the normalized item and renders inside the one shared header", () => {
  const ls = { id: "t1", name: "bash", arguments: { command: "ls", timeout: 5 } };
  const { store } = setup([
    { type: "tool_start", tool_call: ls, view: { kind: "shell", command: "ls -la" } },
    { type: "tool_output", tool_call: ls, output: "README.md\n" },
    { type: "approval_request", request_id: "r1", tool_call: { ...ls, id: "t2" }, view: { kind: "shell", command: "ls" }, delegated: false },
    { type: "approval_request", request_id: "r2", tool_call: { ...ls, id: "t3" }, delegated: false },
  ]);
  const seen: string[] = [];
  const Shell = ({ item, output, state }: ToolBodyProps) => {
    seen.push(`${item.tool_call.id}:${item.view?.kind}:${state}`);
    return <pre data-part="tool-output">{`${item.tool_call.arguments.command}|${output}`}</pre>;
  };
  mount(
    <RunProvider store={store}>
      <ToolCall id="tool:t1" body={Shell} />
      <Approval id="approval:r1" body={Shell} onApprove={() => {}} />
      <Approval id="approval:r2" summary={(item) => `run ${item.tool_call.arguments.command}`} />
    </RunProvider>,
  );
  const tool = q('[data-id="tool:t1"]');
  expect(tool.getAttribute("data-tool-view")).toBe("shell");
  // The view, not the raw arguments, names the call in the header.
  expect(tool.querySelector('[data-part="tool-summary"]')!.textContent).toBe("$ ls -la");
  expect(tool.querySelector('[data-part="tool-status"]')!.textContent).toBe("running");
  expect(tool.querySelector('[data-part="tool-body"]')!.textContent).toBe("ls|README.md\n");
  expect(tool.querySelector('[data-part="tool-args"]')).toBeNull();
  expect(tool.querySelectorAll('[data-part="tool-header"]').length).toBe(1);
  const approval = q('[data-id="approval:r1"]');
  expect(approval.getAttribute("data-tool-view")).toBe("shell");
  expect(approval.querySelector('[data-part="tool-summary"]')!.textContent).toBe("$ ls");
  expect(approval.querySelectorAll('[data-part="tool-header"]').length).toBe(1);
  const plain = q('[data-id="approval:r2"]');
  expect(plain.hasAttribute("data-tool-view")).toBe(false);
  expect(plain.querySelector('[data-part="tool-summary"]')!.textContent).toBe("run ls");
  expect(approval.querySelector('[data-part="tool-body"]')!.textContent).toBe("ls|");
  expect(approval.querySelector('[data-action="approve"]')).not.toBeNull();
  expect(seen).toEqual(["t1:shell:streaming", "t2:shell:pending"]);
});

test("the default header summary reads each view kind, then falls back to the first string argument", () => {
  const views = [
    [{ kind: "shell", command: "bun test" }, "$ bun test"],
    [{ kind: "read", path: "a.ts" }, "a.ts"],
    [{ kind: "read", path: "src/a.ts", range: { offset: 0, limit: 40 } }, "src/a.ts:1-40"],
    [{ kind: "read", path: "src/a.ts", range: { offset: 10 } }, "src/a.ts:11"],
    [{ kind: "edit", path: "b.ts", diff: "--- a/b.ts\n+++ b/b.ts\n@@ -1,2 +1,4 @@\n-a\n+b\n+c\n+d\n e" }, "b.ts +3 -1"],
    [{ kind: "write", path: "c.ts" }, "c.ts"],
    [{ kind: "write", path: "c.ts", content: "one\ntwo\n" }, "c.ts +2"],
    [{ kind: "search", pattern: "TODO", path: "packages/" }, '"TODO" packages/'],
    [{ kind: "search", pattern: "TODO" }, '"TODO"'],
    [{ kind: "fetch", url: "https://example.com/docs?q=1" }, "example.com/docs?q=1"],
    [{ kind: "fetch", query: "fulcrum" }, "fulcrum"],
    [undefined, "first"],
  ] as const;
  const { store } = setup(
    views.map(([view], i) => ({ type: "tool_start", tool_call: { id: `v${i}`, name: "x", arguments: { a: 1, b: "first" } }, view } as RunEvent)),
  );
  mount(<RunProvider store={store}>{views.map((_, i) => <ToolCall key={i} id={`tool:v${i}`} />)}</RunProvider>);
  expect(views.map((_, i) => q(`[data-id="tool:v${i}"] [data-part="tool-summary"]`).textContent)).toEqual(views.map(([, text]) => text));
});

test("the header status carries the view's duration next to the state word", () => {
  const ls = { id: "t1", name: "bash", arguments: { command: "ls" } };
  const { store } = setup([
    { type: "tool_start", tool_call: ls, view: { kind: "shell", command: "ls" } },
    { type: "tool_end", tool_call: ls, view: { kind: "shell", command: "ls", durationMs: 1250 }, tool_result: { tool_call_id: "t1", content: "", is_error: false } },
  ]);
  mount(<RunProvider store={store}><ToolCall id="tool:t1" /></RunProvider>);
  expect(q('[data-part="tool-status"]').firstChild!.textContent).toBe("done");
  expect(q('[data-part="tool-status"] [data-part="tool-duration"]').textContent).toBe("1.3 s");
});

test("data-state reflects streaming, done, error, pending", () => {
  const { store, send } = setup([
    { type: "message_delta", message_id: "m", delta: "hi" },
    { type: "tool_start", tool_call: call("t1", "bash") },
    { type: "approval_request", request_id: "r1", tool_call: call("t2", "bash"), delegated: false },
  ]);
  mount(
    <RunProvider store={store}>
      <Message id="message:m" />
      <ToolCall id="tool:t1" />
      <Approval id="approval:r1" />
    </RunProvider>,
  );
  const state = (part: string) => q(`[data-part="${part}"]`).getAttribute("data-state");
  expect([state("message"), state("tool"), state("approval")]).toEqual(["streaming", "streaming", "pending"]);
  expect(q('[data-part="message"]').style.whiteSpace).toBe("pre-wrap");

  send(
    { type: "message_commit", message_id: "m", message: message("hi") },
    {
      type: "tool_end",
      tool_call: call("t1", "bash"),
      tool_result: { tool_call_id: "t1", content: "boom", is_error: true },
    },
    { type: "approval_end", request_id: "r1" },
  );
  expect([state("message"), state("tool"), state("approval")]).toEqual(["done", "error", "done"]);
  expect(q('[data-part="tool"]').getAttribute("data-tool")).toBe("bash");
});

test("timeline selects virtual mode above 200 items and supports explicit modes", () => {
  const events = Array.from({ length: 201 }, (_, index): RunEvent => ({
    type: "message_commit",
    message_id: String(index),
    message: message(String(index)),
  }));
  const { store } = setup(events);

  mount(
    <RunProvider store={store}>
      <Timeline />
    </RunProvider>,
  );
  expect(q('[data-part="timeline"]').getAttribute("data-virtual")).toBe("true");

  act(() => root!.render(
    <RunProvider store={store}>
      <Timeline virtual={false} />
    </RunProvider>,
  ));
  expect(q('[data-part="timeline"]').getAttribute("data-virtual")).toBe("false");
  expect(container.querySelectorAll('[data-part="message"]')).toHaveLength(201);

  act(() => root!.render(
    <RunProvider store={store}>
      <Timeline virtual />
    </RunProvider>,
  ));
  expect(q('[data-part="timeline"]').getAttribute("data-virtual")).toBe("true");
  expect(container.querySelectorAll('[data-part="message"]').length).toBeLessThanOrEqual(200);
});

test("useVirtualList ignores a stale outline hint and resets when the outline owner changes", () => {
  const a = Array.from({ length: 201 }, (_, index) => ({ id: `a-${index}`, kind: "message" }));
  const b = Array.from({ length: 201 }, (_, index) => ({ id: `b-${index}`, kind: "message" }));
  const c = Array.from({ length: 201 }, (_, index) => ({ id: `c-${index}`, kind: "message" }));
  const Harness = ({ outline, owner }: { outline: typeof a; owner: object }) => {
    const list = useVirtualList(outline, { estimateSize: () => 20, outlineUpdate: { type: "append", count: outline.length }, resetKey: owner });
    return <div><div ref={list.timelineRef}>{list.snapshot.rows.map((row) => <div key={row.id} data-virtual-id={row.id} />)}</div></div>;
  };
  const ownerA = {};
  const ownerB = {};
  mount(<Harness outline={a} owner={ownerA} />);
  expect(() => act(() => root!.render(<Harness outline={b} owner={ownerA} />))).not.toThrow();
  expect(() => act(() => root!.render(<Harness outline={c} owner={ownerB} />))).not.toThrow();
});

test("virtual Timeline keeps its frame when a store is disposed, then replaces it mid-stream", () => {
  const a = setup(Array.from({ length: 201 }, (_, index): RunEvent => ({
    type: "message_commit",
    message_id: `a-${index}`,
    message: message(`a-${index}`),
  })));
  const b = setup(Array.from({ length: 200 }, (_, index): RunEvent => ({
    type: "message_commit",
    message_id: `b-${index}`,
    message: message(`b-${index}`),
  })));
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  mount(<RunProvider store={a.store}><Timeline virtual /></RunProvider>);

  act(() => a.store.dispose());
  expect(q("[data-virtual-id]").getAttribute("aria-setsize")).toBe("201");

  b.send({ type: "message_commit", message_id: "b-200", message: message("b-200") });
  expect(() => act(() => root!.render(<RunProvider store={b.store}><Timeline virtual /></RunProvider>))).not.toThrow();
  expect(q("[data-virtual-id]").getAttribute("aria-setsize")).toBe("201");
  if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
});

test("virtual Timeline resets and follows when its RunProvider store changes during a pending user scroll", () => {
  const makeItems = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => committedItem(`${prefix}-${index}`));
  const a = timelineStore(makeItems("a", 5_000), { type: "append", count: 5_000 });
  const b = timelineStore(makeItems("b", 100_000), { type: "append", count: 100_000 });
  const c = timelineStore(makeItems("c", 201), { type: "append", count: 201 });
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  const scrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
  const positions = new WeakMap<HTMLElement, number>();
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get() { return Number.parseFloat((this as HTMLElement).querySelector<HTMLElement>('[data-part="timeline"]')?.style.height ?? "0"); } });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() { return positions.get(this as HTMLElement) ?? 0; },
    set(value: number) { positions.set(this as HTMLElement, Math.min(value, Math.max(0, (this as HTMLElement).scrollHeight - (this as HTMLElement).clientHeight))); },
  });

  mount(<RunProvider store={a.store}><Timeline virtual /></RunProvider>);
  expect(q("[data-virtual-id]").getAttribute("aria-setsize")).toBe("5000");

  expect(() => act(() => root!.render(<RunProvider store={b.store}><Timeline virtual /></RunProvider>))).not.toThrow();
  expect(q("[data-virtual-id]").getAttribute("aria-setsize")).toBe("100000");
  container.scrollTop = 0;

  expect(() => act(() => root!.render(<RunProvider store={c.store}><Timeline virtual /></RunProvider>))).not.toThrow();
  act(() => container.dispatchEvent(new Event("scroll")));
  expect(q("[data-virtual-id]").getAttribute("aria-setsize")).toBe("201");
  expect(container.scrollTop).toBe(container.scrollHeight - container.clientHeight);
  expect(q('[data-part="timeline"]').getAttribute("data-unseen-count")).toBe("0");
  expect(container.querySelector('[data-part="jump-to-latest"]')).toBeNull();
  if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
  if (scrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
  if (scrollTop) Object.defineProperty(HTMLElement.prototype, "scrollTop", scrollTop);
});

test("react does not import @fulcrum/zeta", () => {
  const pending = [new URL("../src/", import.meta.url)];
  while (pending.length) {
    const dir = pending.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = new URL(entry.name, dir);
      if (entry.isDirectory()) pending.push(new URL(`${path.href}/`));
      else expect(readFileSync(path, "utf8")).not.toContain("@fulcrum/zeta");
    }
  }
  const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  expect(pkg).not.toContain("@fulcrum/zeta");
});

const committedItem = (id: string): RunItem => ({
  id: `message:${id}`,
  type: "message",
  message: message(id),
  version: 1,
  active: false,
});

const waitForAnnouncement = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 1_050));
});

test("announcement text describes only committed item-level activity", () => {
  expect(announcementForItem(committedItem("a"))).toBe("assistant replied");
  expect(announcementForItem({
    id: "tool:t",
    type: "tool",
    tool_call: call("t", "bash"),
    output: "",
    version: 1,
    active: false,
    is_error: true,
    canceled: false,
    result: { tool_call_id: "t", content: "exited with code 1", is_error: true },
  })).toBe("tool bash finished: exit 1");
  expect(announcementForItem({
    id: "approval:r",
    type: "approval",
    request: { type: "approval_request", request_id: "r", tool_call: call("t", "bash"), delegated: false },
  })).toBe("approval needed: bash");
  expect(announcementForItem({ ...committedItem("streaming"), active: true })).toBeNull();
});

test("virtual history mount, scroll, and prepend never enter the live region", () => {
  const current = Array.from({ length: 5_000 }, (_, index) => committedItem(String(index)));
  const history = Array.from({ length: 500 }, (_, index) => committedItem(`history-${index}`));
  const source = timelineStore(current);
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  mount(<RunProvider store={source.store}><Timeline virtual /></RunProvider>);
  const timeline = q('[data-part="timeline"]');
  const live = q('[data-part="timeline-live"]');
  expect(timeline.getAttribute("role")).toBe("log");
  expect(timeline.getAttribute("aria-label")).toBe("agent activity");
  expect(timeline.getAttribute("aria-live")).toBe("off");
  expect(live.textContent).toBe("");
  act(() => {
    container.scrollTop = 20_000;
    container.dispatchEvent(new Event("scroll"));
  });
  expect(live.textContent).toBe("");
  source.replace([...history, ...current], { type: "prepend", count: history.length });
  expect(live.textContent).toBe("");
  const row = q("[data-virtual-id]");
  expect(row.getAttribute("aria-setsize")).toBe("5500");
  expect(Number(row.getAttribute("aria-posinset"))).toBeGreaterThan(0);
  if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
});

test("a streamed message announces once after commit", async () => {
  const { store, send } = setup([]);
  mount(<RunProvider store={store}><Timeline virtual /></RunProvider>);
  const live = q('[data-part="timeline-live"]');
  send({ type: "message_delta", message_id: "stream", delta: "hello" });
  expect(live.textContent).toBe("");
  send({ type: "message_commit", message_id: "stream", message: message("hello") });
  expect(live.textContent).toBe("");
  await waitForAnnouncement();
  expect(live.textContent).toBe("assistant replied");
});

test("a burst of ten appends produces one coalesced announcement", async () => {
  const { store, send } = setup([]);
  mount(<RunProvider store={store}><Timeline virtual /></RunProvider>);
  send(...Array.from({ length: 10 }, (_, index): RunEvent => ({
    type: "message_commit",
    message_id: String(index),
    message: message(String(index)),
  })));
  expect(q('[data-part="timeline-live"]').textContent).toBe("");
  await waitForAnnouncement();
  expect(q('[data-part="timeline-live"]').textContent).toBe("10 new items");
});

test("a blank tool name renders a readable fallback label", () => {
  const blank = { id: "b1", name: "  ", arguments: {} };
  const { store } = setup([{ type: "tool_start", tool_call: blank }]);
  mount(
    <RunProvider store={store}>
      <ToolCall id="tool:b1" />
    </RunProvider>,
  );
  const name = q('[data-id="tool:b1"] [data-part="tool-name"]');
  expect(name.textContent).toBe("unnamed tool");
  expect(name.getAttribute("data-blank")).toBe("");
});
