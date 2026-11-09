import { createContext, memo, useCallback, useContext, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { RunItem, SubAgentStatus } from "@fulcrum/core";
import { useItem } from "./hooks.js";
import { boundText, MAX_SUMMARY_CHARS } from "./tools/common.js";

type SubAgentItem = Extract<RunItem, { type: "sub_agent" }>;

/** What a sub-agent row needs from the run navigator around it. With none, rows show without a drill-in. */
export type SubAgentNavigation = {
  open(runId: string): void;
  /** Why this child cannot open, or undefined when it can. */
  unavailable(runId: string): string | undefined;
};
const SubAgentContext = createContext<SubAgentNavigation | null>(null);

/** Supplies child-run navigation to standalone sub-agent rows in a custom shell. */
export function SubAgentNavigationProvider({ value, children }: {
  readonly value: SubAgentNavigation | null;
  readonly children: ReactNode;
}): ReactNode {
  return <SubAgentContext.Provider value={value}>{children}</SubAgentContext.Provider>;
}

export const subAgentStatusText: Record<SubAgentStatus, string> = {
  running: "running",
  waiting_approval: "needs approval",
  waiting_input: "needs input",
  idle: "idle",
  done: "done",
  error: "failed",
  canceled: "canceled",
};
const terminal = new Set<SubAgentStatus>(["done", "error", "canceled"]);
const line = (text: string) => boundText(text.replace(/\s+/g, " ").trim(), MAX_SUMMARY_CHARS).text;
export const subAgentLabel = (item: SubAgentItem) => line(item.name ?? item.task ?? item.summary ?? "sub-agent");

// One shared 1 Hz clock. It ticks only while a live row is on screen (inside every clipping scroll box, so virtual
// overscan rows do not count) and the page is visible. A row coming into view, or the page coming back, reads the
// time at once instead of waiting for the next tick.
const liveRows = new Map<Element, () => void>();
const visibleRows = new Set<() => void>();
let rowObserver: IntersectionObserver | undefined;
let clockTimer: ReturnType<typeof setInterval> | undefined;
let clockNow = Date.now();
const tick = () => {
  clockNow = Date.now();
  visibleRows.forEach((notify) => notify());
};
const syncClock = () => {
  const run = visibleRows.size > 0 && !document.hidden;
  if (run && !clockTimer) {
    tick();
    clockTimer = setInterval(tick, 1_000);
  } else if (!run && clockTimer) {
    clearInterval(clockTimer);
    clockTimer = undefined;
  }
};
const onRowsSeen = (entries: IntersectionObserverEntry[]) => {
  for (const entry of entries) {
    const notify = liveRows.get(entry.target);
    if (!notify) continue;
    if (!entry.isIntersecting) visibleRows.delete(notify);
    else if (!visibleRows.has(notify)) {
      visibleRows.add(notify);
      if (clockTimer) notify();
    }
  }
  syncClock();
};
const watchRow = (row: Element, notify: () => void) => {
  if (!liveRows.size) document.addEventListener("visibilitychange", syncClock);
  liveRows.set(row, notify);
  // Without IntersectionObserver (old engines), every live row counts as on screen.
  if (typeof IntersectionObserver === "undefined") onRowsSeen([{ target: row, isIntersecting: true } as IntersectionObserverEntry]);
  else (rowObserver ??= new IntersectionObserver(onRowsSeen)).observe(row);
  return () => {
    liveRows.delete(row);
    visibleRows.delete(notify);
    rowObserver?.unobserve(row);
    if (!liveRows.size) {
      rowObserver?.disconnect();
      rowObserver = undefined;
      document.removeEventListener("visibilitychange", syncClock);
    }
    syncClock();
  };
};
const noClock = () => () => {};
const readClock = () => clockNow;
/** Subscribes `row` (an element ref) to the shared clock while live; `element` changes when the row's element is replaced. */
const useClock = (live: boolean, row: { current: Element | null }, element: string) => {
  const subscribe = useCallback((notify: () => void) => (row.current ? watchRow(row.current, notify) : noClock()), [row, element]);
  useSyncExternalStore(live ? subscribe : noClock, readClock, readClock);
};

const elapsedText = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
};
const time = (value?: string) => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? undefined : parsed;
};

/** Everything a sub-agent row shows, derived from its item alone. `label` is the accessible name of the open button. */
export type SubAgentRowModel = {
  /** Running with a start time and no end: the elapsed time ticks. */
  readonly live: boolean;
  /** The state in words: the row's badge. */
  readonly status: string;
  readonly name?: string;
  readonly task?: string;
  /** Elapsed time and tool count, as "2m 14s · 7 tools". */
  readonly meta?: string;
  readonly activity?: string;
  /** Why the row cannot open; undefined when it can. */
  readonly reason?: string;
  readonly canOpen: boolean;
  /** The full text, one fact a line, for the title tooltip (the row itself ellipsizes). */
  readonly title: string;
  readonly label: string;
};

/** Derives a sub-agent row from its item, the navigator around it (none: no drill-in), and the clock's time in ms. */
export function subAgentRow(item: SubAgentItem, navigation: SubAgentNavigation | null, now: number): SubAgentRowModel {
  const started = time(item.startedAt);
  const ended = time(item.endedAt);
  const live = started !== undefined && ended === undefined && !terminal.has(item.status);
  const reason = navigation ? navigation.unavailable(item.childRunId) : "details unavailable";
  const status = subAgentStatusText[item.status];
  const name = item.name ? line(item.name) : undefined;
  const task = line(item.task ?? item.summary ?? (name ? "" : "sub-agent")) || undefined;
  const until = ended ?? (live ? now : time(item.updatedAt));
  const elapsed = started === undefined || until === undefined ? undefined : elapsedText(until - started);
  const tools = item.toolCount === undefined ? undefined : `${item.toolCount} ${item.toolCount === 1 ? "tool" : "tools"}`;
  const meta = [elapsed, tools].filter(Boolean).join(" · ") || undefined;
  const latest = item.latestActivity ?? (terminal.has(item.status) ? item.summary : undefined);
  const activity = latest ? line(latest) : undefined;
  const why = reason ? line(reason) : undefined;
  return {
    live, status, name, task, meta, activity, reason: why, canOpen: !why,
    title: [name, task, meta, activity, why].filter(Boolean).join("\n"),
    label: `open ${name ? `${name} sub-agent` : "sub-agent"}: ${[task, status, elapsed, tools].filter(Boolean).join(", ")}`,
  };
}

/**
 * The compact, fixed-height row for a child run. Inside a `RunNavigator` whose source can open the run, the whole row
 * is one button that opens it; otherwise it shows the reason in place of the drill-in. `subAgentRow` derives its text.
 */
export const SubAgent = memo(function SubAgent({ id, className }: { id: string; className?: string }) {
  const item = useItem(id);
  const navigation = useContext(SubAgentContext);
  const element = useRef<HTMLElement | null>(null);
  const setElement = useCallback((node: HTMLElement | null) => { element.current = node; }, []);
  const row = item?.type === "sub_agent" ? subAgentRow(item, navigation, clockNow) : undefined;
  // Re-renders this row on each tick while it is live and on screen; `clockNow` above is the tick's time.
  useClock(!!row?.live, element, row?.canOpen ? "button" : "div");
  if (!row || item?.type !== "sub_agent") return null;
  const content = (
    <>
      <span data-part="sub-agent-head">
        <span data-part="sub-agent-status">{row.status}</span>
        {row.name ? <span data-part="sub-agent-name">{row.name}</span> : null}
        {row.task ? <span data-part="sub-agent-task">{row.task}</span> : null}
        {row.meta ? <span data-part="sub-agent-meta">{row.meta}</span> : null}
        {row.canOpen ? <span data-part="sub-agent-open" aria-hidden="true">open</span> : null}
      </span>
      <span data-part="sub-agent-line">
        {row.reason ? <span data-part="sub-agent-reason">{row.reason}</span> : null}
        {row.activity ? <span data-part="sub-agent-activity">{row.activity}</span> : null}
      </span>
    </>
  );
  const attributes = { className, title: row.title, ref: setElement, "data-part": "sub-agent", "data-kind": "sub_agent", "data-id": id, "data-state": item.status, "data-urgency": item.urgency };
  return row.canOpen
    ? <button type="button" {...attributes} aria-label={row.label} onClick={() => navigation!.open(item.childRunId)}>{content}</button>
    : <div {...attributes} data-available="false">{content}</div>;
});
