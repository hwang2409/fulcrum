import { memo, useId, useState, type ComponentType } from "react";
import type { RunItem, ToolCall as ToolCallData } from "@fulcrum/core";
import { useItem, useItemSelector, useTimeline } from "./hooks.js";

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
  /** One-line header summary. Defaults to the view (`$ command` for shell), else the first string argument. */
  summary?: (item: ToolItem) => string;
  body?: ComponentType<ToolBodyProps>;
};

const defaultSummary = ({ view, tool_call }: ToolItem) => {
  switch (view?.kind) {
    case "shell": return `$ ${view.command}`;
    case "read": case "edit": case "write": return view.path;
    case "search": return view.path ? `${view.pattern} in ${view.path}` : view.pattern;
    case "fetch": return view.url ?? view.query;
  }
  return firstArgument(tool_call);
};
// shortcut: the first string argument is the most telling one for common tools (command, path, pattern, url); adapters that set a view do better.
const firstArgument = (call: ToolCallData) => {
  const args = call.arguments ?? {};
  const first = Object.values(args).find((value) => typeof value === "string");
  return typeof first === "string" ? first : Object.keys(args).length ? JSON.stringify(args) : "";
};
const json = (args: unknown) => JSON.stringify(args, null, 2);
const statusText: Record<ItemState, string> = {
  streaming: "running",
  done: "done",
  error: "failed",
  canceled: "canceled",
  pending: "needs approval",
  submitting: "sending", // Approval names the action instead: "approving" or "denying"
};

function Header({ item, state, status, summary }: { item: ToolItem; state: ItemState; status?: string; summary?: ToolViewProps["summary"] }) {
  return (
    <>
      <span data-part="tool-name">{item.tool_call.name}</span>
      <span data-part="tool-summary">{(summary ?? defaultSummary)(item)}</span>
      <span data-part="tool-status">{status ?? statusText[state]}</span>
    </>
  );
}

// Output first; the raw JSON arguments stay behind their own collapsed disclosure.
function GenericBody({ item: { tool_call: call }, output, state }: ToolBodyProps) {
  const asking = state === "pending" || state === "submitting";
  return (
    <>
      {output ? <pre data-part="tool-output">{output}</pre> : null}
      {asking ? (
        <pre data-part="tool-args">{json(call.arguments)}</pre>
      ) : (
        <details data-part="tool-args-details">
          <summary>arguments</summary>
          <pre data-part="tool-args">{json(call.arguments)}</pre>
        </details>
      )}
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

export const ToolCall = memo(function ToolCall({ id, className, summary, body: Body = GenericBody }: ItemProps & ToolViewProps) {
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
      data-tool={tool.tool_call.name}
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
  body: Body = GenericBody,
}: ItemProps & ToolViewProps & { onApprove?: Decide; onDeny?: Decide }) {
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
  const status = !pending ? "resolved" : sending ? (sending === "approve" ? "approving" : "denying") : undefined;
  return (
    <div
      className={className}
      role="group"
      aria-labelledby={labelId}
      aria-busy={state === "submitting" || undefined}
      data-part="approval"
      data-kind="approval"
      data-id={id}
      data-tool={tool_call.name}
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
          {onApprove || onDeny ? (
            <div data-part="approval-actions">
              {onApprove ? (
                <button type="button" data-action="approve" aria-disabled={sending ? true : undefined} onClick={decide("approve", onApprove)}>
                  approve
                </button>
              ) : null}
              {onDeny ? (
                <button type="button" data-action="deny" aria-disabled={sending ? true : undefined} onClick={decide("deny", onDeny)}>
                  deny
                </button>
              ) : null}
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
