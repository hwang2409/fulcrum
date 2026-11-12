import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { RunLease, RunSource, SubAgentStatus } from "@fulcrum/core";
import type { Highlight } from "@fulcrum/highlight";
import { RunProvider, type RunStore } from "./hooks.js";
import { Timeline, type Renderers, type TimelineViewport } from "./parts.js";
import { SubAgentNavigationProvider, subAgentLabel, subAgentStatusText, type SubAgentNavigation } from "./sub-agent.js";

/** One run on the open path. The root has the `runId` the host gave it, if any. */
export type RunLocation = { readonly runId?: string; readonly label: string };
export type RunNavigation = { readonly path: readonly RunLocation[]; back(): void };
/** `replace` is true when the navigator corrects the path (a run that cannot open, a new root), not a user move. */
export type RunPathChange = { readonly replace: boolean };

/** A child run on the path whose lease this navigator holds. */
type Held = { readonly runId: string; readonly source: RunSource; readonly store: RunStore; readonly lease: RunLease };
type Opened = Held | { readonly reason: unknown };

const RunNavigationContext = createContext<RunNavigation | null>(null);
/** The open run path inside a `RunNavigator` (the last entry is the run on screen), or null outside one. */
export const useRunNavigation = () => useContext(RunNavigationContext);

// The navigator the user last touched, so Escape on the page body (focus lost to an unmounted control) goes back there.
let lastNavigator: string | undefined;

const rowId = (runId: string) => `sub-agent:${runId}`;
const labelIn = (store: RunStore, runId: string) => {
  const item = store.getItem(rowId(runId));
  return item?.type === "sub_agent" ? subAgentLabel(item) : runId;
};
/** How many of `held` are the start of `ids`, opened from `source`. */
const heldDepth = (held: readonly Held[], ids: readonly string[], source: RunSource) => {
  let depth = 0;
  while (depth < held.length && depth < ids.length && held[depth]!.runId === ids[depth] && held[depth]!.source === source) depth++;
  return depth;
};

export type RunNavigatorProps = {
  /** The root run's store. */
  store: RunStore;
  /** Resolves a child run id to its store. Rows whose run it cannot open show why instead of a drill-in. */
  source: RunSource;
  /**
   * The open child run ids below the root, outermost first; `[]` is the root. Pass it to control navigation (for
   * browser history, use `useHistoryRunPath`). Without it the path lives in this component only and starts at the root
   * whenever `store` changes. A controlled path is the app's: when it swaps `store`, it sets the path too.
   */
  path?: readonly string[];
  /** Every move: a row opened, back, Escape, a crumb, or a correction (`replace`). Controlled paths must apply it. */
  onPathChange?(path: readonly string[], change: RunPathChange): void;
  runId?: string;
  /**
   * The root's breadcrumb label. While a child run is open it also names the breadcrumb's navigation landmark
   * ("run path: <label>"), so give each navigator on one page its own label.
   */
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
 * back (the button, Escape, or a crumb) returns to the exact reading position and follow mode left behind. It never
 * touches browser history itself.
 */
export function RunNavigator({ store, source, path, onPathChange, runId, label = "run", renderers, highlight, virtual = true, className, children: barExtra }: RunNavigatorProps) {
  const id = useId();
  const [own, setOwn] = useState<{ store: RunStore; path: readonly string[] }>(() => ({ store, path: [] }));
  const [notice, setNotice] = useState<{ text: string; error?: true }>({ text: "" });
  const [resets, setResets] = useState(0);
  // The path whose open failed, so it does not read as still opening when the app keeps it.
  const [failed, setFailed] = useState<string>();
  if (path === undefined && own.store !== store) {
    // An uncontrolled navigator's children belonged to the old root.
    if (own.path.length) {
      setNotice({ text: `the run changed; back at ${label}` });
      setResets((count) => count + 1);
    }
    setOwn({ store, path: [] });
  }
  const ids = path ?? own.path;
  const key = JSON.stringify(ids);
  const latest = useRef({ store, runId, controlled: path !== undefined, onPathChange });
  latest.current = { store, runId, controlled: path !== undefined, onPathChange };
  // Set by this navigator's own moves, so focus follows them even from a control that is about to unmount.
  const intent = useRef(false);
  const navigate = useCallback((next: readonly string[], replace = false) => {
    const { store, controlled, onPathChange } = latest.current;
    if (!replace) {
      intent.current = true;
      setNotice({ text: "" });
      setFailed(undefined);
    }
    if (!controlled) setOwn({ store, path: next });
    onPathChange?.(next, { replace });
  }, []);
  useLayoutEffect(() => {
    if (resets) latest.current.onPathChange?.([], { replace: true });
  }, [resets]);

  // Saved reading positions by path, so a run viewed before reopens where it was left. A new root starts fresh.
  const viewports = useRef({ store, byPath: new Map<string, TimelineViewport>() });
  if (viewports.current.store !== store) viewports.current = { store, byPath: new Map() };

  const [held, setHeld] = useState<readonly Held[]>([]);
  const heldRef = useRef(held);
  const depth = heldDepth(held, ids, source);
  const view = useMemo(() => held.slice(0, depth), [held, depth]);
  const viewKey = JSON.stringify(view.map((entry) => entry.runId));
  const pending = depth < ids.length && failed !== key;

  // Hold a lease for every run on the path: release what left it, open what is new. Each pass owns its opens; a newer
  // path aborts them, and anything they return after that is released at once and never shown.
  useLayoutEffect(() => {
    const ids = JSON.parse(key) as string[];
    const commit = (next: readonly Held[]) => {
      heldRef.current = next;
      setHeld(next);
    };
    const current = heldRef.current;
    const keep = heldDepth(current, ids, source);
    const kept = current.slice(0, keep);
    if (keep < current.length) {
      current.slice(keep).forEach((entry) => entry.lease.release());
      commit(kept);
    }
    const missing = ids.slice(keep);
    if (!missing.length) return;
    // The first run that cannot open ends the path; the runs before it open together.
    const results: Array<Opened | undefined> = [];
    for (const [index, childId] of missing.entries()) {
      const above = childId === latest.current.runId || ids.indexOf(childId) < keep + index;
      const reason = above ? "already open above" : source.unavailable?.(childId);
      results.push(reason ? { reason } : undefined);
      if (reason) break;
    }
    const controllers = results.map(() => new AbortController());
    let done = false;
    const settle = () => {
      if (done) return;
      const stop = results.findIndex((result) => result && "reason" in result);
      const end = stop < 0 ? results.length : stop;
      if (results.slice(0, end).some((result) => !result)) return;
      done = true;
      controllers.slice(end + 1).forEach((controller) => controller.abort());
      results.slice(end + 1).forEach((result) => result && "lease" in result && result.lease.release());
      const next = [...kept, ...(results.slice(0, end) as Held[])];
      commit(next);
      if (stop < 0) return;
      const parent = next.at(-1)?.store ?? latest.current.store;
      const reason = (results[stop] as { reason: unknown }).reason;
      setNotice({ text: `could not open ${labelIn(parent, missing[stop]!)}: ${reason instanceof Error ? reason.message : String(reason)}`, error: true });
      setFailed(key);
      intent.current = false;
      navigate(ids.slice(0, next.length), true);
    };
    results.forEach((result, index) => {
      if (result) return;
      const { signal } = controllers[index]!;
      const take = (lease: RunLease) => {
        if (signal.aborted) return lease.release();
        results[index] = { runId: missing[index]!, source, store: lease.store, lease };
        settle();
      };
      const fail = (reason: unknown) => {
        if (signal.aborted) return;
        results[index] = { reason };
        settle();
      };
      try {
        const opened = source.open(missing[index]!, { signal });
        if ("then" in opened) opened.then(take, fail);
        else take(opened);
      } catch (reason) {
        fail(reason);
      }
    });
    settle();
    return () => {
      if (done) return;
      done = true;
      controllers.forEach((controller) => controller.abort());
      results.forEach((result) => result && "lease" in result && result.lease.release());
    };
  }, [key, source, navigate]);
  useEffect(() => () => {
    heldRef.current.forEach((entry) => entry.lease.release());
    heldRef.current = [];
  }, []);

  const viewIds = useMemo(() => view.map((entry) => entry.runId), [view]);
  // Back: cancel an open still on its way, else go up one level.
  const back = useCallback(() => {
    if (pending) navigate(viewIds);
    else if (viewIds.length) navigate(viewIds.slice(0, -1));
  }, [navigate, pending, viewIds]);
  const navigation = useMemo<SubAgentNavigation>(() => ({
    unavailable: (childRunId) => (childRunId === runId || viewIds.includes(childRunId) ? "already open above" : source.unavailable?.(childRunId)),
    open: (childRunId) => navigate([...viewIds, childRunId]),
  }), [navigate, runId, source, viewIds]);

  // Focus follows the move: the breadcrumb after opening, the opening row after back (once the restored rows mount).
  // A path the app changed (browser back, a deep link) moves focus only if it was in this navigator.
  const rootElement = useRef<HTMLDivElement>(null);
  const crumbRef = useRef<HTMLSpanElement>(null);
  const shown = useRef<readonly string[]>([]);
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = viewIds;
    if (JSON.stringify(before) === viewKey) return;
    const active = document.activeElement;
    const here = intent.current || rootElement.current?.contains(active) || ((!active || active === document.body) && lastNavigator === id);
    intent.current = false;
    if (!here) return;
    // On a narrow bar the ancestry scrolls; keep the current run in view at its end.
    const breadcrumb = rootElement.current?.querySelector<HTMLElement>('[data-part="run-breadcrumb"]');
    if (breadcrumb) breadcrumb.scrollLeft = breadcrumb.scrollWidth;
    const left = before[viewIds.length];
    if (viewIds.length >= before.length || !left) return crumbRef.current?.focus({ preventScroll: true });
    let frame = 0;
    let tries = 0;
    const find = () => {
      const row = rootElement.current?.querySelector<HTMLElement>(`[data-part="sub-agent"][data-id="${CSS.escape(rowId(left))}"]`);
      if (row) row.focus({ preventScroll: true });
      else if (++tries < 5) frame = requestAnimationFrame(find);
    };
    find();
    return () => cancelAnimationFrame(frame);
  }, [viewKey]);

  // Escape goes back from inside the navigator, or from the page body when this was the last navigator used (an
  // approval's buttons unmount once it resolves, which drops focus to the body).
  const canGoBack = viewIds.length > 0 || pending;
  useEffect(() => {
    if (!canGoBack) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target as Node | null;
      const onBody = !target || target === document || target === document.body || target === document.documentElement;
      const here = rootElement.current?.contains(target) || (onBody && lastNavigator === id);
      if (event.key !== "Escape" || event.defaultPrevented || !here) return;
      event.preventDefault();
      back();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [back, canGoBack, id]);

  const stores = [store, ...view.map((entry) => entry.store)];
  const currentLabel = useRowLabel(stores.at(-2), viewIds.at(-1), label);
  const parentLabel = useRowLabel(stores.at(-3), viewIds.at(-2), label);
  const context = useMemo<RunNavigation>(() => ({
    path: [{ runId, label }, ...view.map((entry, index) => ({ runId: entry.runId, label: labelIn(index ? view[index - 1]!.store : store, entry.runId) }))],
    back,
  }), [back, label, runId, store, view]);
  const viewport = viewports.current.byPath;
  const Breadcrumb = view.length ? "nav" : "div";

  return (
    <div
      ref={rootElement}
      className={className}
      data-part="run-navigator"
      data-depth={view.length}
      aria-busy={pending || undefined}
      onFocusCapture={() => { lastNavigator = id; }}
      onPointerDownCapture={() => { lastNavigator = id; }}
    >
      <div data-part="run-bar">
        {view.length ? <button type="button" data-part="run-back" aria-label={`back to ${parentLabel}`} onClick={back}>back</button> : null}
        {/* A navigation landmark only while there is a path to go back along, named for the root so several navigators differ. */}
        <Breadcrumb data-part="run-breadcrumb" aria-label={view.length ? `run path: ${label}` : undefined}>
          <ol>
            {stores.map((_, index) => {
              const content = index > 0
                ? <RunStatus store={stores[index - 1]!} runId={viewIds[index - 1]!} />
                : <span data-part="run-label">{label}</span>;
              return (
                <li key={index}>
                  {index === view.length
                    ? <span data-part="run-crumb" aria-current="page" tabIndex={-1} ref={crumbRef}>{content}</span>
                    : <button type="button" data-part="run-crumb" onClick={() => navigate(viewIds.slice(0, index))}>{content}</button>}
                </li>
              );
            })}
          </ol>
        </Breadcrumb>
        {/* Always mounted, so screen readers announce what appears in it. */}
        <span data-part="run-notice" role="status" data-tone={notice.error ? "error" : undefined} title={notice.text || undefined}>{notice.text}</span>
        {barExtra}
      </div>
      <div data-part="run-scroll">
        <RunNavigationContext.Provider value={context}>
          <SubAgentNavigationProvider value={navigation}>
            <RunProvider store={stores.at(-1)!} highlight={highlight}>
              <Timeline
                renderers={renderers}
                virtual={virtual}
                aria-label={`${currentLabel} activity`}
                initialViewport={viewport.get(viewKey)}
                onViewport={(next) => { viewport.set(viewKey, next); }}
              />
            </RunProvider>
          </SubAgentNavigationProvider>
        </RunNavigationContext.Provider>
      </div>
    </div>
  );
}

const noRow = () => () => {};
/** A child's label from its row in the parent (it can change as the row fills in), or `fallback` for the root. */
function useRowLabel(store: RunStore | undefined, runId: string | undefined, fallback: string) {
  const subscribe = useCallback((listener: () => void) => (store && runId ? store.subscribe(rowId(runId), listener) : noRow()), [store, runId]);
  const read = () => (store && runId ? labelIn(store, runId) : fallback);
  return useSyncExternalStore(subscribe, read, read);
}

/** A child's crumb: its state mark (read from its row in the parent), its label, and a badge while it needs the user. */
function RunStatus({ store, runId }: { store: RunStore; runId: string }) {
  const read = () => {
    const item = store.getItem(rowId(runId));
    return item?.type === "sub_agent" ? `${item.status}|${item.urgency ?? ""}|${subAgentLabel(item)}` : `||${runId}`;
  };
  const subscribe = useCallback((listener: () => void) => store.subscribe(rowId(runId), listener), [store, runId]);
  const [status, urgency, ...label] = useSyncExternalStore(subscribe, read, read).split("|") as [SubAgentStatus | "", string, ...string[]];
  return (
    <>
      {status ? <span data-part="run-state" data-state={status} title={subAgentStatusText[status]} /> : null}
      <span data-part="run-label">{label.join("|")}</span>
      {urgency === "approval" || urgency === "input" ? <span data-part="run-urgency" data-urgency={urgency}>needs {urgency}</span> : null}
    </>
  );
}
