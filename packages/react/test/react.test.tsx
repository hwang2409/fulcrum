import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { act, Profiler, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRunStore, type RunEvent } from "@fulcrum/core";
import { Markdown } from "../../markdown/src/react.js";
import {
  Approval,
  Message,
  RunProvider,
  Timeline,
  ToolCall,
  useItem,
  useRun,
  useTimeline,
  type Renderers,
} from "../src/index.js";

afterAll(() => GlobalRegistrator.unregister());

const message = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const call = (id: string, name: string) => ({ id, name, arguments: {} });

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

test("highlighting passes stable identity, versions, and grammar state for new complete lines only", async () => {
  type Context = { id: string; version: number; state?: unknown };
  type Result = { tokens: Array<{ type?: "keyword"; content: string }>; state: string };
  const calls: Array<{ code: string; language: string | undefined; context: Context | undefined }> = [];
  const resolves: Array<(result: Result) => void> = [];
  const highlight = (code: string, language: string | undefined, context?: Context) => {
    calls.push({ code, language, context });
    return new Promise<Result>((resolve) => resolves.push(resolve));
  };
  mount(<Markdown id="message:one" source={"```ts\na\n"} streaming highlight={highlight} />);
  act(() => root!.render(<Markdown id="message:one" source={"```ts\na\nb\npartial"} streaming highlight={highlight} />));
  expect(calls).toEqual([{ code: "a\n", language: "ts", context: { id: "message:one:0", version: 1, state: undefined } }]);

  await act(async () => {
    resolves.shift()!({ tokens: [{ type: "keyword", content: "a\n" }], state: "after-a" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(calls[1]).toEqual({ code: "b\n", language: "ts", context: { id: "message:one:0", version: 2, state: "after-a" } });

  await act(async () => {
    resolves.shift()!({ tokens: [{ content: "b\n" }], state: "after-b" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  act(() => root!.render(<Markdown id="message:one" source={"```ts\na\nb\npartial"} highlight={highlight} />));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(calls[2]).toEqual({ code: "partial", language: "ts", context: { id: "message:one:0", version: 3, state: "after-b" } });

  await act(async () => {
    resolves.shift()!({ tokens: [{ type: "keyword", content: "partial" }], state: "done" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  act(() => root!.render(<Markdown id="message:one" source={"```ts\na\nb\npartial"} highlight={highlight} />));
  expect(calls).toHaveLength(3);
  expect(container.querySelectorAll(".tok-keyword")).toHaveLength(2);
  expect(container.textContent).toBe("a\nb\npartial");
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

test("dispose publishes the terminal snapshot to mounted hooks", () => {
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
  expect(container.textContent).toBe("0:none");
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

test("approval calls onApprove and onDeny with the request id", () => {
  const { store } = setup([
    { type: "approval_request", request_id: "r1", tool_call: call("t1", "bash"), delegated: false },
  ]);
  const calls: string[] = [];
  mount(
    <RunProvider store={store}>
      <Approval
        id="approval:r1"
        className="mine"
        onApprove={(id) => calls.push(`approve:${id}`)}
        onDeny={(id) => calls.push(`deny:${id}`)}
      />
    </RunProvider>,
  );
  expect(q('[data-part="approval"]').className).toBe("mine");
  act(() => q('[data-action="approve"]').click());
  act(() => q('[data-action="deny"]').click());
  expect(calls).toEqual(["approve:r1", "deny:r1"]);
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

test("react does not import @fulcrum/zeta", () => {
  const dir = new URL("../src/", import.meta.url);
  for (const name of readdirSync(dir))
    expect(readFileSync(new URL(name, dir), "utf8")).not.toContain("@fulcrum/zeta");
  const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  expect(pkg).not.toContain("@fulcrum/zeta");
});
