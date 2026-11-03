import { createContext, memo, useCallback, useContext, useRef, useSyncExternalStore } from "react";
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
export const SubAgentContext = createContext<SubAgentNavigation | null>(null);

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
/** The shared clock while `row` (an element ref) is live; `element` changes when the row's element is replaced. */
const useNow = (live: boolean, row: { current: Element | null }, element: string) => {
  const subscribe = useCallback((notify: () => void) => (row.current ? watchRow(row.current, notify) : noClock()), [row, element]);
  return useSyncExternalStore(live ? subscribe : noClock, readClock, readClock);
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

/**
 * The compact, fixed-height row for a child run. Inside a `RunNavigator` whose source can open the run, the whole row
 * is one button that opens it; otherwise it shows the reason in place of the drill-in.
 */
export const SubAgent = memo(function SubAgent({ id, className }: { id: string; className?: string }) {
  const item = useItem(id);
  const navigation = useContext(SubAgentContext);
  const started = item?.type === "sub_agent" ? time(item.startedAt) : undefined;
  const ended = item?.type === "sub_agent" ? time(item.endedAt) : undefined;
  const live = item?.type === "sub_agent" && started !== undefined && ended === undefined && !terminal.has(item.status);
  const reason = item?.type !== "sub_agent" ? undefined : navigation ? navigation.unavailable(item.childRunId) : "details unavailable";
  const element = useRef<HTMLElement | null>(null);
  const setElement = useCallback((node: HTMLElement | null) => { element.current = node; }, []);
  const now = useNow(live, element, reason ? "div" : "button");
  if (item?.type !== "sub_agent") return null;
  const status = subAgentStatusText[item.status];
  const name = item.name ? line(item.name) : undefined;
  const task = line(item.task ?? item.summary ?? (name ? "" : "sub-agent"));
  const until = ended ?? (live ? now : time(item.updatedAt));
  const elapsed = started === undefined || until === undefined ? undefined : elapsedText(until - started);
  const tools = item.toolCount === undefined ? undefined : `${item.toolCount} ${item.toolCount === 1 ? "tool" : "tools"}`;
  const meta = [elapsed, tools].filter(Boolean).join(" · ");
  const activity = item.latestActivity ?? (terminal.has(item.status) ? item.summary : undefined);
  const content = (
    <>
      <span data-part="sub-agent-head">
        <span data-part="sub-agent-status">{status}</span>
        {name ? <span data-part="sub-agent-name">{name}</span> : null}
        {task ? <span data-part="sub-agent-task">{task}</span> : null}
        {meta ? <span data-part="sub-agent-meta">{meta}</span> : null}
        {reason ? null : <span data-part="sub-agent-open" aria-hidden="true">open</span>}
      </span>
      <span data-part="sub-agent-line">
        {reason ? <span data-part="sub-agent-reason">{line(reason)}</span> : null}
        {activity ? <span data-part="sub-agent-activity">{line(activity)}</span> : null}
      </span>
    </>
  );
  // The row is one fixed-height strip that ellipsizes; the title and the accessible name carry the full text.
  const title = [name, task, meta, activity && line(activity), reason && line(reason)].filter(Boolean).join("\n");
  const attributes = { className, title, "data-part": "sub-agent", "data-kind": "sub_agent", "data-id": id, "data-state": item.status, "data-urgency": item.urgency };
  if (reason) return <div {...attributes} ref={setElement} data-available="false">{content}</div>;
  const label = `open ${name ? `${name} sub-agent` : "sub-agent"}: ${[task, status, elapsed, tools].filter(Boolean).join(", ")}`;
  return (
    <button type="button" {...attributes} ref={setElement} aria-label={label} onClick={() => navigation!.open(item.childRunId)}>
      {content}
    </button>
  );
});
