import "@fulcrum/react/styles.css";
import { useRef } from "react";
import { createRoot } from "react-dom/client";
import { initialState, type OutlineSnapshot, type RunItem } from "@fulcrum/core";
import { RunProvider, Timeline, useItem, type RunStore } from "@fulcrum/react";

type Listener = () => void;
const params = new URLSearchParams(location.search);
const count = Number(params.get("count") ?? 5_000);
const auto = params.get("auto") === "1";
let serial = count;
let outline = Array.from({ length: count }, (_, index) => ({ id: `row:${index}`, kind: "message" as const }));
let outlineSnapshot: OutlineSnapshot = { items: outline, change: { type: "append", count: outline.length } };
const items = new Map<string, RunItem>();
const outlineListeners = new Set<Listener>();
const keyed = new Map<string, Set<Listener>>();
const item = (id: string, height = 48): RunItem => ({
  id,
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text: String(height) }] },
  version: 1,
  active: false,
});
const getItem = (id: string) => {
  let value = items.get(id);
  if (!value) { value = item(id); items.set(id, value); }
  return value;
};
const subscribe: RunStore["subscribe"] = ((idOrListener: string | Listener, listener?: Listener) => {
  if (typeof idOrListener !== "string") return () => {};
  const listeners = keyed.get(idOrListener) ?? new Set<Listener>();
  listeners.add(listener!);
  keyed.set(idOrListener, listeners);
  return () => listeners.delete(listener!);
}) as RunStore["subscribe"];
const store: RunStore = {
  getState: () => ({ ...initialState, outline }),
  getItem,
  getOutline: () => outline,
  getOutlineSnapshot: () => outlineSnapshot,
  subscribe,
  subscribeOutline(listener) { outlineListeners.add(listener); return () => outlineListeners.delete(listener); },
};
const publishOutline = () => outlineListeners.forEach((listener) => listener());
const controls = {
  append(amount = 1) {
    outline = [...outline, ...Array.from({ length: amount }, () => ({ id: `row:${serial++}`, kind: "message" as const }))];
    outlineSnapshot = { items: outline, change: { type: "append", count: amount } };
    publishOutline();
  },
  prepend(amount = 1) {
    outline = [...Array.from({ length: amount }, () => ({ id: `row:${serial++}`, kind: "message" as const })), ...outline];
    outlineSnapshot = { items: outline, change: { type: "prepend", count: amount } };
    publishOutline();
  },
  resize(id: string, height: number) {
    const prior = getItem(id);
    const next = item(id, height);
    if (next.type === "message") items.set(id, { ...next, version: prior.type === "message" ? prior.version + 1 : 1 });
    keyed.get(id)?.forEach((listener) => listener());
  },
};
(window as typeof window & { __virtualControls?: typeof controls }).__virtualControls = controls;

function TestRow({ id }: { id: string }) {
  const value = useItem(id);
  const height = value?.type === "message" ? Number(value.message.content[0]?.text) : 48;
  return <div data-part="message" data-id={id} style={{ height }}><button type="button">{id}</button></div>;
}
const renderers = { message: TestRow };
function App() {
  const scroll = useRef<HTMLDivElement>(null);
  return <RunProvider store={store}><div ref={scroll} data-testid="scroll" style={{ height: 600, overflow: "auto" }}><Timeline virtual={auto ? undefined : true} renderers={renderers} scrollRef={scroll} /></div></RunProvider>;
}
createRoot(document.getElementById("root")!).render(<App />);
