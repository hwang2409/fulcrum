import { createContext, memo, useContext, useSyncExternalStore } from "react";
import type { RunItem, SubAgentStatus } from "@fulcrum/core";
import { useItem } from "./hooks.js";
import { boundText, MAX_SUMMARY_CHARS } from "./tools/common.js";

type SubAgentItem = Extract<RunItem, { type: "sub_agent" }>;

/** What a sub-agent row needs from the run navigator around it. With none, rows show without a drill-in. */
export type SubAgentNavigation = {
  open(item: SubAgentItem, label: string): void;
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

// One shared 1 Hz clock, running only while a mounted live row reads it.
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | undefined;
let clockNow = Date.now();
const subscribeClock = (listener: () => void) => {
  clockListeners.add(listener);
  if (!clockTimer) {
    clockNow = Date.now();
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      clockListeners.forEach((notify) => notify());
    }, 1_000);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0) {
      clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
};
const noClock = () => () => {};
const readClock = () => clockNow;
const useNow = (live: boolean) => useSyncExternalStore(live ? subscribeClock : noClock, readClock, readClock);

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
  const now = useNow(live);
  if (item?.type !== "sub_agent") return null;
  const status = subAgentStatusText[item.status];
  const name = item.name ? line(item.name) : undefined;
  const task = line(item.task ?? item.summary ?? (name ? "" : "sub-agent"));
  const until = ended ?? (live ? now : time(item.updatedAt));
  const elapsed = started === undefined || until === undefined ? undefined : elapsedText(until - started);
  const tools = item.toolCount === undefined ? undefined : `${item.toolCount} ${item.toolCount === 1 ? "tool" : "tools"}`;
  const meta = [elapsed, tools].filter(Boolean).join(" · ");
  const activity = item.latestActivity ?? (terminal.has(item.status) ? item.summary : undefined);
  const reason = navigation ? navigation.unavailable(item.childRunId) : "details unavailable";
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
  const attributes = { className, "data-part": "sub-agent", "data-kind": "sub_agent", "data-id": id, "data-state": item.status, "data-urgency": item.urgency };
  if (reason) return <div {...attributes} data-available="false">{content}</div>;
  const label = `open ${name ? `${name} sub-agent` : "sub-agent"}: ${[task, status, elapsed, tools].filter(Boolean).join(", ")}`;
  return (
    <button type="button" {...attributes} aria-label={label} onClick={() => navigation!.open(item, subAgentLabel(item))}>
      {content}
    </button>
  );
});
