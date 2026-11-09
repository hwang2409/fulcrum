import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { act, Profiler, StrictMode, useState, type ComponentType, type ReactNode } from "react";
import * as FulcrumReact from "../src/index.js";
import { createRoot, type Root } from "react-dom/client";
import { createRunStore, initialState, type OutlineSnapshot, type RunEvent, type RunItem, type ToolCall as ToolCallData } from "@fulcrum/core";
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

function timelineStore(initialItems: RunItem[]) {
  let items = initialItems;
  let snapshot: OutlineSnapshot = { items: items.map(({ id, type: kind }) => ({ id, kind })), change: null };
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
    /** Publishes `next` as `splices` from the current outline (null: no edits, a whole new outline). */
    replace(next: RunItem[], splices: { index: number; deleteCount: number; items: RunItem[] }[] | null) {
      items = next;
      for (const item of items) entities.set(item.id, item);
      const entry = ({ id, type: kind }: RunItem) => ({ id, kind });
      snapshot = { items: items.map(entry), change: splices && { from: snapshot.items, splices: splices.map((splice) => ({ ...splice, items: splice.items.map(entry) })) } };
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

test("a desynced timeline keeps its rows, offers retry, and recovers after resync", () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  store.dispatch({ type: "user_message", text: "last good", mode: "send", delivery_id: "good" });
  jobs.shift()!();
  let retries = 0;
  const view = () => <RunProvider store={store} onRetry={() => retries++}><Timeline virtual={false} /></RunProvider>;
  mount(view());

  let reads = 0;
  store.dispatch(new Proxy({ type: "retry" }, {
    get(target, key, receiver) {
      if (key === "type" && ++reads > 3) throw new Error("history reload failed");
      return Reflect.get(target, key, receiver);
    },
  }) as RunEvent);
  act(() => jobs.shift()!());
  act(() => store.resyncFailed(new Error("history reload failed")));
  act(() => root!.render(view()));

  expect(container.textContent).toContain("last good");
  expect(container.textContent).toContain("could not resync");
  const retry = q('[data-part="resync-retry"]');
  expect(retry.textContent).toBe("retry");
  act(() => retry.click());
  expect(retries).toBe(1);

  act(() => store.resync([{ type: "user_message", text: "recovered", mode: "send", delivery_id: "recovered" }]));
  expect(container.textContent).toContain("recovered");
  expect(container.textContent).not.toContain("resyncing…");
});

test("highlighting passes cumulative source with stable identity and monotonic versions", async () => {
  type Context = { id: string; version: number; state: "streaming" | "done" };
  type Token = { type?: "keyword"; text: string };
  const calls: Array<{ code: string; language: string | undefined; context: Context | undefined }> = [];
  const resolves: Array<(result: Token[]) => void> = [];
  const highlight = Object.assign((code: string, language: string | undefined, context?: Context) => {
    calls.push({ code, language, context });
    return new Promise<Token[]>((resolve) => resolves.push(resolve));
  }, { dispose() {}, subscribe: () => () => {} });
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
  const highlight = Object.assign(() => new Promise<Array<{ text: string; type?: "keyword" }>>((done) => { resolve = done; }), { dispose() {}, subscribe: () => () => {} });
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
  expect(q('[data-id="message:user"] [data-part="message-content"]').textContent).toBe("use `plain`");
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

test("a timeline row uses one keyed subscription and ignores output deltas", () => {
  const { store, send } = setup(Array.from({ length: 200 }, (_, index) => ({
    type: "message_commit" as const,
    message_id: `row-${index}`,
    message: message("one"),
  })));
  const subscriptions = new Map<string, number>();
  const instrumented: RunStore = {
    getState: store.getState,
    getItem: store.getItem,
    getOutline: store.getOutline,
    getOutlineSnapshot: store.getOutlineSnapshot,
    subscribe(first: string | (() => void), second?: () => void) {
      if (typeof first === "string") subscriptions.set(first, (subscriptions.get(first) ?? 0) + 1);
      return store.subscribe(first as string & (() => void), second);
    },
    subscribeOutline: store.subscribeOutline,
  };
  let renders = 0;
  const Renderer = () => { renders++; return <span data-part="row-renderer" />; };
  mount(<RunProvider store={instrumented}><Timeline virtual={false} renderers={{ message: Renderer }} /></RunProvider>);
  expect(subscriptions.size).toBe(200);
  expect([...subscriptions.values()].every((count) => count === 1)).toBe(true);
  const before = renders;
  for (let i = 0; i < 100; i++) send({ type: "message_delta", message_id: "row-0", delta: "x" });
  expect(renders).toBe(before);
});

test("a row switches its renderer when the tool name changes", () => {
  const { store, send } = setup([
    { type: "tool_start", tool_call: { id: "row", name: "bash", arguments: {} } },
  ]);
  const names: string[] = [];
  const renderers: Renderers = {
    "tool:bash": () => { names.push("bash"); return <span />; },
    "tool:cat": () => { names.push("cat"); return <span />; },
  };
  mount(<RunProvider store={store}><Timeline virtual={false} renderers={renderers} /></RunProvider>);
  send({ type: "tool_start", tool_call: { id: "row", name: "cat", arguments: {} } });
  expect(names).toEqual(["bash", "cat"]);
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

// The streaming cursor (styles.css) shows only on a message with data-latest: it streams as its Timeline's newest row.
const latest = () => [...container.querySelectorAll<HTMLElement>('[data-part="message"][data-latest]')].map((node) => node.dataset.id);

test("only the newest row streams the cursor: text that a tool row follows stops, with the default plain renderer", () => {
  const { store, send: more } = setup([{ type: "message_delta", message_id: "m", delta: "I'll inspect the project." }]);
  mount(<RunProvider store={store}><Timeline virtual={false} /></RunProvider>);
  expect(latest()).toEqual(["message:m"]);
  more({ type: "tool_start", tool_call: call("ls", "shell") });
  expect(q('[data-part="message"]').dataset.state).toBe("streaming");
  expect(latest()).toEqual([]);
  more({ type: "message_delta", message_id: "n", delta: "Two folders." });
  expect(latest()).toEqual(["message:n"]);
});

test("a notification or an unknown event that lands mid-stream never takes the cursor from the streaming message", () => {
  const { store, send: more } = setup([{ type: "message_delta", message_id: "m", delta: "Reading the files now" }]);
  const commits: Record<string, number> = {};
  const renderers: Renderers = { message: ({ id }) => <Profiler id={id} onRender={() => (commits[id] = (commits[id] ?? 0) + 1)}><Message id={id} /></Profiler> };
  mount(<RunProvider store={store}><Timeline virtual={false} renderers={renderers} /></RunProvider>);
  const before = commits["message:m"];
  more({ type: "notification", notification_id: "bg-1", data: { message: "background task finished" } });
  more({ type: "unknown", name: "some_future_event", data: {} });
  expect(latest()).toEqual(["message:m"]);
  // Neither passive row is the newest streamable row, so the message is not even told about them.
  expect(commits["message:m"]).toBe(before);
  more({ type: "message_delta", message_id: "m", delta: " and summarising" });
  expect(latest()).toEqual(["message:m"]);
  // The next thing the agent does (a tool) still takes it.
  more({ type: "tool_start", tool_call: call("ls", "shell") });
  expect(latest()).toEqual([]);
});

test("a pipe row the model already sent shows while a tool runs below its uncommitted message, and at the end", () => {
  const { store, send: more } = setup([{ type: "message_delta", message_id: "m", delta: "Results:\n\n| a | b |\n" }]);
  mount(<RunProvider store={store}><Timeline virtual={false} renderers={{ message: ({ id }) => <Message id={id} markdown={Markdown} /> }} /></RunProvider>);
  const shown = () => q('[data-part="message"]').textContent;
  // A stall on the row: it shows as sent, pipes kept.
  expect(shown()).toContain("| a | b |");
  // A tool starts before any commit: the message stays streaming above it, and the row still shows.
  more({ type: "tool_start", tool_call: call("ls", "shell") });
  expect(q('[data-part="message"]').dataset.state).toBe("streaming");
  expect(shown()).toContain("| a | b |");
  // The turn ends without a commit: the finished parse shows the lone row as text.
  more({ type: "turn_end" });
  expect(shown()).toContain("| a | b |");
});

for (const [name, end] of [
  ["a commit", { type: "message_commit", message_id: "m", message: message("| a | b |") }],
  ["turn_end", { type: "turn_end" }],
] as const) {
  test(`a message that ends on a lone pipe row (${name}) shows it`, () => {
    const { store, send: more } = setup([{ type: "message_delta", message_id: "m", delta: "| a | b |" }]);
    mount(<RunProvider store={store}><Message id="message:m" markdown={Markdown} /></RunProvider>);
    expect(q('[data-part="message"]').textContent).toBe("| a | b |");
    more(end as RunEvent);
    expect(q('[data-part="message"]').dataset.state).not.toBe("streaming");
    expect(q('[data-part="message"]').textContent).toBe("| a | b |");
  });
}

test("Markdown that stops streaming on a pipe row shows it, raw or as the table its delimiter makes", () => {
  mount(<Markdown source={"Results:\n\n| a | b |"} streaming />);
  expect(container.textContent).toContain("| a | b |");
  act(() => root!.render(<Markdown source={"Results:\n\n| a | b |"} />));
  expect(container.textContent).toContain("| a | b |");
  act(() => root!.render(<Markdown source={"Results:\n\n| a | b |\n| - | - |"} streaming />));
  act(() => root!.render(<Markdown source={"Results:\n\n| a | b |\n| - | - |"} />));
  expect([...container.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(["a", "b"]);
});

test("a streaming message outside a Timeline is the newest row", () => {
  const { store } = setup([{ type: "message_delta", message_id: "m", delta: "hello" }]);
  mount(<RunProvider store={store}><Message id="message:m" /></RunProvider>);
  expect(latest()).toEqual(["message:m"]);
});

test("when a row appends, only the old and the new newest rows re-render", () => {
  const { store, send } = setup([
    ...Array.from({ length: 50 }, (_, index): RunEvent => ({ type: "message_commit", message_id: `done-${index}`, message: message("one") })),
    { type: "message_delta", message_id: "s", delta: "x" },
  ]);
  const commits: Record<string, number> = {};
  const Counted = ({ id }: { id: string }) => (
    <Profiler id={id} onRender={() => (commits[id] = (commits[id] ?? 0) + 1)}>
      <Message id={id} />
    </Profiler>
  );
  const renderers: Renderers = { message: Counted };
  mount(<RunProvider store={store}><Timeline virtual={false} renderers={renderers} /></RunProvider>);
  const rendered = (act: () => void) => {
    const before = { ...commits };
    act();
    return Object.fromEntries(Object.entries(commits).filter(([id, count]) => count !== before[id]).map(([id, count]) => [id, count - (before[id] ?? 0)]));
  };
  expect(latest()).toEqual(["message:s"]);
  // A new streaming row: the old newest row loses the cursor, the new one mounts and takes it. No other row renders.
  const appended = rendered(() => send({ type: "message_delta", message_id: "t", delta: "y" }));
  expect(Object.keys(appended).sort()).toEqual(["message:s", "message:t"]);
  expect(latest()).toEqual(["message:t"]);
  // A tool row: only the message that loses the cursor renders.
  expect(rendered(() => send({ type: "tool_start", tool_call: call("ls", "shell") }))).toEqual({ "message:t": 1 });
  expect(latest()).toEqual([]);
  // Deltas still re-render only their own row.
  expect(rendered(() => send({ type: "message_delta", message_id: "t", delta: "z" }))).toEqual({ "message:t": 1 });
});

test("in virtual mode a row kept mounted for focus never takes the cursor from the newest row", () => {
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  const scrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
  const positions = new WeakMap<HTMLElement, number>();
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => Number.parseFloat(document.querySelector<HTMLElement>('[data-part="timeline"]')?.style.height ?? "0") });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() { return positions.get(this as HTMLElement) ?? 0; },
    set(value: number) { positions.set(this as HTMLElement, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))); },
  });
  try {
    const { store, send } = setup([
      ...Array.from({ length: 300 }, (_, index): RunEvent => ({ type: "message_commit", message_id: String(index), message: message(String(index)) })),
      { type: "message_delta", message_id: "live", delta: "streaming" },
    ]);
    mount(<RunProvider store={store}><Timeline virtual /></RunProvider>);
    const host = q('[data-part="timeline-scroll"]');
    const scrollTo = (top: number) => {
      host.scrollTop = top;
      act(() => {
        host.dispatchEvent(new WheelEvent("wheel", { deltaY: top === 0 ? -100 : 100 }));
        host.dispatchEvent(new Event("scroll"));
      });
    };
    scrollTo(0);
    // The reader clicks an older message: its row takes focus.
    const older = q('[data-virtual-id="message:2"]');
    act(() => older.focus());
    scrollTo(host.scrollHeight);
    const rows = [...q('[data-part="timeline"]').querySelectorAll<HTMLElement>(":scope > [data-virtual-id]")];
    expect(rows.at(-1)?.dataset.virtualId).toBe("message:2");
    expect(rows.at(-1)?.tabIndex).toBe(-1);
    expect(rows.some((row) => row.dataset.virtualId === "message:live")).toBe(true);
    expect(latest()).toEqual(["message:live"]);
    send({ type: "message_delta", message_id: "live", delta: " more" });
    expect(latest()).toEqual(["message:live"]);
  } finally {
    for (const [name, descriptor] of [["clientHeight", clientHeight], ["scrollHeight", scrollHeight], ["scrollTop", scrollTop]] as const) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  }
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

test("run status and the compact end marker expose an unknown outcome accessibly", () => {
  const { store, send } = setup([
    { type: "run_start" },
    { type: "run_end", outcome: "unknown" } as RunEvent,
  ]);
  const exports = FulcrumReact as unknown as Record<string, ComponentType>;
  const Status = exports.RunStatus ?? (() => null);
  const EndMarker = exports.RunEndMarker ?? (() => null);
  mount(<RunProvider store={store}><Status /><EndMarker /></RunProvider>);

  expect(container.textContent).toContain("outcome unknown");
  expect(q('[data-part="run-status"]').textContent).toBe("outcome unknown");
  const marker = q('[data-part="run-end-marker"]');
  expect(marker.textContent).toContain("outcome unknown");
  expect(marker.getAttribute("role")).toBe("status");
  expect(marker.getAttribute("aria-label")).toBe("run ended while disconnected; outcome unknown");

  send({ type: "run_start" });
  expect(container.querySelector('[data-part="run-end-marker"]')).toBeNull();
  expect(q('[data-part="run-status"]').textContent).toBe("running");

  // A reported outcome shows as plain marker text; the header reads idle.
  send({ type: "run_end", outcome: "cancelled" } as RunEvent);
  expect(q('[data-part="run-end-marker"]').textContent).toBe("run stopped");
  expect(q('[data-part="run-end-marker"]').dataset.outcome).toBe("cancelled");
  expect(q('[data-part="run-status"]').textContent).toBe("idle");
});

test("run status does not rescan approvals for unrelated streaming updates", () => {
  const { store, send } = setup([
    { type: "run_start" },
    { type: "approval_request", request_id: "p", tool_call: call("t", "bash"), delegated: false },
  ]);
  let reads = 0;
  const originalGetItem = store.getItem;
  store.getItem = (id) => { reads++; return originalGetItem(id); };
  mount(<RunProvider store={store}><FulcrumReact.RunStatus /><FulcrumReact.RunEndMarker /></RunProvider>);
  expect(q('[data-part="run-status"]').dataset.status).toBe("approval");
  reads = 0;

  for (let index = 0; index < 100; index++)
    send({ type: "usage", usage: { input_tokens: index + 1 } });
  expect(reads).toBeLessThan(10);

  send({ type: "approval_end", request_id: "p", decision: "deny" });
  expect(q('[data-part="run-status"]').dataset.status).toBe("running");
  send({ type: "run_end", outcome: "completed" } as RunEvent);
  expect(q('[data-part="run-end-marker"]').textContent).toBe("run completed");
  expect(q('[data-part="run-status"]').dataset.status).toBe("idle");
});

test("run status clears an approval that ends after the header re-renders", () => {
  const { store, send } = setup([
    { type: "run_start" },
    { type: "approval_request", request_id: "p", tool_call: call("t", "bash"), delegated: false },
  ]);
  const view = (n: number) => <RunProvider store={store}><span data-n={n} /><FulcrumReact.RunStatus /></RunProvider>;
  mount(view(1));
  expect(q('[data-part="run-status"]').dataset.status).toBe("approval");
  // A host re-render that leaves toolApprovals unchanged must not strand the status on a stale snapshot.
  act(() => root!.render(view(2)));
  // Live order: approval_end arrives before the tool row exists, so toolApprovals does not change.
  send({ type: "approval_end", request_id: "p", decision: "deny" });
  expect(q('[data-part="run-status"]').dataset.status).toBe("running");
});

test("run status clears an approval that ends after its tool starts", () => {
  const { store, send } = setup([
    { type: "run_start" },
    { type: "approval_request", request_id: "p", tool_call: call("t", "bash"), delegated: false },
  ]);
  const view = (n: number) => <RunProvider store={store}><span data-n={n} /><FulcrumReact.RunStatus /></RunProvider>;
  mount(view(1));
  send({ type: "tool_start", tool_call: call("t", "bash") });
  expect(q('[data-part="run-status"]').dataset.status).toBe("approval");
  act(() => root!.render(view(2)));
  send({ type: "approval_end", request_id: "p", decision: "allow" });
  expect(q('[data-part="run-status"]').dataset.status).toBe("running");
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
  expect(items[1]!.querySelector('[data-part="message-prompt"]')?.getAttribute("aria-hidden")).toBe("true");
  expect(items[1]!.querySelector('[data-part="message-content"]')?.textContent).toBe("hi there");
});

test("a pending approval exposes adapter-supplied reconnect and resolving states", () => {
  const store = createRunStore((flush) => flush());
  store.dispatch({
    type: "approval_request", request_id: "r1", delegated: false,
    tool_call: { id: "t1", name: "bash", arguments: { command: "echo ok" } },
    state: "reconnecting", status: "reconnecting…", disabled_reason: "decisions are disabled while disconnected",
  } as RunEvent);
  const root = mount(<RunProvider store={store}><Approval id="approval:r1" onApprove={() => {}} onDeny={() => {}} /></RunProvider>);
  const card = root.querySelector('[data-part="approval"]')!;
  expect(card.getAttribute("data-state")).toBe("reconnecting");
  expect(card.textContent).toContain("reconnecting…");
  expect(card.textContent).toContain("decisions are disabled while disconnected");
  expect([...card.querySelectorAll("button")].every((button) => button.getAttribute("aria-disabled") === "true")).toBe(true);

  act(() => store.dispatch({
    type: "approval_request", request_id: "r1", delegated: false,
    tool_call: { id: "t1", name: "bash", arguments: { command: "echo ok" } },
    state: "resolving", status: "resolving…", disabled_reason: "the server is saving this decision",
  } as RunEvent));
  expect(card.getAttribute("data-state")).toBe("resolving");
  expect(card.textContent).toContain("resolving…");
});

test("an unavailable approval's actions stay in the tab order, are described by the visible reason, and do nothing", async () => {
  const reason = "opening another session — decisions are paused";
  const store = createRunStore((flush) => flush());
  store.dispatch({ type: "approval_request", request_id: "r1", tool_call: call("t1", "bash"), delegated: false });
  const calls: string[] = [];
  const renderers: Renderers = { approval: ({ id }) => <Approval id={id} onApprove={() => void calls.push("approve")} onApproveAlways={() => void calls.push("always")} onDeny={() => void calls.push("deny")} disabledReason={reason} /> };
  mount(<RunProvider store={store}><Timeline renderers={renderers} /></RunProvider>);
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('[data-part="approval-actions"] button')];
  expect(buttons.map((button) => button.dataset.action)).toEqual(["approve", "approve-always", "deny"]);
  for (const button of buttons) {
    // A disabled button leaves the tab order, so a keyboard user never hears why it is unavailable.
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    const described = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe(reason);
    expect(described?.getAttribute("role")).toBe("status");
    act(() => {
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      button.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      button.click();
    });
  }
  expect(calls).toEqual([]);
  expect(container.querySelector('[data-part="approval"]')!.getAttribute("data-state")).toBe("pending");
  // The skip link never lands on an action that cannot act: it focuses the row instead.
  await act(async () => q('[data-part="jump-to-approval"]').click());
  expect(document.activeElement).toBe(q('[data-part="approval"]'));
});

test("a reconnect keeps focus in the pending approval row", () => {
  const store = createRunStore((flush) => flush());
  store.dispatch({ type: "approval_request", request_id: "r1", tool_call: call("t1", "bash"), delegated: false });
  const root = mount(<RunProvider store={store}><Approval id="approval:r1" onApprove={() => {}} onDeny={() => {}} /></RunProvider>);
  const card = root.querySelector<HTMLElement>('[data-part="approval"]')!;
  const approve = root.querySelector<HTMLButtonElement>('[data-action="approve"]')!;
  approve.focus();
  expect(document.activeElement).toBe(approve);

  act(() => store.dispatch({
    type: "approval_request", request_id: "r1", delegated: false,
    tool_call: call("t1", "bash"), state: "reconnecting", status: "reconnecting…",
    disabled_reason: "decisions are disabled while disconnected",
  } as RunEvent));

  expect(document.activeElement).toBe(card);
  expect(card.contains(document.activeElement)).toBe(true);
  expect([...card.querySelectorAll('[data-part="approval-actions"] button')].every((button) => button.getAttribute("aria-disabled") === "true")).toBe(true);
  expect(card.textContent).toContain("decisions are disabled while disconnected");

  act(() => store.dispatch({ type: "approval_request", request_id: "r1", tool_call: call("t1", "bash"), delegated: false }));
  expect(document.activeElement).toBe(card);
});

test("a rejected late decision shows its adapter-supplied message and re-enables the actions", async () => {
  const store = createRunStore((flush) => flush());
  store.dispatch({ type: "approval_request", request_id: "r1", tool_call: { id: "t1", name: "bash", arguments: {} }, delegated: false });
  const root = mount(<RunProvider store={store}><Approval id="approval:r1" onApprove={() => Promise.reject(new Error("this approval expired while you were disconnected"))} /></RunProvider>);
  act(() => root.querySelector<HTMLButtonElement>('button[data-action="approve"]')!.click());
  await act(async () => { await Promise.resolve(); });
  expect(root.querySelector('[role="alert"]')?.textContent).toBe("this approval expired while you were disconnected");
  expect(root.querySelector<HTMLButtonElement>('button[data-action="approve"]')!.getAttribute("aria-disabled")).toBeNull();
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
  expect(q('[data-part="tool-status"]').textContent).toBe("ended");
  expect(group.querySelector("button")).toBeNull();
});

test("an approval without onApproveAlways renders exactly the approve and deny actions it always had", () => {
  const { store } = setup([{ type: "approval_request", request_id: "r1", tool_call: call("t1", "bash"), delegated: false }]);
  mount(<RunProvider store={store}><Approval id="approval:r1" approveAlwaysLabel="always allow bash" onApprove={() => {}} onDeny={() => {}} /></RunProvider>);
  // The markup origin/main renders: a label alone offers nothing, so existing callers see no change.
  expect(q('[data-part="approval-actions"]').outerHTML).toBe('<div data-part="approval-actions"><button type="button" data-action="approve">approve</button><button type="button" data-action="deny">deny</button></div>');
});

test("onApproveAlways adds a third action that decides like approve: once, busy, and retryable", async () => {
  const { store, send } = setup([{ type: "approval_request", request_id: "r1", tool_call: call("t1", "bash"), delegated: false }]);
  const calls: string[] = [];
  let fail: (error: Error) => void = () => {};
  mount(
    <RunProvider store={store}>
      <Approval
        id="approval:r1"
        onApprove={(id) => void calls.push(`approve:${id}`)}
        onApproveAlways={(id) => {
          calls.push(`always:${id}`);
          return new Promise((_, reject) => (fail = reject));
        }}
        onDeny={(id) => void calls.push(`deny:${id}`)}
      />
    </RunProvider>,
  );
  const group = q('[data-part="approval"]');
  const buttons = () => [...group.querySelectorAll<HTMLButtonElement>('[data-part="approval-actions"] button')];
  expect(buttons().map((b) => [b.dataset.action, b.textContent])).toEqual([["approve", "approve"], ["approve-always", "always allow"], ["deny", "deny"]]);

  const always = q('[data-action="approve-always"]');
  act(() => always.focus());
  act(() => always.click());
  act(() => always.click());
  act(() => q('[data-action="approve"]').click());
  expect(calls).toEqual(["always:r1"]);
  expect(group.getAttribute("data-state")).toBe("submitting");
  expect(q('[data-part="tool-status"]').textContent).toBe("approving");
  // In flight every action is aria-disabled, not disabled, so the keyboard user's focus stays on the pressed button.
  expect(buttons().map((b) => [b.disabled, b.getAttribute("aria-disabled")])).toEqual([[false, "true"], [false, "true"], [false, "true"]]);
  expect(document.activeElement).toBe(always);

  await act(async () => fail(new Error("offline")));
  expect(q('[role="alert"]').textContent).toBe("offline");
  expect(group.getAttribute("data-state")).toBe("pending");
  expect(always.getAttribute("aria-disabled")).toBeNull();

  send({ type: "approval_end", request_id: "r1", decision: "approve" });
  expect(q('[data-part="tool-status"]').textContent).toBe("approved");
  expect(group.querySelector("button")).toBeNull();
});

test("the approve-always action takes the host's label and is disabled with the others while decisions are unavailable", () => {
  const { store, send } = setup([{ type: "approval_request", request_id: "r1", tool_call: call("t1", "bash"), delegated: false }]);
  const calls: string[] = [];
  mount(<RunProvider store={store}><Approval id="approval:r1" onApprove={() => {}} onApproveAlways={(id) => void calls.push(id)} approveAlwaysLabel="allow bash for this session" /></RunProvider>);
  expect(q('[data-action="approve-always"]').textContent).toBe("allow bash for this session");
  send({
    type: "approval_request", request_id: "r1", delegated: false, tool_call: call("t1", "bash"),
    state: "reconnecting", status: "reconnecting…", disabled_reason: "decisions are disabled while disconnected",
  } as RunEvent);
  const always = q('[data-action="approve-always"]') as HTMLButtonElement;
  expect(always.getAttribute("aria-disabled")).toBe("true");
  act(() => always.click());
  expect(calls).toEqual([]);
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
  expect(q('[data-part="timeline"]').parentElement?.dataset.part).toBe("timeline-scroll");
  expect(q('[data-part="jump-to-latest-lane"]')).toBeTruthy();

  act(() => root!.render(
    <RunProvider store={store}>
      <Timeline virtual={false} />
    </RunProvider>,
  ));
  expect(q('[data-part="timeline"]').getAttribute("data-virtual")).toBe("false");
  expect(container.querySelectorAll('[data-part="message"]')).toHaveLength(201);
  expect(container.querySelector('[data-part="jump-to-latest-lane"]')).toBeNull();

  act(() => root!.render(
    <RunProvider store={store}>
      <Timeline virtual />
    </RunProvider>,
  ));
  expect(q('[data-part="timeline"]').getAttribute("data-virtual")).toBe("true");
  expect(container.querySelectorAll('[data-part="message"]').length).toBeLessThanOrEqual(200);

});

test("host-owned Timeline uses the supplied scroll element without replacing its ref", () => {
  const { store } = setup(Array.from({ length: 300 }, (_, index): RunEvent => ({
    type: "message_commit",
    message_id: String(index),
    message: message(String(index)),
  })));
  const scrollRef = { current: null as HTMLElement | null };
  mount(
    <div ref={scrollRef} data-testid="host-scroll">
      <RunProvider store={store}>
        <Timeline virtual scrollRef={scrollRef} renderJumpToLatest={(control) => <aside>{control}</aside>} />
      </RunProvider>
    </div>,
  );
  expect(scrollRef.current?.dataset.testid).toBe("host-scroll");
  expect(q('[data-part="timeline"]').parentElement).toBe(scrollRef.current);
  expect(container.querySelector('[data-part="timeline-frame"]')).toBeNull();
  expect(container.querySelector('[data-part="timeline-scroll"]')).toBeNull();
  expect(container.querySelector('[data-part="jump-to-latest-lane"]')).toBeNull();
  expect(container.querySelectorAll("[data-virtual-id]").length).toBeLessThanOrEqual(200);
});

function hostAttachmentHarness() {
  let items = Array.from({ length: 300 }, (_, index) => committedItem(String(index)));
  const timeline = timelineStore(items);
  const scrollRef = { current: null as HTMLElement | null };
  const view = (target: "inner" | "outer" | "replacement" | "removed", owned = false, followRequest = 0, virtual = true) => (
    <RunProvider store={timeline.store}>
      <div data-testid="outer" ref={target === "outer" ? scrollRef : undefined}>
        <div data-testid="inner" ref={target === "inner" ? scrollRef : undefined} />
      </div>
      {target === "replacement" ? <div data-testid="replacement" ref={scrollRef} /> : null}
      {owned
        ? <Timeline virtual={virtual} followRequest={followRequest} />
        : <Timeline virtual={virtual} followRequest={followRequest} scrollRef={scrollRef} renderJumpToLatest={(control) => <aside>{control}</aside>} />}
    </RunProvider>
  );
  const append = () => {
    const index = items.length;
    const added = committedItem(String(index));
    timeline.replace(items = [...items, added], [{ index, deleteCount: 0, items: [added] }]);
  };
  const prepend = () => {
    const added = committedItem(`before-${items.length}`);
    timeline.replace(items = [added, ...items], [{ index: 0, deleteCount: 0, items: [added] }]);
  };
  const replace = () => {
    const index = items.length - 1;
    const added = committedItem(`replacement-${items.length}`);
    timeline.replace(items = [...items.slice(0, index), added], [{ index, deleteCount: 1, items: [added] }]);
  };
  return { append, prepend, replace, scrollRef, view };
}

const attachedHost = (testId: string) => {
  const host = q(`[data-testid="${testId}"]`);
  expect(host.style.overflowAnchor).toBe("none");
  expect(container.querySelectorAll("[data-virtual-id]").length).toBeLessThanOrEqual(200);
  return host;
};

type TransferKind = "direct swap" | "null gap: 0 commits" | "null gap: 1 commit" | "null gap: N commits" | "owned -> host-owned" | "host-owned -> owned" | "unmount";
type TransferInteraction = "idle pinned" | "idle unpinned" | "touch (active)" | "momentum" | "pending correction" | "pending jump";
type TransferOutlineChange = "none" | "append" | "prepend" | "replace";

const transferKinds: TransferKind[] = [
  "direct swap",
  "null gap: 0 commits",
  "null gap: 1 commit",
  "null gap: N commits",
  "owned -> host-owned",
  "host-owned -> owned",
  "unmount",
];
const transferInteractions: TransferInteraction[] = [
  "idle pinned",
  "idle unpinned",
  "touch (active)",
  "momentum",
  "pending correction",
  "pending jump",
];
const transferOutlineChanges: TransferOutlineChange[] = ["none", "append", "prepend", "replace"];

// Every product-reachable transfer/state/outline-change cell is present. Unmount has no post-transfer host by
// definition, so those cells assert cleanup only instead of follow, append, anchor, and jump behavior.
test.each(transferKinds.flatMap((transfer) => transferInteractions.flatMap((interaction) =>
  transferOutlineChanges.map((outlineChange) => [transfer, interaction, outlineChange] as const),
)))(
  "host transfer matrix: %s / %s / %s outline change",
  (transfer, interaction, outlineChange) => {
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const scrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
    const userAgent = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent");
    const positions = new WeakMap<HTMLElement, number>();
    const listeners = new Map<EventTarget, Map<string, Set<EventListenerOrEventListenerObject>>>();
    const add = HTMLElement.prototype.addEventListener;
    const remove = HTMLElement.prototype.removeEventListener;
    const OriginalResizeObserver = globalThis.ResizeObserver;
    let activeObservers = 0;
    class MatrixResizeObserver implements ResizeObserver {
      constructor(_callback: ResizeObserverCallback) { activeObservers++; }
      disconnect() { activeObservers--; }
      observe() {}
      unobserve() {}
    }
    Object.defineProperty(Navigator.prototype, "userAgent", { configurable: true, get: () => "iPhone" });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => Number.parseFloat(document.querySelector<HTMLElement>('[data-part="timeline"]')?.style.height ?? "0"),
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get() { return positions.get(this as HTMLElement) ?? 0; },
      set(value: number) { positions.set(this as HTMLElement, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))); },
    });
    HTMLElement.prototype.addEventListener = function(type, listener, options) {
      if (this.dataset.testid && listener) {
        const byType = listeners.get(this) ?? new Map<string, Set<EventListenerOrEventListenerObject>>();
        const entries = byType.get(type) ?? new Set<EventListenerOrEventListenerObject>();
        entries.add(listener);
        byType.set(type, entries);
        listeners.set(this, byType);
      }
      add.call(this, type, listener, options);
    };
    HTMLElement.prototype.removeEventListener = function(type, listener, options) {
      if (listener) listeners.get(this)?.get(type)?.delete(listener);
      remove.call(this, type, listener, options);
    };
    globalThis.ResizeObserver = MatrixResizeObserver;
    const listenerCount = () => [...listeners.values()].flatMap((types) => [...types.values()]).reduce((sum, entries) => sum + entries.size, 0);
    const viewportAnchor = (host: HTMLElement, scrollTop = host.scrollTop) => {
      const rows = [...container.querySelectorAll<HTMLElement>("[data-virtual-id]")].map((row) => ({
        id: row.dataset.virtualId!,
        top: Number.parseFloat(row.style.transform.slice("translateY(".length)),
      }));
      const anchor = rows.filter(({ top }) => top <= scrollTop).at(-1)!;
      return { id: anchor.id, offset: anchor.top - scrollTop };
    };
    try {
      const { append, prepend, replace, view } = hostAttachmentHarness();
      let followRequest = 0;
      const startsOwned = transfer === "owned -> host-owned";
      mount(view("inner", startsOwned, followRequest));
      const oldHost = startsOwned ? q('[data-part="timeline-scroll"]') : attachedHost("inner");
      oldHost.scrollTop = oldHost.scrollHeight;
      act(() => oldHost.dispatchEvent(new Event("scroll")));

      const unpinned = interaction !== "idle pinned";
      if (unpinned) {
        oldHost.scrollTop = 3_000;
        act(() => {
          oldHost.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
          oldHost.dispatchEvent(new Event("scroll"));
        });
      }
      if (interaction === "touch (active)" || interaction === "momentum" || interaction === "pending jump") {
        const touch = new Event("touchstart") as TouchEvent;
        Object.defineProperty(touch, "touches", { value: [{ clientY: 100 }] });
        act(() => oldHost.dispatchEvent(touch));
      }
      if (interaction === "pending correction" || interaction === "momentum" || interaction === "pending jump") prepend();
      if (interaction === "momentum") act(() => oldHost.dispatchEvent(new Event("touchend")));
      const expectedTop = interaction === "pending correction" || interaction === "momentum" || interaction === "pending jump" ? 3_072 : 3_000;
      const anchorBefore = unpinned ? viewportAnchor(oldHost) : null;

      const changeOutline = () => {
        if (outlineChange === "append") append();
        else if (outlineChange === "prepend") prepend();
        else if (outlineChange === "replace") replace();
      };
      const render = (target: "inner" | "outer" | "replacement" | "removed", owned = false, virtual = true, withOutlineChange = false) =>
        act(() => {
          if (withOutlineChange) changeOutline();
          root!.render(view(target, owned, followRequest, virtual));
        });
      let newHost: HTMLElement | null = null;
      if (transfer === "unmount") {
        act(() => {
          changeOutline();
          root!.unmount();
        });
        root = undefined;
        expect(oldHost.style.overflowAnchor).toBe("");
        expect(listenerCount()).toBe(0);
        expect(activeObservers).toBe(0);
        return;
      }
      if (transfer === "null gap: 1 commit" || transfer === "null gap: N commits") {
        globalThis.ResizeObserver = undefined as unknown as typeof ResizeObserver;
        render("removed");
        if (transfer === "null gap: N commits") {
          render("removed");
          render("removed");
        }
        globalThis.ResizeObserver = MatrixResizeObserver;
        render("outer", false, true, true);
        newHost = attachedHost("outer");
      } else if (transfer === "null gap: 0 commits") {
        // React clears and assigns the ref during one replacement commit; no committed render observes null.
        render("replacement", false, true, true);
        newHost = attachedHost("replacement");
      } else if (transfer === "owned -> host-owned") {
        render("outer", false, true, true);
        newHost = attachedHost("outer");
      } else if (transfer === "host-owned -> owned") {
        render("inner", true, true, true);
        newHost = q('[data-part="timeline-scroll"]');
      } else {
        render("outer", false, true, true);
        newHost = attachedHost("outer");
      }

      expect(oldHost.style.overflowAnchor).toBe("");
      const measuredRow = q("[data-virtual-id]");
      expect(Number.parseFloat(measuredRow.style.transform.slice("translateY(".length)))
        .toBeCloseTo(Number(measuredRow.dataset.virtualIndex) * 72, 0);
      if (unpinned) {
        const expectedOutlineTop = outlineChange === "prepend" ? expectedTop + 72 : expectedTop;
        expect(newHost.scrollTop).toBeCloseTo(expectedOutlineTop, 0);
        expect(viewportAnchor(newHost).id).toBe(anchorBefore!.id);
        expect(viewportAnchor(newHost).offset).toBeCloseTo(anchorBefore!.offset, 0);
        append();
        expect(q('[data-part="jump-to-latest"]')).toBeTruthy();
      } else expect(newHost.scrollTop).toBeCloseTo(newHost.scrollHeight - newHost.clientHeight, 0);
      followRequest++;
      if (transfer === "host-owned -> owned") render("inner", true);
      else render(transfer === "null gap: 0 commits" ? "replacement" : "outer");
      expect(newHost.scrollTop).toBe(newHost.scrollHeight - newHost.clientHeight);
      append();
      expect(newHost.scrollTop).toBe(newHost.scrollHeight - newHost.clientHeight);
      newHost.scrollTop -= 1_000;
      act(() => {
        newHost!.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
        newHost!.dispatchEvent(new Event("scroll"));
      });
      append();
      const jump = q('[data-part="jump-to-latest"]');
      expect(jump).toBeTruthy();
      act(() => jump.click());
      expect(newHost.scrollTop).toBe(newHost.scrollHeight - newHost.clientHeight);
    } finally {
      if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
      if (scrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
      if (scrollTop) Object.defineProperty(HTMLElement.prototype, "scrollTop", scrollTop);
      if (userAgent) Object.defineProperty(Navigator.prototype, "userAgent", userAgent);
      HTMLElement.prototype.addEventListener = add;
      HTMLElement.prototype.removeEventListener = remove;
      globalThis.ResizeObserver = OriginalResizeObserver;
    }
  },
);

test("host-owned Timeline moves one stable ref from an inner to an outer element", () => {
  const { scrollRef, view } = hostAttachmentHarness();
  mount(view("inner"));
  const inner = attachedHost("inner");
  act(() => root!.render(view("outer")));
  expect(scrollRef.current).toBe(q('[data-testid="outer"]'));
  expect(inner.style.overflowAnchor).toBe("");
  attachedHost("outer");
});

test("host-owned Timeline reattaches when the element behind a stable ref is replaced", () => {
  const { scrollRef, view } = hostAttachmentHarness();
  mount(view("inner"));
  const inner = attachedHost("inner");
  act(() => root!.render(view("replacement")));
  expect(scrollRef.current).toBe(q('[data-testid="replacement"]'));
  expect(inner.style.overflowAnchor).toBe("");
  attachedHost("replacement");
});

test("host-owned Timeline detaches on null and reattaches when the stable ref returns", () => {
  const { scrollRef, view } = hostAttachmentHarness();
  mount(view("inner"));
  const inner = attachedHost("inner");
  act(() => root!.render(view("removed")));
  expect(scrollRef.current).toBeNull();
  expect(inner.style.overflowAnchor).toBe("");
  act(() => root!.render(view("outer")));
  attachedHost("outer");
});

test("Timeline keeps attachment correct while switching between owned and host-owned modes", () => {
  const { view } = hostAttachmentHarness();
  mount(view("inner"));
  const inner = attachedHost("inner");
  act(() => root!.render(view("outer")));
  expect(inner.style.overflowAnchor).toBe("");
  attachedHost("outer");
  act(() => root!.render(view("outer", true)));
  expect(q('[data-testid="outer"]').style.overflowAnchor).toBe("");
  expect(q('[data-part="timeline-scroll"]').style.overflowAnchor).toBe("none");
  act(() => root!.render(view("outer")));
  attachedHost("outer");
});

test("follow, pinning, jump control, and bounded mounts survive every scroll-host transition", () => {
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  const scrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
  const positions = new WeakMap<HTMLElement, number>();
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => Number.parseFloat(document.querySelector<HTMLElement>('[data-part="timeline"]')?.style.height ?? "0") });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() { return positions.get(this as HTMLElement) ?? 0; },
    set(value: number) { positions.set(this as HTMLElement, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))); },
  });
  try {
    const { append, view } = hostAttachmentHarness();
    let followRequest = 0;
    let target: "inner" | "outer" | "replacement" = "inner";
    const render = (owned = false) => act(() => root!.render(view(target, owned, followRequest)));
    const exercise = (host: HTMLElement, owned = false) => {
      host.scrollTop = host.scrollHeight;
      act(() => host.dispatchEvent(new Event("scroll")));
      append();
      expect(host.scrollTop).toBe(host.scrollHeight - host.clientHeight);
      host.scrollTop -= 1_000;
      act(() => {
        host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
        host.dispatchEvent(new Event("scroll"));
      });
      append();
      const jump = q('[data-part="jump-to-latest"]');
      expect(jump).toBeTruthy();
      act(() => jump.click());
      expect(host.scrollTop).toBe(host.scrollHeight - host.clientHeight);
      host.scrollTop -= 1_000;
      act(() => host.dispatchEvent(new Event("scroll")));
      followRequest++;
      render(owned);
      expect(host.scrollTop).toBe(host.scrollHeight - host.clientHeight);
      expect(container.querySelectorAll("[data-virtual-id]").length).toBeLessThanOrEqual(200);
    };

    mount(view(target));
    exercise(attachedHost(target));
    target = "outer";
    render();
    exercise(attachedHost(target));
    target = "replacement";
    render();
    const replacement = attachedHost(target);
    exercise(replacement);
    act(() => root!.render(view("removed", false, followRequest)));
    expect(replacement.style.overflowAnchor).toBe("");
    target = "inner";
    render();
    exercise(attachedHost(target));
    render(true);
    exercise(q('[data-part="timeline-scroll"]'), true);
    target = "outer";
    render();
    exercise(attachedHost(target));
  } finally {
    if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
    if (scrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
    if (scrollTop) Object.defineProperty(HTMLElement.prototype, "scrollTop", scrollTop);
  }
});

test.each([
  ["active touch", false],
  ["momentum settle", true],
])("host transfer settles an iOS correction during %s", (_state, endTouch) => {
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  const scrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
  const userAgent = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent");
  const positions = new WeakMap<HTMLElement, number>();
  Object.defineProperty(Navigator.prototype, "userAgent", { configurable: true, get: () => "iPhone" });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => Number.parseFloat(document.querySelector<HTMLElement>('[data-part="timeline"]')?.style.height ?? "0") });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() { return positions.get(this as HTMLElement) ?? 0; },
    set(value: number) { positions.set(this as HTMLElement, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))); },
  });
  try {
    const { append, prepend, view } = hostAttachmentHarness();
    let followRequest = 0;
    mount(view("inner", false, followRequest));
    const inner = attachedHost("inner");
    inner.scrollTop = 3_000;
    act(() => {
      inner.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      inner.dispatchEvent(new Event("scroll"));
    });
    const touch = new Event("touchstart") as TouchEvent;
    Object.defineProperty(touch, "touches", { value: [{ clientY: 100 }] });
    act(() => inner.dispatchEvent(touch));
    prepend();
    if (endTouch) act(() => inner.dispatchEvent(new Event("touchend")));

    act(() => root!.render(view("outer", false, followRequest)));
    const outer = attachedHost("outer");
    expect(outer.scrollTop).toBe(3_072);
    followRequest++;
    act(() => root!.render(view("outer", false, followRequest)));
    expect(outer.scrollTop).toBe(outer.scrollHeight - outer.clientHeight);
    append();
    expect(outer.scrollTop).toBe(outer.scrollHeight - outer.clientHeight);
    outer.scrollTop -= 1_000;
    act(() => {
      outer.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      outer.dispatchEvent(new Event("scroll"));
    });
    append();
    const jump = q('[data-part="jump-to-latest"]');
    expect(jump).toBeTruthy();
    act(() => jump.click());
    expect(outer.scrollTop).toBe(outer.scrollHeight - outer.clientHeight);
  } finally {
    if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
    if (scrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
    if (scrollTop) Object.defineProperty(HTMLElement.prototype, "scrollTop", scrollTop);
    if (userAgent) Object.defineProperty(Navigator.prototype, "userAgent", userAgent);
  }
});

test("100 host swaps release every adapter listener and observer", () => {
  const added = new Map<EventTarget, Map<string, Set<EventListenerOrEventListenerObject>>>();
  const add = HTMLElement.prototype.addEventListener;
  const remove = HTMLElement.prototype.removeEventListener;
  const OriginalResizeObserver = globalThis.ResizeObserver;
  let activeObservers = 0;
  class CountingResizeObserver implements ResizeObserver {
    constructor(_callback: ResizeObserverCallback) { activeObservers++; }
    disconnect() { activeObservers--; }
    observe() {}
    unobserve() {}
  }
  HTMLElement.prototype.addEventListener = function(type, listener, options) {
    if (this.dataset.testid && listener) {
      const byType = added.get(this) ?? new Map<string, Set<EventListenerOrEventListenerObject>>();
      const listeners = byType.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      listeners.add(listener);
      byType.set(type, listeners);
      added.set(this, byType);
    }
    add.call(this, type, listener, options);
  };
  HTMLElement.prototype.removeEventListener = function(type, listener, options) {
    if (listener) added.get(this)?.get(type)?.delete(listener);
    remove.call(this, type, listener, options);
  };
  globalThis.ResizeObserver = CountingResizeObserver;
  try {
    const { view } = hostAttachmentHarness();
    mount(view("inner"));
    for (let index = 0; index < 100; index++) act(() => root!.render(view(index % 2 ? "inner" : "outer")));
    expect([...added.values()].flatMap((types) => [...types.values()]).reduce((sum, listeners) => sum + listeners.size, 0)).toBe(8);
    expect(activeObservers).toBe(2);
    act(() => root!.unmount());
    root = undefined;
    expect([...added.values()].flatMap((types) => [...types.values()]).reduce((sum, listeners) => sum + listeners.size, 0)).toBe(0);
    expect(activeObservers).toBe(0);
  } finally {
    HTMLElement.prototype.addEventListener = add;
    HTMLElement.prototype.removeEventListener = remove;
    globalThis.ResizeObserver = OriginalResizeObserver;
  }
});

test("10k-row commits do no layout work when the scroll element is unchanged", () => {
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  const scrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
  const rect = HTMLElement.prototype.getBoundingClientRect;
  let layoutReads = 0;
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { layoutReads++; return 600; } });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get() { layoutReads++; return 200_000; } });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", { configurable: true, get() { layoutReads++; return 0; }, set() {} });
  HTMLElement.prototype.getBoundingClientRect = function() { layoutReads++; return rect.call(this); };
  try {
    const timeline = timelineStore(Array.from({ length: 10_000 }, (_, index) => committedItem(String(index))));
    const view = (commit: number) => <div data-commit={commit}><RunProvider store={timeline.store}><Timeline virtual /></RunProvider></div>;
    mount(view(0));
    layoutReads = 0;
    for (let index = 1; index <= 100; index++) act(() => root!.render(view(index)));
    expect(layoutReads).toBe(0);
  } finally {
    if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
    if (scrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
    if (scrollTop) Object.defineProperty(HTMLElement.prototype, "scrollTop", scrollTop);
    HTMLElement.prototype.getBoundingClientRect = rect;
  }
});

test("useVirtualList ignores a stale outline hint and resets when the outline owner changes", () => {
  const a = Array.from({ length: 201 }, (_, index) => ({ id: `a-${index}`, kind: "message" }));
  const b = Array.from({ length: 201 }, (_, index) => ({ id: `b-${index}`, kind: "message" }));
  const c = Array.from({ length: 201 }, (_, index) => ({ id: `c-${index}`, kind: "message" }));
  // Each render claims its outline replaced `from` whole; the engine applies it only when it holds `from`.
  const Harness = ({ outline, from, owner }: { outline: typeof a; from: typeof a; owner: object }) => {
    const list = useVirtualList(outline, { estimateSize: () => 20, outlineUpdate: { from, splices: [{ index: 0, deleteCount: from.length, items: outline }] }, resetKey: owner });
    return <div><div ref={list.timelineRef}>{list.snapshot.rows.map((row) => <div key={row.id} data-virtual-id={row.id} />)}</div></div>;
  };
  const ownerA = {};
  const ownerB = {};
  mount(<Harness outline={a} from={c} owner={ownerA} />);
  expect(() => act(() => root!.render(<Harness outline={b} from={a} owner={ownerA} />))).not.toThrow();
  expect(() => act(() => root!.render(<Harness outline={c} from={b} owner={ownerB} />))).not.toThrow();
  expect(() => act(() => root!.render(<Harness outline={a} from={b} owner={ownerB} />))).not.toThrow();
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
  const a = timelineStore(makeItems("a", 5_000));
  const b = timelineStore(makeItems("b", 100_000));
  const c = timelineStore(makeItems("c", 201));
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
  q('[data-part="timeline-scroll"]').scrollTop = 0;

  expect(() => act(() => root!.render(<RunProvider store={c.store}><Timeline virtual /></RunProvider>))).not.toThrow();
  const viewport = q('[data-part="timeline-scroll"]');
  act(() => viewport.dispatchEvent(new Event("scroll")));
  expect(q("[data-virtual-id]").getAttribute("aria-setsize")).toBe("201");
  expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
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

test("the unconstrained-height diagnostic checks layout only once while rows stream", () => {
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  const requestFrame = globalThis.requestAnimationFrame;
  const cancelFrame = globalThis.cancelAnimationFrame;
  const frames: FrameRequestCallback[] = [];
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 100_000 });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 100_001 });
  globalThis.requestAnimationFrame = (callback) => (frames.push(callback), frames.length);
  globalThis.cancelAnimationFrame = () => {};
  try {
    let items = Array.from({ length: 201 }, (_, index) => committedItem(String(index)));
    const timeline = timelineStore(items);
    mount(<RunProvider store={timeline.store}><Timeline virtual /></RunProvider>);
    expect(container.querySelectorAll("[data-virtual-id]")).toHaveLength(201);
    expect(frames).toHaveLength(1);
    frames.shift()!(0);

    const added = committedItem("201");
    timeline.replace(items = [...items, added], [{ index: 201, deleteCount: 0, items: [added] }]);
    expect(container.querySelectorAll("[data-virtual-id]")).toHaveLength(202);
    expect(frames).toHaveLength(0);
  } finally {
    if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
    if (scrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
    globalThis.requestAnimationFrame = requestFrame;
    globalThis.cancelAnimationFrame = cancelFrame;
  }
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
  source.replace([...history, ...current], [{ index: 0, deleteCount: 0, items: history }]);
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

test("the user's own stop is a neutral stopped row; a real error stays an error", () => {
  const store = createRunStore((flush) => flush());
  store.dispatch({ type: "error", error: { code: "aborted", message: "turn aborted" } });
  store.dispatch({ type: "error", error: { code: "provider_error", message: "rate limited" } });
  mount(<RunProvider store={store}><Timeline /></RunProvider>);
  const rows = [...container.querySelectorAll<HTMLElement>('[data-part="item"]')];
  expect(rows.map((row) => [row.dataset.kind, row.dataset.state, row.textContent])).toEqual([
    ["stopped", "stopped", "stopped"],
    ["error", "error", "rate limited"],
  ]);
});

test("the jump to approval sits inside the timeline (its content column), virtual or not", () => {
  for (const virtual of [false, true]) {
    const store = createRunStore((flush) => flush());
    store.dispatch({ type: "approval_request", request_id: "p", tool_call: { id: "r", name: "read", arguments: { path: "README.md" } }, view: { kind: "read", path: "README.md" }, delegated: false });
    mount(<RunProvider store={store}><Timeline virtual={virtual} /></RunProvider>);
    const link = q('[data-part="jump-to-approval"]');
    expect(link.parentElement?.dataset.part).toBe("timeline");
    expect(link.parentElement?.firstElementChild).toBe(link);
    act(() => root?.unmount());
    root = undefined;
    container.remove();
  }
});

test("with a pending approval, the timeline's first tab stop jumps to it and focuses its first action", async () => {
  const store = createRunStore((flush) => flush());
  for (let i = 0; i < 5; i++) {
    const tool_call = { id: `t${i}`, name: "bash", arguments: { command: "ls" } };
    store.dispatch({ type: "tool_start", tool_call, view: { kind: "shell", command: "ls" } });
    store.dispatch({ type: "tool_end", tool_call, tool_result: { tool_call_id: `t${i}`, content: "a\n", is_error: false } });
  }
  store.dispatch({ type: "approval_request", request_id: "p", tool_call: { id: "rm", name: "bash", arguments: { command: "rm -rf dist" } }, view: { kind: "shell", command: "rm -rf dist" }, delegated: false });
  const renderers: Renderers = { approval: ({ id }) => <Approval id={id} onApprove={() => {}} onDeny={() => {}} /> };
  mount(<RunProvider store={store}><Timeline renderers={renderers} /></RunProvider>);
  const first = container.querySelector<HTMLElement>("button, summary, [tabindex]")!;
  expect(first.dataset.part).toBe("jump-to-approval");
  expect(first.textContent).toContain("rm -rf dist");
  await act(async () => first.click());
  expect(document.activeElement?.getAttribute("data-action")).toBe("approve");
  act(() => store.dispatch({ type: "approval_end", request_id: "p", decision: "deny" }));
  expect(container.querySelector('[data-part="jump-to-approval"]')).toBeNull();
});

test("virtual Timeline shows the folded tool card live when an approval folds in place across batches", () => {
  const { store, send } = setup([{ type: "user_message", text: "read it", mode: "normal" }]);
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  try {
    mount(<RunProvider store={store}><Timeline virtual /></RunProvider>);
    const rows = () => [...container.querySelectorAll("[data-virtual-id]")].map((row) => row.getAttribute("data-virtual-id"));
    const read = { id: "read-1", name: "read", arguments: { path: "README.md" } };
    send({ type: "approval_request", request_id: "read-1", tool_call: read, delegated: false });
    expect(rows()).toEqual(["user:1", "approval:read-1"]);
    send({ type: "approval_end", request_id: "read-1", decision: "approve" });
    send({ type: "tool_start", tool_call: read });
    send({ type: "tool_end", tool_call: read, tool_result: { tool_call_id: "read-1", content: "# fulcrum", is_error: false } });
    expect(rows()).toEqual(["user:1", "tool:read-1"]);
    expect(store.getOutline().map(({ id }) => id)).toEqual(rows());
  } finally {
    if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
  }
});

test("an approved call that folds into its tool row is still announced when it finishes", async () => {
  const { store, send } = setup([]);
  mount(<RunProvider store={store}><Timeline virtual /></RunProvider>);
  const live = q('[data-part="timeline-live"]');
  send({ type: "approval_request", request_id: "r1", tool_call: call("t1", "bash"), delegated: false });
  await waitForAnnouncement();
  expect(live.textContent).toBe("approval needed: bash");
  send({ type: "approval_end", request_id: "r1", decision: "approve" }, { type: "tool_start", tool_call: call("t1", "bash") });
  send({ type: "tool_end", tool_call: call("t1", "bash"), tool_result: { tool_call_id: "t1", content: "ok", is_error: false } });
  await waitForAnnouncement();
  expect(live.textContent).toBe("tool bash finished");
});

test("a fast approved call that folds already finished (one frame) is still announced", async () => {
  for (const virtual of [true, false]) {
    const { store, send } = setup([]);
    mount(<RunProvider store={store}><Timeline virtual={virtual} /></RunProvider>);
    const live = q('[data-part="timeline-live"]');
    send({ type: "approval_request", request_id: "r1", tool_call: call("t1", "bash"), delegated: false });
    await waitForAnnouncement();
    expect(live.textContent).toBe("approval needed: bash");
    send(
      { type: "approval_end", request_id: "r1", decision: "approve" },
      { type: "tool_start", tool_call: call("t1", "bash") },
      { type: "tool_end", tool_call: call("t1", "bash"), tool_result: { tool_call_id: "t1", content: "ok", is_error: false } },
    );
    await waitForAnnouncement();
    expect(live.textContent).toBe("tool bash finished");
    act(() => root!.unmount()); root = undefined; container.remove();
  }
});

test("a finished call whose approval resolves later moves into the approval's place without speaking again", async () => {
  const { store, send } = setup([]);
  mount(<RunProvider store={store}><Timeline virtual /></RunProvider>);
  const live = q('[data-part="timeline-live"]');
  send({ type: "approval_request", request_id: "r1", tool_call: call("t1", "bash"), delegated: false });
  send({ type: "tool_start", tool_call: call("t1", "bash") });
  send({ type: "tool_end", tool_call: call("t1", "bash"), tool_result: { tool_call_id: "t1", content: "ok", is_error: false } });
  await waitForAnnouncement();
  const spoken = live.textContent;
  send({ type: "approval_end", request_id: "r1", decision: "approve" });
  expect(store.getOutline().map(({ id }) => id)).toEqual(["tool:t1"]);
  // A new announcement clears the region first; a moved row that already spoke must not.
  expect(live.textContent).toBe(spoken);
});

test("a store swap to a finished session announces nothing", async () => {
  const first = setup([]);
  const second = setup([
    { type: "tool_start", tool_call: call("t9", "read") },
    { type: "tool_end", tool_call: call("t9", "read"), tool_result: { tool_call_id: "t9", content: "x", is_error: false } },
  ]);
  mount(<RunProvider store={first.store}><Timeline virtual /></RunProvider>);
  act(() => root!.render(<RunProvider store={second.store}><Timeline virtual /></RunProvider>));
  await waitForAnnouncement();
  expect(q('[data-part="timeline-live"]').textContent).toBe("");
});

test("after a keyboard decision, focus lands on the next approval's row, never on its approve button", () => {
  const { store, send } = setup([
    { type: "approval_request", request_id: "r1", tool_call: call("t1", "bash"), delegated: false },
    { type: "approval_request", request_id: "r2", tool_call: call("t2", "bash"), delegated: false },
  ]);
  mount(
    <RunProvider store={store}>
      <div data-part="timeline">
        <Approval id="approval:r1" onApprove={() => {}} />
        <Approval id="approval:r2" onApprove={() => {}} />
      </div>
    </RunProvider>,
  );
  const first = q('[data-id="approval:r1"] [data-action="approve"]');
  act(() => first.focus());
  act(() => first.click());
  send({ type: "approval_end", request_id: "r1", decision: "approve" });
  const active = document.activeElement as HTMLElement;
  // A second Enter must not approve a request the user has not read: the row takes focus, Tab then reaches approve.
  expect(active.getAttribute("data-action")).toBeNull();
  expect(active.getAttribute("data-id")).toBe("approval:r2");
});
