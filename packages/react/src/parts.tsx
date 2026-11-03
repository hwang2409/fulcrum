import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentType, type CSSProperties, type RefObject } from "react";
import type { RunItem } from "@fulcrum/core";
import { useItem, useItemSelector, useRunStore, useTimelineSnapshot } from "./hooks.js";
import { boundText, duration, MAX_SUMMARY_CHARS } from "./tools/common.js";
import { ToolBody, toolSummary } from "./tools/index.js";
import { useVirtualList } from "./virtual.js";

export type ItemProps = { id: string; className?: string };
export type MarkdownContentProps = { id: string; source: string; streaming: boolean };
export type MessageProps = ItemProps & {
  /** Markdown is enabled for assistant messages when a renderer is supplied. */
  markdown?: ComponentType<MarkdownContentProps> | false;
  /** Use `all` to render user-role messages as markdown too. */
  markdownFor?: "assistant" | "all";
};
/** Keys are item kinds (`message`, `tool`, `approval`, `user`, ...) or `tool:<name>`; a `tool:<name>` key wins over `tool`. */
export type Renderers = Partial<Record<string, ComponentType<{ id: string }>>>;
export type ItemState = "streaming" | "done" | "error" | "canceled" | "pending" | "submitting";

const pre = { whiteSpace: "pre-wrap" } as const;

const messageText = (item: Extract<RunItem, { type: "message" }>) =>
  item.text ??
  item.message.content
    .filter((block) => block.type === "text")
    .map((block) => String(block.text))
    .join("");

export const Message = memo(function Message({
  id,
  className,
  markdown: Markdown,
  markdownFor = "assistant",
}: MessageProps) {
  const item = useItem(id);
  if (item?.type !== "message") return null;
  const text = messageText(item);
  const rich = Markdown && (markdownFor === "all" || item.message.role === "assistant");
  return (
    <div
      className={className}
      style={rich ? undefined : pre}
      data-part="message"
      data-kind="message"
      data-id={id}
      data-role={item.message.role}
      data-state={item.active ? "streaming" : "done"}
      data-format={rich ? "markdown" : "text"}
    >
      {rich ? <Markdown id={id} source={text} streaming={item.active} /> : text}
    </div>
  );
});

export type ToolItem = Extract<RunItem, { type: "tool" }>;
/**
 * What a tool body gets. `item` is the normalized tool item, with its agent-neutral `view` hint when the adapter set
 * one; `output` is the streamed output plus a final result that adds to it. Approvals pass the requested call (and
 * the request's view) as an active tool item with no output and state "pending" or "submitting".
 */
export type ToolBodyProps = { item: ToolItem; output: string; state: ItemState };
/**
 * Per-tool customization shared by ToolCall and Approval. They own the one header row (name, summary, status), the
 * disclosure, and the approval actions; `body` renders only what goes inside `data-part="tool-body"`.
 */
export type ToolViewProps = {
  /** One-line header summary. Defaults to `toolSummary`: the view (`$ command` for shell), else the first string argument. */
  summary?: (item: ToolItem) => string;
  /** Defaults to `ToolBody`: the card for the item's view kind, or the generic card. */
  body?: ComponentType<ToolBodyProps>;
};

const statusText: Record<ItemState, string> = {
  streaming: "running",
  done: "done",
  error: "failed",
  canceled: "canceled",
  pending: "needs approval",
  submitting: "sending", // Approval names the action instead: "approving" or "denying"
};

// Harness tool names are free strings; a blank one still needs a readable label.
const isBlank = (name: string) => name.trim() === "";
const toolLabel = (name: string) => boundText(isBlank(name) ? "unnamed tool" : name, MAX_SUMMARY_CHARS).text;
// A cut name gets a longer, still bounded hover title; the exact name stays in app state only.
const MAX_TITLE_CHARS = 1_000;
function ToolName({ name }: { name: string }) {
  const label = toolLabel(name);
  const title = !isBlank(name) && label !== name ? boundText(name, MAX_TITLE_CHARS).text : undefined;
  return <span data-part="tool-name" data-blank={isBlank(name) ? "" : undefined} title={title}>{label}</span>;
}

function Header({ item, state, status, summary }: { item: ToolItem; state: ItemState; status?: string; summary?: ToolViewProps["summary"] }) {
  const ms = item.view?.durationMs;
  const rawSummary = (summary ?? toolSummary)(item);
  const oneLineSummary = rawSummary.replace(/\s+/g, " ").trim();
  return (
    <>
      <ToolName name={item.tool_call.name} />
      <span data-part="tool-summary">{boundText(oneLineSummary, MAX_SUMMARY_CHARS).text}</span>
      <span data-part="tool-status">
        {status ?? statusText[state]}
        {ms !== undefined ? <span data-part="tool-duration">{duration(ms)}</span> : null}
      </span>
    </>
  );
}

const SHORT_OUTPUT_LINES = 8;
/* Open while running (live progress) or after a failure (the reason), and for short output, which is usually the
   answer ("1 replacement", "42 pass"). Long or empty output starts collapsed so the header row carries the run.
   Set once at mount, so the user's own toggle is never overridden while output streams in. */
const openByDefault = (item: ToolItem | undefined, output: string) =>
  !item || item.active || item.is_error || (output !== "" && output.length < 1200 && output.split("\n", SHORT_OUTPUT_LINES + 2).length <= SHORT_OUTPUT_LINES + 1);

// Streamed output, then the final result when it adds something (an error message, a cancel reason).
const toolOutput = ({ output, result }: ToolItem) => {
  const content = result?.content ?? "";
  if (!content || output.includes(content)) return output;
  return output ? `${output}${output.endsWith("\n") ? "" : "\n"}${content}` : content;
};
const toolState = (item: ToolItem): ItemState =>
  item.canceled ? "canceled" : item.is_error ? "error" : item.active ? "streaming" : "done";

export const ToolCall = memo(function ToolCall({ id, className, summary, body: Body = ToolBody }: ItemProps & ToolViewProps) {
  const item = useItem(id);
  const tool = item?.type === "tool" ? item : undefined;
  const [open] = useState(() => openByDefault(tool, tool ? toolOutput(tool) : ""));
  if (!tool) return null;
  const state = toolState(tool);
  const output = toolOutput(tool);
  return (
    <details
      className={className}
      open={open}
      data-part="tool"
      data-kind="tool"
      data-id={id}
      data-tool={toolLabel(tool.tool_call.name)}
      data-tool-view={tool.view?.kind}
      data-state={state}
    >
      <summary data-part="tool-header">
        <Header item={tool} state={state} summary={summary} />
      </summary>
      <div data-part="tool-body">
        <Body item={tool} output={output} state={state} />
      </div>
    </details>
  );
});

type Decide = (requestId: string) => void | Promise<unknown>;

export const Approval = memo(function Approval({
  id,
  className,
  onApprove,
  onDeny,
  summary,
  body: Body = ToolBody,
  disabledReason,
}: ItemProps & ToolViewProps & { onApprove?: Decide; onDeny?: Decide; disabledReason?: string }) {
  const item = useItem(id);
  const [sending, setSending] = useState<"approve" | "deny">();
  const labelId = useId();
  if (item?.type !== "approval" || item.request.type !== "approval_request") return null;
  const { request_id, tool_call, view } = item.request;
  const requested: ToolItem = { id, type: "tool", tool_call, view, output: "", version: 0, active: true, is_error: false, canceled: false };
  const pending = !item.ended;
  const state: ItemState = !pending ? "done" : sending ? "submitting" : "pending";
  // One decision per request: later clicks are ignored until the handler fails or the request resolves.
  const decide = (action: "approve" | "deny", handler: Decide) => () => {
    if (sending) return;
    setSending(action);
    const retry = () => setSending(undefined);
    try {
      Promise.resolve(handler(request_id)).catch(retry);
    } catch (error) {
      retry();
      throw error;
    }
  };
  const endReason = item.ended && "data" in item.ended ? String(item.ended.data?.reason ?? "") : "";
  const status = !pending ? ({ controller_disconnected: "connection lost", connection_lost: "connection lost", grace_expired: "timed out while disconnected", turn_canceled: "turn canceled", timeout: "timed out", shutdown: "server shut down", child_cleanup: "cleaned up" } as Record<string, string>)[endReason] ?? (endReason ? "ended" : "resolved") : sending ? (sending === "approve" ? "approving" : "denying") : undefined;
  return (
    <div
      className={className}
      role="group"
      aria-labelledby={labelId}
      aria-busy={state === "submitting" || undefined}
      data-part="approval"
      data-kind="approval"
      data-id={id}
      data-tool={toolLabel(tool_call.name)}
      data-tool-view={view?.kind}
      data-state={state}
    >
      <div data-part="tool-header" id={labelId}>
        <Header item={requested} state={state} status={status} summary={summary} />
      </div>
      {pending ? (
        <>
          <div data-part="tool-body">
            <Body item={requested} output="" state={state} />
          </div>
          {onApprove || onDeny || disabledReason ? (
            <div data-part="approval-actions">
              {onApprove || disabledReason ? <button type="button" data-action="approve" disabled={!onApprove || Boolean(sending)} aria-disabled={!onApprove || Boolean(sending) ? true : undefined} onClick={onApprove ? decide("approve", onApprove) : undefined}>approve</button> : null}
              {onDeny || disabledReason ? <button type="button" data-action="deny" disabled={!onDeny || Boolean(sending)} aria-disabled={!onDeny || Boolean(sending) ? true : undefined} onClick={onDeny ? decide("deny", onDeny) : undefined}>deny</button> : null}
              {disabledReason ? <span role="status">{disabledReason}</span> : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
});

const itemLabel = (item: RunItem) => {
  if (item.type === "user" && item.event.type === "user_message") return item.event.text;
  if (item.type === "error" && item.event.type === "error") return item.event.error.message;
  if (item.type === "unknown" && item.event.type === "unknown") return item.event.name;
  return item.type;
};

/** Generic part for kinds without a renderer (user, error, notification, unknown, ...). */
export const Fallback = memo(function Fallback({ id, className }: ItemProps) {
  const item = useItem(id);
  if (!item) return null;
  return (
    <div className={className} style={pre} data-part="item" data-kind={item.type} data-id={id} data-state={item.type === "error" ? "error" : "done"}>
      {itemLabel(item)}
    </div>
  );
});

const defaults: Renderers = { message: Message, tool: ToolCall, approval: Approval };

export const announcementForItem = (item: RunItem): string | null => {
  switch (item.type) {
    case "message": return item.active ? null : `${item.message.role} replied`;
    case "tool": {
      if (item.active) return null;
      if (item.canceled) return `tool ${toolLabel(item.tool_call.name)} canceled`;
      const result = item.result?.content ?? item.output;
      const exitCode = item.view?.kind === "shell" ? item.view.exitCode : undefined;
      const parsedCode = exitCode ?? result.match(/\b(?:exit(?:ed)?(?: with code)?|code)\s+(-?\d+)\b/i)?.[1];
      return `tool ${toolLabel(item.tool_call.name)} finished${parsedCode === undefined ? "" : `: exit ${parsedCode}`}`;
    }
    case "approval":
      return !item.ended && item.request.type === "approval_request" ? `approval needed: ${toolLabel(item.request.tool_call.name)}` : null;
    case "error": return item.event.type === "error" ? `error: ${item.event.error.message}` : null;
    case "notification": return "new notification";
    case "unknown": return "new activity";
    case "sub_agent": return ["done", "error", "canceled"].includes(item.status) ? `sub-agent ${item.status}` : null;
    case "user": return null;
  }
};

const liveRegionStyle: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

function AnnouncementTracker({ id, announce }: { id: string; announce(id: string, text: string): void }) {
  const item = useItem(id);
  const text = item ? announcementForItem(item) : null;
  useEffect(() => { if (text) announce(id, text); }, [announce, id, text]);
  return null;
}

function LiveAnnouncer({ items, change }: { items: readonly { id: string }[]; change: { type: "append" | "prepend"; count: number } | null }) {
  const initialized = useRef(false);
  const pending = useRef<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [watched, setWatched] = useState<readonly string[]>([]);
  const [text, setText] = useState("");
  const announce = useCallback((id: string, next: string) => {
    pending.current.push(next);
    setWatched((current) => current.filter((candidate) => candidate !== id));
    if (timer.current !== null) return;
    setText("");
    timer.current = setTimeout(() => {
      timer.current = null;
      const announcements = pending.current.splice(0);
      setText(announcements.length === 1 ? announcements[0]! : `${announcements.length} new items`);
    }, 1_000);
  }, []);
  useLayoutEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      return;
    }
    const present = new Set(items.map(({ id }) => id));
    const appended = change?.type === "append" && change.count > 0 ? items.slice(-change.count).map(({ id }) => id) : [];
    setWatched((current) => [...new Set([...current.filter((id) => present.has(id)), ...appended])]);
  }, [change, items]);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  return (
    <>
      {watched.map((id) => <AnnouncementTracker key={id} id={id} announce={announce} />)}
      <div data-part="timeline-live" aria-live="polite" aria-atomic="true" style={liveRegionStyle}>{text}</div>
    </>
  );
}

// Subscribes to a string key only, so text deltas never re-render the row.
const Row = memo(function Row({ id, renderers }: { id: string; renderers?: Renderers }) {
  const kind = useItemSelector(id, (item) => item?.type);
  const tool = useItemSelector(id, (item) =>
    item?.type === "tool" ? item.tool_call.name : undefined,
  );
  const Part =
    (tool && renderers?.[`tool:${tool}`]) || (kind && (renderers?.[kind] ?? defaults[kind])) || Fallback;
  return <Part id={id} />;
});

const estimateRowSize = (kind: string) => kind === "tool" ? 120 : kind === "approval" ? 100 : kind === "message" ? 72 : 48;
const virtualContainerStyle: CSSProperties = { position: "relative", display: "block", contain: "size style", overflowAnchor: "none" };
const virtualRowStyle: CSSProperties = { position: "absolute", insetInline: 0, display: "flex", flexDirection: "column", boxSizing: "border-box", paddingBlockEnd: "var(--fulcrum-gap, 12px)", contain: "layout style" };

export type TimelineProps = {
  renderers?: Renderers;
  className?: string;
  /** Defaults to virtual mode above 200 rows. A replacement RunProvider store starts pinned to the bottom. */
  virtual?: boolean;
  /** Scroll viewport. When omitted, Timeline uses its direct parent. */
  scrollRef?: RefObject<HTMLElement | null>;
  /** Accessible name for the chronological activity log. */
  "aria-label"?: string;
};

const storeKeys = new WeakMap<object, number>();
let nextStoreKey = 0;
const keyForStore = (store: object) => {
  let key = storeKeys.get(store);
  if (key === undefined) { key = nextStoreKey++; storeKeys.set(store, key); }
  return key;
};

/** Pass a stable `renderers` object (module scope or memoized) so appends do not re-render every row. */
export const Timeline = memo(function Timeline(props: TimelineProps) {
  const store = useRunStore();
  return <TimelineForStore key={keyForStore(store)} {...props} store={store} />;
});

const TimelineForStore = memo(function TimelineForStore({ store, renderers, className, virtual, scrollRef, "aria-label": ariaLabel = "agent activity" }: TimelineProps & { store: object }) {
  const { items, change } = useTimelineSnapshot();
  const enabled = virtual ?? items.length > 200;
  const list = useVirtualList(items, { estimateSize: estimateRowSize, scrollRef, enabled, outlineUpdate: change, resetKey: store });
  const initialScroll = useRef(enabled);
  useLayoutEffect(() => {
    if (!enabled) initialScroll.current = true;
    else if (initialScroll.current && list.snapshot.totalSize > 0) {
      initialScroll.current = false;
      list.scrollToEnd();
    }
  }, [enabled, list.scrollToEnd, list.snapshot.totalSize]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const plainRef = useRef<HTMLDivElement>(null);
  const priorMode = useRef(enabled);
  const modeAnchor = useRef<{ id: string; offset: number } | null>(null);
  useLayoutEffect(() => {
    const container = scrollRef?.current ?? plainRef.current?.parentElement ?? null;
    if (!container || priorMode.current === enabled) return;
    if (enabled && modeAnchor.current) list.scrollToId(modeAnchor.current.id, modeAnchor.current.offset);
    if (!enabled && modeAnchor.current) {
      const index = items.findIndex(({ id }) => id === modeAnchor.current!.id);
      const row = index >= 0 ? plainRef.current!.children[index] as HTMLElement | undefined : undefined;
      if (row) container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top - modeAnchor.current.offset;
    }
    priorMode.current = enabled;
  }, [enabled, items, list.scrollToId, scrollRef]);
  useLayoutEffect(() => {
    if (enabled && list.snapshot.anchor) modeAnchor.current = { id: list.snapshot.anchor.id, offset: list.snapshot.anchor.offset };
  }, [enabled, list.snapshot.anchor]);
  useLayoutEffect(() => {
    if (enabled) return;
    const container = scrollRef?.current ?? plainRef.current?.parentElement ?? null;
    if (!container) return;
    const capture = () => {
      const top = container.getBoundingClientRect().top;
      const children = [...(plainRef.current?.children ?? [])];
      const index = children.findIndex((child) => child.getBoundingClientRect().bottom > top);
      const row = index >= 0 ? children[index] as HTMLElement : undefined;
      if (row) modeAnchor.current = { id: items[index]!.id, offset: row.getBoundingClientRect().top - top };
    };
    capture();
    container.addEventListener("scroll", capture, { passive: true });
    return () => container.removeEventListener("scroll", capture);
  }, [enabled, items, scrollRef]);
  if (!enabled) {
    return (
      <>
        <div ref={plainRef} className={className} data-part="timeline" data-virtual="false" role="log" aria-label={ariaLabel} aria-live="off">
          {items.map(({ id }) => <Row key={id} id={id} renderers={renderers} />)}
        </div>
        <LiveAnnouncer items={items} change={change} />
      </>
    );
  }
  const mounted = list.snapshot.rows;
  const retained = focusedId && !mounted.some(({ id }) => id === focusedId)
    ? items.findIndex(({ id }) => id === focusedId)
    : -1;
  const retainedRow = retained >= 0 ? { ...items[retained]!, index: retained, start: -10_000, size: 0, loaded: true } : null;
  return (
    <>
      <div
        ref={list.timelineRef}
        className={className}
        data-part="timeline"
        data-virtual="true"
        data-unseen-count={list.unseenCount}
        role="log"
        aria-label={ariaLabel}
        aria-live="off"
        style={{ ...virtualContainerStyle, height: list.snapshot.totalSize }}
        onFocusCapture={(event) => setFocusedId(event.target instanceof Element ? event.target.closest<HTMLElement>("[data-virtual-id]")?.dataset.virtualId ?? null : null)}
        onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedId(null); }}
      >
        {[...mounted, ...(retainedRow ? [retainedRow] : [])].map((row) => (
          <div
            key={row.id}
            ref={list.observeRow(row.id)}
            data-virtual-id={row.id}
            data-virtual-index={row.index}
            role="article"
            aria-setsize={items.length}
            aria-posinset={row.index + 1}
            tabIndex={row === retainedRow ? -1 : 0}
            onKeyDown={(event) => {
              const nextIndex = row.index + (event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0);
              if (nextIndex === row.index || nextIndex < 0 || nextIndex >= items.length) return;
              event.preventDefault();
              const parent = event.currentTarget.parentElement!;
              list.scrollToId(items[nextIndex]!.id);
              requestAnimationFrame(() => (parent.children[nextIndex - list.snapshot.range.start] as HTMLElement | undefined)?.focus());
            }}
            style={{ ...virtualRowStyle, transform: `translateY(${row.start - list.snapshot.pendingJump}px)`, opacity: row === retainedRow ? 0 : undefined, pointerEvents: row === retainedRow ? "none" : undefined }}
          >
            <Row id={row.id} renderers={renderers} />
          </div>
        ))}
      </div>
      <LiveAnnouncer items={items} change={change} />
      {list.debug ? (
        <output data-part="virtual-debug">
          {list.debug}
        </output>
      ) : null}
      {list.unseenCount > 0 ? (
        <button type="button" data-part="jump-to-latest" data-unseen-count={list.unseenCount} onClick={list.scrollToEnd}>
          jump to latest ({list.unseenCount})
        </button>
      ) : null}
    </>
  );
});
