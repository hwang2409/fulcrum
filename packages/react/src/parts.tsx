import { memo, useLayoutEffect, useRef, useState, type ComponentType, type CSSProperties, type RefObject } from "react";
import type { RunItem } from "@fulcrum/core";
import { useItem, useItemSelector, useTimeline } from "./hooks.js";
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
};

/** Pass a stable `renderers` object (module scope or memoized) so appends do not re-render every row. */
export const Timeline = memo(function Timeline({ renderers, className, virtual, scrollRef }: TimelineProps) {
  const items = useTimeline();
  const enabled = virtual ?? items.length > 200;
  const list = useVirtualList(items, { estimateSize: estimateRowSize, scrollRef, enabled });
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const plainRef = useRef<HTMLDivElement>(null);
  const priorMode = useRef(enabled);
  const modeAnchor = useRef<{ id: string; offset: number } | null>(null);
  useLayoutEffect(() => {
    const container = scrollRef?.current ?? plainRef.current?.parentElement ?? null;
    if (!container) return;
    if (enabled) {
      if (!priorMode.current && modeAnchor.current) list.scrollToId(modeAnchor.current.id, modeAnchor.current.offset);
      if (list.snapshot.anchor) modeAnchor.current = { id: list.snapshot.anchor.id, offset: list.snapshot.anchor.offset };
    } else {
      if (priorMode.current && modeAnchor.current) {
        const index = items.findIndex(({ id }) => id === modeAnchor.current!.id);
        const row = index >= 0 ? plainRef.current!.children[index] as HTMLElement | undefined : undefined;
        if (row) container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top - modeAnchor.current.offset;
      }
      const capture = () => {
        const top = container.getBoundingClientRect().top;
        const children = [...(plainRef.current?.children ?? [])];
        const index = children.findIndex((child) => child.getBoundingClientRect().bottom > top);
        const row = index >= 0 ? children[index] as HTMLElement : undefined;
        if (row) modeAnchor.current = { id: items[index]!.id, offset: row.getBoundingClientRect().top - top };
      };
      capture();
      container.addEventListener("scroll", capture, { passive: true });
      priorMode.current = enabled;
      return () => container.removeEventListener("scroll", capture);
    }
    priorMode.current = enabled;
  }, [enabled, items, list.snapshot, scrollRef]);
  const debug = typeof location !== "undefined" && new URLSearchParams(location.search).get("virtualDebug") === "1";
  if (!enabled) {
    return (
      <div ref={plainRef} className={className} data-part="timeline" data-virtual="false">
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
            style={{ ...virtualRowStyle, transform: `translateY(${row.start}px)`, opacity: row === retainedRow ? 0 : undefined, pointerEvents: row === retainedRow ? "none" : undefined }}
          >
            <Row id={row.id} renderers={renderers} />
          </div>
        ))}
      </div>
      {debug ? (
        <output data-part="virtual-debug" style={{ position: "fixed", inset: "8px 8px auto auto", zIndex: 1000, maxWidth: "min(560px, 90vw)", maxHeight: "40vh", overflow: "auto", whiteSpace: "pre-wrap", font: "11px monospace", background: "#111", color: "#eee", padding: 8 }}>
          {JSON.stringify({ range: list.snapshot.range, visible: list.snapshot.visible, totalSize: list.snapshot.totalSize, scrollTop: list.snapshot.scrollTop, pinned: list.snapshot.pinned, actions: list.actions.slice(-8) }, null, 2)}
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
