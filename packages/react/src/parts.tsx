import { memo, useLayoutEffect, useRef, useState, type ComponentType, type CSSProperties, type RefObject } from "react";
import type { RunItem } from "@fulcrum/core";
import { useItem, useItemSelector, useTimelineSnapshot } from "./hooks.js";
import { useVirtualList } from "./virtual.js";

export type ItemProps = { id: string; className?: string };
/** Keys are item kinds (`message`, `tool`, `approval`, `user`, ...) or `tool:<name>`; a `tool:<name>` key wins over `tool`. */
export type Renderers = Partial<Record<string, ComponentType<{ id: string }>>>;
export type ItemState = "streaming" | "done" | "error" | "pending";

const pre = { whiteSpace: "pre-wrap" } as const;

const messageText = (item: Extract<RunItem, { type: "message" }>) =>
  item.text ??
  item.message.content
    .filter((block) => block.type === "text")
    .map((block) => String(block.text))
    .join("");

export const Message = memo(function Message({ id, className }: ItemProps) {
  const item = useItem(id);
  if (item?.type !== "message") return null;
  return (
    <div
      className={className}
      style={pre}
      data-part="message"
      data-kind="message"
      data-id={id}
      data-role={item.message.role}
      data-state={item.active ? "streaming" : "done"}
    >
      {messageText(item)}
    </div>
  );
});

export const ToolCall = memo(function ToolCall({ id, className }: ItemProps) {
  const item = useItem(id);
  if (item?.type !== "tool") return null;
  const state: ItemState = item.is_error ? "error" : item.active ? "streaming" : "done";
  const output = item.output || item.result?.content;
  return (
    <div className={className} data-part="tool" data-kind="tool" data-id={id} data-tool={item.tool_call.name} data-state={state}>
      <div data-part="tool-name">{item.tool_call.name}</div>
      <div data-part="tool-args" style={pre}>{JSON.stringify(item.tool_call.arguments)}</div>
      {output ? <div data-part="tool-output" style={pre}>{output}</div> : null}
    </div>
  );
});

export const Approval = memo(function Approval({
  id,
  className,
  onApprove,
  onDeny,
}: ItemProps & { onApprove?: (requestId: string) => void; onDeny?: (requestId: string) => void }) {
  const item = useItem(id);
  if (item?.type !== "approval" || item.request.type !== "approval_request") return null;
  const { request_id, tool_call } = item.request;
  const pending = !item.ended;
  return (
    <div className={className} data-part="approval" data-kind="approval" data-id={id} data-state={pending ? "pending" : "done"}>
      <div data-part="tool-name">{tool_call.name}</div>
      <div data-part="tool-args" style={pre}>{JSON.stringify(tool_call.arguments)}</div>
      {pending && onApprove ? <button type="button" data-action="approve" onClick={() => onApprove(request_id)}>approve</button> : null}
      {pending && onDeny ? <button type="button" data-action="deny" onClick={() => onDeny(request_id)}>deny</button> : null}
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
  /** Defaults to virtual mode above 200 rows. */
  virtual?: boolean;
  /** Scroll viewport. When omitted, Timeline uses its direct parent. */
  scrollRef?: RefObject<HTMLElement | null>;
  /** Accessible name for the chronological activity log. */
  "aria-label"?: string;
};

/** Pass a stable `renderers` object (module scope or memoized) so appends do not re-render every row. */
export const Timeline = memo(function Timeline({ renderers, className, virtual, scrollRef, "aria-label": ariaLabel = "agent activity" }: TimelineProps) {
  const { items, change } = useTimelineSnapshot();
  const enabled = virtual ?? items.length > 200;
  const list = useVirtualList(items, { estimateSize: estimateRowSize, scrollRef, enabled, outlineUpdate: change });
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
      <div ref={plainRef} className={className} data-part="timeline" data-virtual="false" role="log" aria-label={ariaLabel} aria-live="polite" aria-relevant="additions">
        {items.map(({ id }) => <Row key={id} id={id} renderers={renderers} />)}
      </div>
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
        aria-live="polite"
        aria-relevant="additions"
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
