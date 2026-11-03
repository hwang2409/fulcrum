import { useEffect, useRef, useState, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import { initialState, type OutlineSnapshot, type RunItem } from "@fulcrum/core";
import { RunProvider, Timeline, useItem, type RunStore } from "@fulcrum/react";
import { Shell } from "./shell";
import "./virtual.css";

type Listener = () => void;
const params = new URLSearchParams(location.search);
const COUNTS = [1_000, 5_000, 100_000];
const count = Number(params.get("count") ?? 5_000);
const auto = params.get("auto") === "1";
let serial = count;
let outline = Array.from({ length: count }, (_, index) => ({ id: `row:${index}`, kind: "message" as const }));
let outlineSnapshot: OutlineSnapshot = { items: outline, change: null };
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
const rowsOf = (amount: number) => Array.from({ length: amount }, () => ({ id: `row:${serial++}`, kind: "message" as const }));
const splice = (index: number, deleteCount: number, inserted: typeof outline) => {
  const from = outline;
  outline = [...from.slice(0, index), ...inserted, ...from.slice(index + deleteCount)];
  outlineSnapshot = { items: outline, change: { from, splices: [{ index, deleteCount, items: inserted }] } };
  publishOutline();
};
const controls = {
  append: (amount = 1) => splice(outline.length, 0, rowsOf(amount)),
  prepend: (amount = 1) => splice(0, 0, rowsOf(amount)),
  insert: (index: number, amount = 1) => splice(index, 0, rowsOf(amount)),
  resize(id: string, height: number) {
    const prior = getItem(id);
    const next = item(id, height);
    if (next.type === "message") items.set(id, { ...next, version: prior.type === "message" ? prior.version + 1 : 1 });
    keyed.get(id)?.forEach((listener) => listener());
  },
};
(window as typeof window & { __virtualControls?: typeof controls }).__virtualControls = controls;

const heightOf = (value: RunItem | undefined) => (value?.type === "message" ? Number(value.message.content[0]?.text) : 48);
function TestRow({ id }: { id: string }) {
  const height = heightOf(useItem(id));
  return (
    <div data-part="message" data-id={id} className="row" style={{ height }}>
      <span>{id}</span>
      <span>{height} px</span>
    </div>
  );
}
const renderers = { message: TestRow };

// The first row whose bottom is below the scroll box's top edge: the row the reader is looking at.
function firstVisible(scroll: HTMLElement) {
  const top = scroll.getBoundingClientRect().top;
  const rows = [...scroll.querySelectorAll<HTMLElement>("[data-virtual-id]")].filter((row) => row.style.opacity !== "0");
  return rows.sort((a, b) => Number(a.dataset.virtualIndex) - Number(b.dataset.virtualIndex)).find((row) => row.getBoundingClientRect().bottom > top);
}

function Stats({ scroll }: { scroll: RefObject<HTMLDivElement | null> }) {
  const [stats, setStats] = useState({ rows: outline.length, mounted: 0 });
  useEffect(() => {
    const timer = setInterval(() => setStats({ rows: outline.length, mounted: scroll.current?.querySelectorAll("[data-virtual-id]").length ?? 0 }), 500);
    return () => clearInterval(timer);
  }, [scroll]);
  return <span>{stats.rows.toLocaleString("en")} rows · {stats.mounted} mounted</span>;
}

function App() {
  const scroll = useRef<HTMLDivElement>(null);
  const [streaming, setStreaming] = useState(false);
  const [debug, setDebug] = useState(params.has("virtualDebug"));
  useEffect(() => {
    if (!streaming) return;
    const timer = setInterval(() => controls.append(1), 250);
    return () => clearInterval(timer);
  }, [streaming]);
  const toggleDebug = () => {
    const url = new URL(location.href);
    if (debug) url.searchParams.delete("virtualDebug");
    else url.searchParams.set("virtualDebug", "1");
    history.replaceState(null, "", url);
    setDebug(!debug);
  };
  const above = (act: (row: HTMLElement) => void) => {
    const row = scroll.current && firstVisible(scroll.current);
    if (row) act(row);
  };
  return (
    <RunProvider store={store}>
      <Shell page="virtual">
        <h1 className="page-title">virtual timeline</h1>
        <p className="caption">
          @fulcrum/virtual holds {count.toLocaleString("en")} rows and mounts only those near the viewport.{" "}
          <strong>Follow:</strong> at the bottom, press stream. <strong>Unseen:</strong> scroll up while streaming; jump to latest counts new rows.{" "}
          <strong>Anchoring:</strong> mid-list, prepend, insert, or resize above; the top visible row must not move.{" "}
          <strong>Focus:</strong> tab into a row, arrow keys, scroll away and back; focus stays.
        </p>
        <div className="toolbar">
          <label className="field">
            rows
            <select value={COUNTS.includes(count) ? count : ""} onChange={(e) => { const url = new URL(location.href); url.searchParams.set("count", e.target.value); location.assign(url); }}>
              {!COUNTS.includes(count) && <option value="">{count.toLocaleString("en")}</option>}
              {COUNTS.map((value) => <option key={value} value={value}>{value.toLocaleString("en")}</option>)}
            </select>
          </label>
          <div className="group">
            <button type="button" aria-pressed={streaming} onClick={() => setStreaming(!streaming)}>stream</button>
            <button type="button" onClick={() => controls.append(10)}>append 10</button>
            <button type="button" onClick={() => controls.prepend(20)}>prepend 20</button>
            <button type="button" onClick={() => above((row) => controls.insert(Number(row.dataset.virtualIndex), 5))}>insert 5 above</button>
            <button type="button" onClick={() => above((row) => {
              const prior = outline[Number(row.dataset.virtualIndex) - 1];
              if (prior) controls.resize(prior.id, heightOf(getItem(prior.id)) > 48 ? 48 : 160);
            })}>resize above</button>
            <button type="button" aria-pressed={debug} onClick={toggleDebug}>debug overlay</button>
          </div>
        </div>
        <div className="status">
          <span className="mode" data-state={streaming ? "streaming" : "static"}>virtual<span>{streaming ? "streaming 4 rows/s" : "idle"}</span></span>
          <Stats scroll={scroll} />
        </div>
        {/* className changes with debug only so the memoized Timeline re-renders and reads the new URL flag. */}
        <div ref={scroll} data-testid="scroll" className="scroll"><Timeline className={debug ? "debug" : undefined} virtual={auto ? undefined : true} renderers={renderers} scrollRef={scroll} /></div>
      </Shell>
    </RunProvider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
