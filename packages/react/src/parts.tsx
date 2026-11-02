import { memo, type ComponentType } from "react";
import type { RunItem } from "@fulcrum/core";
import { useItem, useItemSelector, useTimeline } from "./hooks.js";

export type ItemProps = { id: string; className?: string };
export type MarkdownContentProps = { source: string; streaming: boolean };
export type MessageProps = ItemProps & {
  /** Markdown is enabled for assistant messages when a renderer is supplied. */
  markdown?: ComponentType<MarkdownContentProps> | false;
  /** Use `all` to render user-role messages as markdown too. */
  markdownFor?: "assistant" | "all";
};
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
      {rich ? <Markdown source={text} streaming={item.active} /> : text}
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

/** Pass a stable `renderers` object (module scope or memoized) so appends do not re-render every row. */
export const Timeline = memo(function Timeline({ renderers, className }: { renderers?: Renderers; className?: string }) {
  const items = useTimeline();
  return (
    <div className={className} data-part="timeline">
      {items.map(({ id }) => (
        <Row key={id} id={id} renderers={renderers} />
      ))}
    </div>
  );
});
