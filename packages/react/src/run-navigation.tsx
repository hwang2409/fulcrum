import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { RunItem, RunLease, RunSource, SubAgentStatus } from "@fulcrum/core";
import type { Highlight } from "@fulcrum/highlight";
import { RunProvider, type RunStore } from "./hooks.js";
import { Timeline, type Renderers, type TimelineViewport } from "./parts.js";
import { SubAgentContext, subAgentStatusText, type SubAgentNavigation } from "./sub-agent.js";

/** One run on the open path. The root has the `runId` the host gave it, if any. */
export type RunLocation = { readonly runId?: string; readonly label: string };
export type RunNavigation = { readonly path: readonly RunLocation[]; back(): void };

type Entry = RunLocation & {
  store: RunStore;
  lease?: RunLease;
  /** The sub-agent row this run was opened from, in the previous entry's store. */
  opener?: string;
  viewport?: TimelineViewport;
};

const RunNavigationContext = createContext<RunNavigation | null>(null);
/** The open run path inside a `RunNavigator` (the last entry is the run on screen), or null outside one. */
export const useRunNavigation = () => useContext(RunNavigationContext);

// Each navigator keeps its depth in history.state under its own id, so browser back pops one level.
const HISTORY_KEY = "fulcrumRuns";
let lastNavigator: string | undefined;
type HistoryDepths = Record<string, number>;
const historyDepth = (id: string) => (history.state?.[HISTORY_KEY] as HistoryDepths | undefined)?.[id] ?? 0;
const pushDepth = (id: string, depth: number) =>
  history.pushState({ ...history.state, [HISTORY_KEY]: { ...history.state?.[HISTORY_KEY], [id]: depth } }, "");

export type RunNavigatorProps = {
  /** The root run's store. */
  store: RunStore;
  /** Resolves a child run id to its store. Rows whose run it cannot open show why instead of a drill-in. */
  source: RunSource;
  runId?: string;
  /** The root's breadcrumb label. */
  label?: string;
  renderers?: Renderers;
  highlight?: Highlight;
  /** Defaults to true so every run keeps its reading position and follow mode across drill-in and back. */
  virtual?: boolean;
  className?: string;
  /** Rendered in the run bar after the breadcrumb. */
  children?: ReactNode;
};

/**
 * One timeline for a run and its sub-agents. Opening a sub-agent row swaps in the child's store under a breadcrumb;
 * back (the button, Escape, or browser back) returns to the exact reading position and follow mode left behind.
 */
export function RunNavigator({ store, source, runId, label = "run", renderers, highlight, virtual = true, className, children: barExtra }: RunNavigatorProps) {
  const id = useId();
  const [children, setChildren] = useState<readonly Entry[]>([]);
  const childrenRef = useRef(children);
  childrenRef.current = children;
  const rootRef = useRef<Entry>({ runId, label, store });
  if (rootRef.current.store !== store) rootRef.current = { runId, label, store };
  else Object.assign(rootRef.current, { runId, label });
  const path = useMemo(() => [rootRef.current, ...children], [children, runId, label, store]);
  const current = path.at(-1)!;
  const [error, setError] = useState<string>();
  const focus = useRef<{ crumb: true } | { row: string } | null>(null);
  const crumbRef = useRef<HTMLSpanElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);

  const truncate = useCallback((depth: number) => {
    const dropped = childrenRef.current.slice(depth);
    if (!dropped.length) return;
    dropped.forEach((entry) => entry.lease?.release());
    focus.current = { row: dropped[0]!.opener! };
    setChildren(childrenRef.current.slice(0, depth));
  }, []);
  const back = useCallback((depth = childrenRef.current.length - 1) => {
    const now = childrenRef.current.length;
    if (depth < 0 || depth >= now) return;
    // Only walk browser history over entries this navigator pushed; otherwise drop the levels directly.
    if (historyDepth(id) === now) history.go(depth - now);
    else truncate(depth);
  }, [id, truncate]);

  useEffect(() => {
    mounted.current = true;
    const onPop = (event: PopStateEvent) => {
      const depth = (event.state?.[HISTORY_KEY] as HistoryDepths | undefined)?.[id] ?? 0;
      if (depth < childrenRef.current.length) truncate(depth);
    };
    addEventListener("popstate", onPop);
    return () => {
      mounted.current = false;
      removeEventListener("popstate", onPop);
    };
  }, [id, truncate]);
  useEffect(() => () => childrenRef.current.forEach((entry) => entry.lease?.release()), []);

  const navigation = useMemo<SubAgentNavigation>(() => ({
    unavailable: (childRunId) => source.unavailable?.(childRunId) ?? (path.some((entry) => entry.runId === childRunId) ? "already open above" : undefined),
    open(item, childLabel) {
      if (navigation.unavailable(item.childRunId)) return;
      const depth = childrenRef.current.length;
      const push = (lease: RunLease) => {
        if (!mounted.current || childrenRef.current.length !== depth) return lease.release();
        setError(undefined);
        pushDepth(id, depth + 1);
        focus.current = { crumb: true };
        setChildren([...childrenRef.current, { runId: item.childRunId, label: childLabel, store: lease.store, lease, opener: item.id }]);
      };
      const fail = (reason: unknown) => setError(`could not open ${childLabel}: ${reason instanceof Error ? reason.message : String(reason)}`);
      try {
        const lease = source.open(item.childRunId);
        if ("then" in lease) lease.then(push, fail);
        else push(lease);
      } catch (reason) {
        fail(reason);
      }
    },
  }), [id, path, source]);

  // Focus follows the move: the breadcrumb after opening, the opening row after back (once the restored rows mount).
  useLayoutEffect(() => {
    const target = focus.current;
    focus.current = null;
    if (!target) return;
    // On a narrow bar the ancestry scrolls; keep the current run in view at its end.
    const breadcrumb = crumbRef.current?.closest<HTMLElement>('[data-part="run-breadcrumb"]');
    if (breadcrumb) breadcrumb.scrollLeft = breadcrumb.scrollWidth;
    if ("crumb" in target) return crumbRef.current?.focus({ preventScroll: true });
    let frame = 0;
    let tries = 0;
    const find = () => {
      const row = scrollRef.current?.querySelector<HTMLElement>(`[data-part="sub-agent"][data-id="${CSS.escape(target.row)}"]`);
      if (row) row.focus({ preventScroll: true });
      else if (++tries < 5) frame = requestAnimationFrame(find);
    };
    find();
    return () => cancelAnimationFrame(frame);
  }, [children]);

  // Escape goes back from inside the navigator, or from the page body when this was the last navigator used (an
  // approval's buttons unmount once it resolves, which drops focus to the body).
  const rootElement = useRef<HTMLDivElement>(null);
  const depth = children.length;
  useEffect(() => {
    if (!depth) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const active = document.activeElement;
      const here = rootElement.current?.contains(active) || ((!active || active === document.body) && lastNavigator === id);
      if (event.key !== "Escape" || event.defaultPrevented || !here) return;
      event.preventDefault();
      back();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [back, depth, id]);
  const context = useMemo<RunNavigation>(() => ({ path: path.map(({ runId, label }) => ({ runId, label })), back: () => back() }), [path, back]);
  const parent = path.at(-2);

  return (
    <div ref={rootElement} className={className} data-part="run-navigator" data-depth={depth} onFocusCapture={() => { lastNavigator = id; }} onPointerDownCapture={() => { lastNavigator = id; }}>
      <div data-part="run-bar">
        {parent ? <button type="button" data-part="run-back" aria-label={`back to ${parent.label}`} onClick={() => back()}>back</button> : null}
        <nav data-part="run-breadcrumb" aria-label="run path">
          <ol>
            {path.map((entry, index) => {
              const content = index > 0
                ? <RunStatus store={path[index - 1]!.store} id={entry.opener!} label={entry.label} />
                : <span data-part="run-label">{entry.label}</span>;
              return (
                <li key={index}>
                  {entry === current
                    ? <span data-part="run-crumb" aria-current="page" tabIndex={-1} ref={crumbRef}>{content}</span>
                    : <button type="button" data-part="run-crumb" onClick={() => back(index)}>{content}</button>}
                </li>
              );
            })}
          </ol>
        </nav>
        {error ? <span data-part="run-error" role="alert">{error}</span> : null}
        {barExtra}
      </div>
      <div data-part="run-scroll" ref={scrollRef}>
        <RunNavigationContext.Provider value={context}>
          <SubAgentContext.Provider value={navigation}>
            <RunProvider store={current.store} highlight={highlight}>
              <Timeline
                renderers={renderers}
                virtual={virtual}
                scrollRef={scrollRef}
                aria-label={`${current.label} activity`}
                initialViewport={current.viewport}
                onViewport={(viewport) => { current.viewport = viewport; }}
              />
            </RunProvider>
          </SubAgentContext.Provider>
        </RunNavigationContext.Provider>
      </div>
    </div>
  );
}

const statusOf = (item: RunItem | undefined) => (item?.type === "sub_agent" ? item : undefined);

/** A child's crumb: its state mark (read from its row in the parent), its label, and a badge while it needs the user. */
function RunStatus({ store, id, label }: { store: RunStore; id: string; label: string }) {
  const read = () => {
    const item = statusOf(store.getItem(id));
    return item ? `${item.status}|${item.urgency ?? ""}` : "";
  };
  const subscribe = useCallback((listener: () => void) => store.subscribe(id, listener), [store, id]);
  const value = useSyncExternalStore(subscribe, read, read);
  const [status, urgency] = value ? value.split("|") as [SubAgentStatus, string] : [];
  return (
    <>
      {status ? <span data-part="run-state" data-state={status} title={subAgentStatusText[status]} /> : null}
      <span data-part="run-label">{label}</span>
      {urgency === "approval" || urgency === "input" ? <span data-part="run-urgency" data-urgency={urgency}>needs {urgency}</span> : null}
    </>
  );
}
