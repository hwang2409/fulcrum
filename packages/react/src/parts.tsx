import { memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { ApprovalDecision, OutlineChange, RunEvent, RunItem } from "@fulcrum/core";
import { streamTail } from "@fulcrum/core/internal";
import type { VirtualCache } from "@fulcrum/virtual";
import { useItem, useItemSelector, useRunDiagnostics, useRunRetry, useRunStore, useTimelineSnapshot, type RunStore } from "./hooks.js";
import { HighlightContext, Tokens, useTokens } from "./highlight.js";
import { boundText, duration, GrownText, lineCount, MAX_SUMMARY_CHARS } from "./tools/common.js";
import { diffStatText } from "./tools/diff.js";
import { argumentSummary, ToolBody, toolSummary } from "./tools/index.js";
import { Notification, notificationText } from "./notification.js";
import { SubAgent, subAgentLabel, subAgentStatusText } from "./sub-agent.js";
import { useVirtualList } from "./virtual.js";
import { useWarm, warmToolBody } from "./warm.js";
import { Message, ToolResultBlocks } from "./content.js";
import { UserMessageContent } from "./user-message.js";
import { NewestRowProvider, newestStreamableRow } from "./newest-row.js";

declare global { var __FULCRUM_DEV__: boolean | undefined; }

export type ItemProps = { id: string; className?: string };
/** Keys are item kinds (`message`, `tool`, `approval`, `user`, ...) or `tool:<name>`; a `tool:<name>` key wins over `tool`. */
export type Renderers = Partial<Record<string, ComponentType<{ id: string }>>>;
export type ItemState = "streaming" | "done" | "error" | "canceled" | "pending" | "submitting" | "reconnecting" | "resolving";

const pre = { whiteSpace: "pre-wrap" } as const;

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
  reconnecting: "reconnecting",
  resolving: "resolving",
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

const oneLine = (text: string) => boundText(text.replace(/\s+/g, " ").trim(), MAX_SUMMARY_CHARS).text;

/**
 * A command on one line, colored as written: tokenized before its lines are joined, so a heredoc's `#!` stays a
 * one-line comment instead of turning the rest of the joined line into one.
 */
function CommandLine({ command, id }: { command: string; id: string }) {
  const source = boundText(command.trim(), MAX_SUMMARY_CHARS).text;
  const tokens = useTokens(source, "shell", id);
  if (!tokens) return <>{oneLine(source)}</>;
  let last = " "; // collapses whitespace across token edges, and trims the start
  const joined = tokens.flatMap((token) => {
    const spaced = token.text.replace(/\s+/g, " ");
    const text = last.endsWith(" ") && spaced.startsWith(" ") ? spaced.slice(1) : spaced;
    if (!text) return [];
    last = text;
    return [{ ...token, text }];
  });
  return <Tokens tokens={joined} />;
}

/** The default summary with each fact in its color: `$ command` highlighted, paths, ranges, +/- counts, patterns. */
function ViewSummary({ item }: { item: ToolItem }) {
  const view = item.view;
  const path = (value: string) => <span data-part="summary-path">{oneLine(value)}</span>;
  switch (view?.kind) {
    case "shell":
      return <><span data-part="shell-prompt">$ </span><CommandLine command={view.command} id={`${item.id}:summary`} /></>;
    case "read": {
      const summary = toolSummary(item);
      return <>{path(view.path)}{summary.length > view.path.length ? <span data-part="summary-range">{summary.slice(view.path.length)}</span> : null}</>;
    }
    case "edit": {
      const { insert, remove } = diffStatText(view.diff);
      return <>{path(view.path)} <span data-part="diff-stat" data-change="insert">+{insert}</span> <span data-part="diff-stat" data-change="delete">-{remove}</span></>;
    }
    case "write":
      return <>{path(view.path)}{view.content !== undefined ? <> <span data-part="diff-stat" data-change="insert">+{lineCount(view.content)}</span></> : null}</>;
    case "search":
      return <><span data-part="summary-pattern">"{oneLine(view.pattern)}"</span>{view.path ? <> {path(view.path)}</> : null}</>;
    case "fetch":
      return view.url !== undefined ? path(view.url.replace(/^https?:\/\//, "")) : <span data-part="summary-pattern">{oneLine(view.query)}</span>;
  }
  if (view) return <>{oneLine(toolSummary(item))}</>;
  const { count, text } = argumentSummary(item.tool_call);
  return <>{count ? <><span data-part="summary-count">{count}</span> · </> : null}{text ? path(text) : null}</>;
}

function Header({ item, state, status, summary }: { item: ToolItem; state: ItemState; status?: string; summary?: ToolViewProps["summary"] }) {
  const ms = item.view?.durationMs;
  const approval = item.approval ? approvalEnd(item.approval) : undefined;
  const word = status ?? statusText[state];
  // A denied call never ran, and "canceled · canceled" says one thing twice: the approval's word is the status then.
  const both = approval && approval.decision !== "deny" && approval.text !== word;
  return (
    <>
      <ToolName name={item.tool_call.name} />
      <span data-part="tool-summary">{summary ? oneLine(summary(item)) : <ViewSummary item={item} />}</span>
      <span data-part="tool-status">
        {/* One order everywhere: the mark (::before), the approval's word, then the call's state ("■ approved · done"). */}
        {approval ? <span data-part="tool-approval" data-decision={approval.decision || undefined}>{approval.text}</span> : null}
        {approval && !both ? null : <>{both ? <span aria-hidden="true">·</span> : null}{word}</>}
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
  !item || item.active || (!denied(item) && (item.is_error || !!item.result?.blocks?.length || (output !== "" && output.length < 1200 && output.split("\n", SHORT_OUTPUT_LINES + 2).length <= SHORT_OUTPUT_LINES + 1)));

// A call its approval denied never ran: the header's "denied" is its status, and the harness's note stays closed.
const denied = (item: ToolItem) => item.approval?.type === "approval_end" && item.approval.decision === "deny";

// Streamed output, then the final result when it adds something (an error message, a cancel reason).
const toolOutput = ({ output, result }: Pick<ToolItem, "output" | "result">) => {
  const content = result?.content ?? "";
  if (!content || output.includes(content)) return output;
  return output ? `${output}${output.endsWith("\n") ? "" : "\n"}${content}` : content;
};
const toolState = (item: ToolItem): ItemState =>
  item.canceled ? "canceled" : item.is_error ? "error" : item.active ? "streaming" : "done";

/**
 * How the row's output grew since this card's previous render (core streamTail), while the shown output is the row's
 * stream itself; the body's Output extends its view from the tail.
 */
function useGrownOutput(tool: ToolItem | undefined, streamed: string | undefined, output: string) {
  const seen = useRef<{ tool?: ToolItem; output?: string }>({});
  const prior = seen.current;
  const stream = tool !== undefined && output === streamed;
  seen.current = stream ? { tool, output } : {};
  const tail = stream && prior.output !== undefined ? streamTail(prior.tool, tool, "output") : undefined;
  return tail === undefined ? null : { text: output, previous: prior.output!, tail };
}

export const ToolCall = memo(function ToolCall({ id, className, summary, body: Body = ToolBody }: ItemProps & ToolViewProps) {
  const item = useItem(id);
  const tool = item?.type === "tool" ? item : undefined;
  // One read of the streamed output: a result that adds to it makes a different (longer) string.
  const streamed = tool?.output;
  const output = tool ? toolOutput({ output: streamed!, result: tool.result }) : "";
  const grown = useGrownOutput(tool, streamed, output);
  const [open, setOpen] = useState(() => openByDefault(tool, output));
  const [bodyMounted, setBodyMounted] = useState(open);
  const highlight = useContext(HighlightContext);
  const summaryRef = useRef<HTMLElement>(null);
  // The body mounts on first open (never-opened cards cost nothing on first paint); its data warms before that, so
  // the first open paints colored. Only the default body is known to warm; a custom body renders as it is.
  const warm = useWarm(summaryRef, tool && highlight && !bodyMounted && Body === ToolBody
    ? () => warmToolBody({ item: tool, output, state: toolState(tool) }, highlight)
    : undefined, tool);
  if (!tool) return null;
  const state = toolState(tool);
  return (
    <details
      className={className}
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        if (next) setBodyMounted(true);
      }}
      data-part="tool"
      data-kind="tool"
      data-id={id}
      data-tool={toolLabel(tool.tool_call.name)}
      data-tool-view={tool.view?.kind}
      data-state={state}
    >
      <summary data-part="tool-header" ref={summaryRef} onPointerEnter={warm} onFocus={warm} onPointerDown={warm}>
        <Header item={tool} state={state} summary={summary} />
      </summary>
      {bodyMounted ? <div data-part="tool-body">
        <GrownText.Provider value={grown}><Body item={tool} output={output} state={state} /></GrownText.Provider>
        {tool.result?.blocks?.length ? <ToolResultBlocks id={id} blocks={tool.result.blocks} /> : null}
      </div> : null}
    </details>
  );
});

type Decide = (requestId: string) => void | Promise<unknown>;

const endReasons: Record<string, string> = { controller_disconnected: "connection lost", connection_lost: "connection lost", grace_expired: "timed out while disconnected", turn_canceled: "turn canceled", timeout: "timed out", shutdown: "server shut down", child_cleanup: "cleaned up" };
const decisionWords: Record<ApprovalDecision, string | undefined> = { approve: "approved", deny: "denied", abort: undefined };
/** How an approval ended: its decision, then the reason, so every ending reads as words. */
const approvalEnd = (ended: RunEvent | undefined) => {
  const decision = ended?.type === "approval_end" ? ended.decision : undefined;
  const reason = String(ended?.type === "approval_end" ? ended.data?.reason ?? "" : "");
  return { decision, text: (decision && decisionWords[decision]) ?? endReasons[reason] ?? (decision === "abort" ? "canceled" : "ended") };
};

type ApprovalAction = "approve" | "approve-always" | "deny";

const ApprovalButton = ({ action, label = action, handler, sending, disabledReason, decide }: { action: ApprovalAction; label?: string; handler?: Decide; sending: boolean; disabledReason?: string; decide: (action: ApprovalAction, handler: Decide) => () => void }) => handler || disabledReason ? <button type="button" data-action={action} disabled={!handler} aria-disabled={!handler || sending || undefined} onClick={handler ? decide(action, handler) : undefined}>{label}</button> : null;

const ApprovalActions = function ApprovalActions({
  sending,
  onApprove,
  onApproveAlways,
  approveAlwaysLabel,
  onDeny,
  disabledReason,
  decide,
}: {
  sending: ApprovalAction | undefined;
  onApprove?: Decide;
  onApproveAlways?: Decide;
  approveAlwaysLabel: string | undefined;
  onDeny?: Decide;
  disabledReason?: string;
  decide: (action: ApprovalAction, handler: Decide) => () => void;
}) {
  if (!onApprove && !onApproveAlways && !onDeny && !disabledReason) return null;
  const busy = Boolean(sending);
  return <div data-part="approval-actions">
    <ApprovalButton action="approve" handler={onApprove} sending={busy} disabledReason={disabledReason} decide={decide} />
    {approveAlwaysLabel !== undefined ? <ApprovalButton action="approve-always" label={approveAlwaysLabel} handler={onApproveAlways} sending={busy} disabledReason={disabledReason} decide={decide} /> : null}
    <ApprovalButton action="deny" handler={onDeny} sending={busy} disabledReason={disabledReason} decide={decide} />
    {disabledReason ? <span role="status">{disabledReason}</span> : null}
  </div>;
};

/**
 * A decision unmounts the approval's buttons, and later its row folds into the call's card. Focus that was on them
 * moves to the next pending approval's row (Tab then reaches its actions), else to this row, or to the card it folded
 * into; never to the page.
 */
function useDecisionFocus(pending: boolean, available: boolean, callId: string) {
  const card = useRef<HTMLDivElement>(null);
  const scope = useRef<Element | null>(null); // the timeline, while focus is in this card after a decision
  const wasAvailable = useRef(available);
  const lost = () => !document.activeElement || document.activeElement === document.body;
  const move = () => {
    const root = scope.current;
    if (!root?.isConnected || !lost()) return;
    // The next pending row, not its approve button: a repeated or held Enter must never decide a request unread.
    const next = root.querySelector<HTMLElement>('[data-part="approval"][data-state="pending"]');
    const folded = root.querySelector<HTMLElement>(`[data-part="tool"][data-id="${CSS.escape(`tool:${callId}`)}"] > summary`);
    const target = next ?? (card.current?.isConnected ? card.current : folded);
    if (target !== card.current) scope.current = null;
    target?.focus({ preventScroll: !next });
  };
  useLayoutEffect(() => {
    if (pending && wasAvailable.current && !available && scope.current && (lost() || card.current?.contains(document.activeElement)))
      card.current?.focus({ preventScroll: true });
    wasAvailable.current = available;
  }, [pending, available]);
  useLayoutEffect(() => { if (!pending) move(); }, [pending]);
  useLayoutEffect(() => () => { if (scope.current) requestAnimationFrame(move); }, []);
  const remember = () => {
    if (card.current?.contains(document.activeElement)) scope.current = card.current.closest('[data-part="timeline"]') ?? document.body;
  };
  return { card, remember };
}

function approvalState(item: Extract<RunItem, { type: "approval" }>, sending: ApprovalAction | undefined, disabledReason: string | undefined) {
  const pending = !item.ended;
  const end = approvalEnd(item.ended);
  const reason = item.request.type === "approval_request" ? item.request.disabled_reason ?? disabledReason : disabledReason;
  const buttonsEnabled = !reason && item.request.type === "approval_request" && item.request.state !== "resolving";
  const state = !pending ? "done" : sending ? "submitting" : item.request.type === "approval_request" ? item.request.state ?? "pending" : "pending";
  const label = pending ? sending ? (sending === "deny" ? "denying" : "approving") : item.request.type === "approval_request" ? item.request.status : undefined : end.text;
  return { pending, end, reason, buttonsEnabled, state, label } as const;
}

export const Approval = memo(function Approval({
  id,
  className,
  onApprove,
  onApproveAlways,
  approveAlwaysLabel = "always allow",
  onDeny,
  summary,
  body: Body = ToolBody,
  disabledReason,
}: ItemProps & ToolViewProps & { onApprove?: Decide; onApproveAlways?: Decide; approveAlwaysLabel?: string; onDeny?: Decide; disabledReason?: string }) {
  const item = useItem(id);
  const [sending, setSending] = useState<ApprovalAction>();
  const [decisionError, setDecisionError] = useState<string>();
  const labelId = useId();
  const request = item?.type === "approval" && item.request.type === "approval_request" ? item.request : undefined;
  const focusAvailable = Boolean(request && !(request.disabled_reason ?? disabledReason) && request.state !== "resolving");
  const focus = useDecisionFocus(!item || (item.type === "approval" && !item.ended), focusAvailable, request?.tool_call.id ?? "");
  if (item?.type !== "approval" || item.request.type !== "approval_request") return null;
  const { request_id, tool_call, view } = item.request;
  const requested: ToolItem = { id, type: "tool", tool_call, view, output: "", version: 0, active: true, is_error: false, canceled: false };
  const { pending, end, reason, buttonsEnabled, state, label } = approvalState(item, sending, disabledReason);
  // One decision per request: later clicks are ignored until the handler fails or the request resolves.
  const decide = (action: ApprovalAction, handler: Decide) => () => {
    if (sending) return;
    focus.remember();
    setDecisionError(undefined);
    setSending(action);
    const retry = (error: unknown) => {
      setSending(undefined);
      setDecisionError(error instanceof Error ? error.message : String(error));
    };
    try {
      Promise.resolve(handler(request_id)).catch(retry);
    } catch (error) {
      retry(error);
    }
  };
  return (
    <div
      ref={focus.card}
      onFocusCapture={focus.remember}
      className={className}
      role="group"
      tabIndex={-1}
      aria-labelledby={labelId}
      aria-busy={state === "submitting" || undefined}
      data-part="approval"
      data-kind="approval"
      data-id={id}
      data-tool={toolLabel(tool_call.name)}
      data-tool-view={view?.kind}
      data-state={state}
      data-decision={pending ? undefined : end.decision || undefined}
    >
      <div data-part="tool-header" id={labelId}>
        <Header item={requested} state={state} status={label} summary={summary} />
      </div>
      {pending ? (
        <>
          <div data-part="tool-body">
            <Body item={requested} output="" state={state} />
          </div>
          <ApprovalActions sending={sending} onApprove={buttonsEnabled ? onApprove : undefined} onApproveAlways={buttonsEnabled ? onApproveAlways : undefined} approveAlwaysLabel={onApproveAlways ? approveAlwaysLabel : undefined} onDeny={buttonsEnabled ? onDeny : undefined} disabledReason={reason} decide={decide} />
          {decisionError ? <span role="alert" data-part="approval-error">{decisionError}</span> : null}
        </>
      ) : null}
    </div>
  );
});

const itemLabel = (item: RunItem) => {
  if (item.type === "user" && item.event.type === "user_message") return item.event.text;
  if (item.type === "error" && item.event.type === "error") return item.event.error.message;
  if (item.type === "unknown" && item.event.type === "unknown") return item.event.name;
  if (item.type === "notification" && item.event.type === "notification") return notificationText(item.event.data) ?? item.type;
  return item.type;
};

const fallbackDisplay = (item: RunItem) => {
  const user = item.type === "user" && item.event.type === "user_message" ? item.event : undefined;
  // An "aborted" error is the user's own stop: a neutral row, not a failure.
  const stopped = item.type === "error" && item.event.type === "error" && item.event.error.code === "aborted";
  const label = stopped ? "stopped" : itemLabel(item);
  return {
    kind: stopped ? "stopped" : item.type,
    state: stopped ? "stopped" : item.type === "error" ? "error" : "done",
    label,
    attachments: user?.attachments,
  };
};

/** A user row whose event is a `user_message`: the item `renderDeliveryNote` receives. */
export type UserMessageItem = { id: string; type: "user"; event: Extract<RunEvent, { type: "user_message" }> };
// Words for the closed set of drop reasons zeta sends (DeliveryDropReason). An unknown reason shows no words: a raw
// token tells the reader nothing.
const dropReasons: Record<string, string> = {
  turn_end: "the turn ended first",
  abort: "the run was stopped",
  clear: "the pending steers were cleared",
  disconnect: "the connection was lost",
  failed: "the turn failed",
  restart: "the server restarted",
};
const defaultDeliveryNote = ({ event }: UserMessageItem): ReactNode => {
  if (event.delivery_status !== "dropped") return null;
  const why = event.delivery_reason !== undefined && Object.hasOwn(dropReasons, event.delivery_reason)
    ? dropReasons[event.delivery_reason]
    : undefined;
  const note = why ? `not delivered · ${why}` : "not delivered";
  return event.text_omitted ? `${note} · text not kept` : note;
};

export type FallbackProps = ItemProps & {
  /**
   * The note under a user row, called for every user message row. Return null to show no note. Omitted, a dropped
   * message reads "not delivered", plus why when the reason is known. Pass a stable function.
   */
  renderDeliveryNote?: (item: UserMessageItem) => ReactNode;
};

/** Generic part for kinds without a renderer (user, error, unknown, ...). */
export const Fallback = memo(function Fallback({ id, className, renderDeliveryNote = defaultDeliveryNote }: FallbackProps) {
  const item = useItem(id);
  if (!item) return null;
  const display = fallbackDisplay(item);
  const userEvent = item.type === "user" && item.event.type === "user_message" ? item.event : undefined;
  const user = userEvent !== undefined;
  const textOmitted = userEvent?.text_omitted === true;
  const note = user ? renderDeliveryNote(item as UserMessageItem) : null;
  if (textOmitted && (note == null || note === false)) return null;
  const content = <>{display.label}{display.attachments?.length ? <ToolResultBlocks id={id} blocks={display.attachments} /> : null}</>;
  return (
    <div className={className} style={pre} data-part="item" data-kind={display.kind} data-id={id} data-state={display.state} data-text-omitted={textOmitted ? "" : undefined}>
      {user && !textOmitted ? <UserMessageContent style={pre}>{content}</UserMessageContent> : user ? null : content}
      {note == null || note === false ? null : <div data-part="delivery-note">{note}</div>}
    </div>
  );
});

const defaults: Renderers = { message: Message, tool: ToolCall, approval: Approval, sub_agent: SubAgent, notification: Notification };

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
    case "error": return item.event.type !== "error" ? null : item.event.error.code === "aborted" ? "stopped" : `error: ${item.event.error.message}`;
    case "notification": return "new notification";
    case "unknown": return "new activity";
    case "sub_agent": return ["done", "error", "canceled"].includes(item.status) || item.urgency ? `sub-agent ${subAgentLabel(item)} ${subAgentStatusText[item.status]}` : null;
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

// The first pending approval among the rows, re-read when any approval row changes.
function usePendingApproval(items: readonly { id: string; kind?: string }[]) {
  const store = useRunStore();
  const ids = useMemo(() => items.filter((item) => item.kind === "approval").map(({ id }) => id), [items]);
  const subscribe = useCallback((listener: () => void) => {
    const stops = ids.map((id) => store.subscribe(id, listener));
    return () => stops.forEach((stop) => stop());
  }, [ids, store]);
  const pending = () => ids.find((id) => { const item = store.getItem(id); return item?.type === "approval" && !item.ended; });
  const id = useSyncExternalStore(subscribe, pending, pending);
  const item = id ? store.getItem(id) : undefined;
  return item?.type === "approval" && item.request.type === "approval_request" ? { id: item.id, request: item.request } : undefined;
}

/**
 * While an approval waits, the timeline's first tab stop jumps to it (a skip link: drawn when focused), so keyboard
 * users reach the decision without walking every row. It focuses the approval's first action.
 */
function ApprovalSkip({ items, reveal }: { items: readonly { id: string; kind?: string }[]; reveal: (id: string) => HTMLElement | null | Promise<HTMLElement | null> }) {
  const pending = usePendingApproval(items);
  if (!pending) return null;
  const { tool_call, view } = pending.request;
  const summary = toolSummary({ id: pending.id, type: "tool", tool_call, view, output: "", version: 0, active: true, is_error: false, canceled: false });
  const jump = async () => {
    const card = await reveal(pending.id);
    (card?.querySelector<HTMLElement>("[data-part=approval-actions] button:not(:disabled)") ?? card)?.focus();
  };
  return <button type="button" data-part="jump-to-approval" onClick={() => void jump()}>jump to approval: {view?.kind === "shell" ? "" : `${toolLabel(tool_call.name)} `}{oneLine(summary)}</button>;
}

const silent = (item: RunItem | undefined) => !item || announcementForItem(item) === null;

function LiveAnnouncer({ items, change }: { items: readonly { id: string }[]; change: OutlineChange | null }) {
  const pending = useRef<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const store = useRunStore();
  const previous = useRef<readonly { id: string }[] | null>(null);
  const [watched, setWatched] = useState<readonly string[]>([]);
  const [text, setText] = useState("");
  // Rows that already spoke their final words: a row that moves (or folds back in) must not speak again.
  const spoken = useRef(new Set<string>());
  const announce = useCallback((id: string, next: string) => {
    spoken.current.add(id);
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
    const before = previous.current;
    previous.current = items;
    if (before === null || before === items) return;
    // Rows added at the end are new: watch them all. A row that replaces rows (an approval folding into its tool row)
    // is watched too, so a fast call that folds already finished still says so; a row that already spoke stays silent. Rows put anywhere else (an older page, a store swap) speak only if they have
    // nothing to say yet, so a swapped-in finished session stays silent.
    const added: string[] = [];
    if (change?.from === before) {
      let length = before.length;
      for (const { index, deleteCount, items: inserted } of change.splices) {
        const atEnd = index === length && deleteCount === 0;
        for (const { id } of inserted) if (!spoken.current.has(id) && (atEnd || deleteCount > 0 || silent(store.getItem(id)))) added.push(id);
        length += inserted.length - deleteCount;
      }
      // A removed row's item is gone too; an edit touches few rows, so this skips scanning the outline.
      setWatched((current) => [...new Set([...current.filter((id) => store.getItem(id) !== undefined), ...added])]);
      return;
    }
    // No edits from what this saw: compare whole outlines. New rows after the last row that stayed are new at the end;
    // when no row stayed (a store swap) nothing is.
    const present = new Set(items.map(({ id }) => id));
    const prior = new Set(before.map(({ id }) => id));
    let lastKept = -1;
    items.forEach(({ id }, index) => { if (prior.has(id)) lastKept = index; });
    items.forEach(({ id }, index) => { if (!prior.has(id) && ((lastKept >= 0 && index > lastKept) || silent(store.getItem(id)))) added.push(id); });
    setWatched((current) => [...new Set([...current.filter((id) => present.has(id)), ...added])]);
  }, [change, items, store]);
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
  const rendererKey = useItemSelector(id, (item) =>
    item?.type === "tool" ? `tool:${item.tool_call.name}` : item?.type,
  );
  const kind = rendererKey?.startsWith("tool:") ? "tool" : rendererKey;
  const Part =
    (rendererKey && renderers?.[rendererKey]) || (kind && (renderers?.[kind] ?? defaults[kind])) || Fallback;
  return <Part id={id} />;
});

// A sub-agent row is fixed at 56 px; with the 12 px row gap the estimate is exact.
const estimateRowSize = (kind: string) => kind === "tool" ? 120 : kind === "approval" ? 100 : kind === "message" ? 72 : kind === "sub_agent" ? 68 : 48;
const virtualContainerStyle: CSSProperties = {
  position: "relative",
  display: "block",
  contain: "size style",
  boxSizing: "border-box",
  overflowAnchor: "none",
  overflowBlock: "clip",
  overflowInline: "visible",
  paddingBlock: "var(--fulcrum-virtual-gutter, 8px)",
};
const virtualRowStyle: CSSProperties = { position: "absolute", insetBlockStart: "var(--fulcrum-virtual-gutter, 8px)", insetInline: 0, display: "flex", flexDirection: "column", boxSizing: "border-box", paddingBlockEnd: "var(--fulcrum-gap, 12px)", contain: "layout style" };

type TimelineBaseProps = {
  renderers?: Renderers;
  className?: string;
  /** Defaults to virtual mode above 200 rows. A replacement RunProvider store starts pinned to the bottom. */
  virtual?: boolean;
  /** Accessible name for the chronological activity log. */
  "aria-label"?: string;
  /** Increment this after a host-accepted local send to re-pin the timeline, unless the user is actively scrolling. */
  followRequest?: number;
  /** Virtual mode: where a new store's timeline opens. Without it, it opens at the bottom and follows. */
  initialViewport?: TimelineViewport;
  /** Virtual mode: called once with the reading position when this store's timeline unmounts or its store changes. */
  onViewport?: (viewport: TimelineViewport) => void;
};

type JumpRenderer = (control: ReactNode) => ReactNode;
/**
 * Timeline owns its frame, inner scroll element, and reserved jump lane by default. Its host must have a definite
 * height. Pass `scrollRef` to use an existing host scroll element instead; Timeline never writes to that ref, renders
 * no frame or lane, and requires `renderJumpToLatest` so the host can place the control outside transcript text.
 */
export type TimelineProps = TimelineBaseProps & (
  | { scrollRef?: undefined; renderJumpToLatest?: never }
  | { scrollRef: RefObject<HTMLElement | null>; renderJumpToLatest: JumpRenderer }
);

/** A reading position by item id, not pixels: the item at the top, its offset, follow mode, and measured row sizes. */
export type TimelineViewport = { anchorId?: string; offset: number; following: boolean; cache?: VirtualCache };

function TimelineLayout({ children, unseenCount, scrollToEnd, renderJumpToLatest, ownedScrollRef, hostOwned, virtual }: Pick<TimelineProps, "renderJumpToLatest"> & { children: ReactNode; unseenCount: number; scrollToEnd(): void; ownedScrollRef: RefObject<HTMLDivElement | null>; hostOwned: boolean; virtual: boolean }) {
  const control = unseenCount > 0 ? (
    <button type="button" data-part="jump-to-latest" data-unseen-count={unseenCount} onClick={scrollToEnd}>
      jump to latest ({unseenCount})
    </button>
  ) : null;
  if (hostOwned) return <>{children}{control && renderJumpToLatest!(control)}</>;
  return (
    <div data-part="timeline-frame">
      <div data-part="timeline-scroll" ref={ownedScrollRef}>{children}</div>
      {virtual ? <div data-part="jump-to-latest-lane">{control}</div> : null}
    </div>
  );
}

const storeKeys = new WeakMap<object, number>();
let nextStoreKey = 0;
let checkedUnconstrainedTimeline = false;
const viteDevelopment = typeof (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env === "object"
  ? (import.meta as ImportMeta & { env: { DEV?: boolean } }).env.DEV
  : undefined;
const configuredDevelopment = globalThis.__FULCRUM_DEV__;
const development = configuredDevelopment === undefined ? viteDevelopment !== false : configuredDevelopment;
const useUnconstrainedWarning: (enabled: boolean, hostOwned: boolean, scroll: RefObject<HTMLElement | null>, itemCount: number, mountedCount: number) => void = development
  ? (enabled, hostOwned, scroll, itemCount, mountedCount) => useEffect(() => {
      if (!enabled || hostOwned || checkedUnconstrainedTimeline || itemCount <= 200 || mountedCount !== itemCount) return;
      checkedUnconstrainedTimeline = true;
      requestAnimationFrame(() => {
        const element = scroll.current;
        if (!element) { checkedUnconstrainedTimeline = false; return; }
        const height = element.clientHeight;
        if (!height || element.scrollHeight !== height) return;
        console.warn("Timeline virtual mode needs a definite-height host. Set a height, or use scrollRef with renderJumpToLatest for host-owned scrolling.");
      });
    }, [enabled, hostOwned, itemCount, mountedCount, scroll])
  : () => {};
const keyForStore = (store: RunStore) => {
  if (store.runId !== undefined) return `run:${store.runId}`;
  let key = storeKeys.get(store);
  if (key === undefined) { key = nextStoreKey++; storeKeys.set(store, key); }
  return `store:${key}`;
};

const sameValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left);
  const rightRecord = right as Record<string, unknown>;
  return leftKeys.length === Object.keys(rightRecord).length && leftKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(rightRecord, key)
      && sameValue((left as Record<string, unknown>)[key], rightRecord[key]));
};

const ResyncStatus = () => {
  const diagnostics = useRunDiagnostics();
  const retry = useRunRetry();
  if (!diagnostics.desynced) return null;
  return (
    <div data-part="resync-status" data-state={diagnostics.resyncError ? "error" : "pending"} role="status">
      {diagnostics.resyncError ? "could not resync" : "resyncing…"}
      {diagnostics.resyncError && retry ? <button type="button" data-part="resync-retry" onClick={retry}>retry</button> : null}
    </div>
  );
};

/** Pass a stable `renderers` object (module scope or memoized) so appends do not re-render every row. */
export const Timeline = memo(function Timeline(props: TimelineProps) {
  const store = useRunStore();
  const runKey = keyForStore(store);
  return <><ResyncStatus /><TimelineForStore key={runKey} {...props} store={store} runKey={runKey} /></>;
});

const TimelineForStore = memo(function TimelineForStore({ store, runKey, renderers, className, virtual, scrollRef, followRequest, renderJumpToLatest, initialViewport, onViewport, "aria-label": ariaLabel = "agent activity" }: TimelineProps & { store: RunStore; runKey: string }) {
  const { items, change, historyPending } = useTimelineSnapshot();
  const priorStore = useRef(store);
  const priorVirtual = useRef(virtual ?? items.length > 200);
  const replacementGap = priorStore.current !== store && items.length === 0;
  const invalidMeasurements = useMemo(() => priorStore.current === store ? undefined : items
    .filter(({ id }) => !sameValue(priorStore.current.getItem(id), store.getItem(id)))
    .map(({ id }) => id), [items, store]);
  // Once a run needs virtualization, keep its one engine alive while a replacement store replays short pages.
  const enabled = virtual ?? (priorVirtual.current || items.length > 200);
  const ownedScrollRef = useRef<HTMLDivElement>(null);
  const activeScrollRef = scrollRef ?? ownedScrollRef;
  const list = useVirtualList(items, { estimateSize: estimateRowSize, scrollRef: activeScrollRef, enabled, outlineUpdate: change, resetKey: runKey, invalidateMeasurements: invalidMeasurements, historyPending, cache: initialViewport?.cache });
  useUnconstrainedWarning(enabled, !!scrollRef, ownedScrollRef, items.length, list.snapshot.rows.length);
  const priorFollowRequest = useRef(followRequest);
  useLayoutEffect(() => {
    if (followRequest !== undefined && followRequest !== priorFollowRequest.current) list.requestFollow();
    priorFollowRequest.current = followRequest;
  }, [followRequest, list.requestFollow]);
  const initialScroll = useRef(enabled);
  const restore = useRef(initialViewport);
  useLayoutEffect(() => {
    if (!enabled) {
      if (priorStore.current === store) initialScroll.current = true;
    } else if (initialScroll.current && list.snapshot.totalSize > 0) {
      initialScroll.current = false;
      const viewport = restore.current;
      restore.current = undefined;
      if (viewport && !viewport.following && viewport.anchorId && items.some(({ id }) => id === viewport.anchorId)) list.scrollToId(viewport.anchorId, viewport.offset);
      else list.scrollToEnd();
    }
  }, [enabled, items, list.scrollToEnd, list.scrollToId, list.snapshot.totalSize, store]);
  useLayoutEffect(() => {
    if (replacementGap) return;
    priorStore.current = store;
    priorVirtual.current = enabled;
  }, [enabled, replacementGap, store]);
  const leaving = useRef({ list, enabled, onViewport });
  leaving.current = { list, enabled, onViewport };
  useLayoutEffect(() => () => {
    const { list, enabled, onViewport } = leaving.current;
    if (!enabled || !onViewport) return;
    const { anchor, pinned } = list.snapshot;
    onViewport({ anchorId: anchor?.id, offset: anchor?.offset ?? 0, following: pinned, cache: list.snapshotCache() });
  }, []);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const plainRef = useRef<HTMLDivElement>(null);
  const priorMode = useRef(enabled);
  const modeAnchor = useRef<{ id: string; offset: number } | null>(null);
  useLayoutEffect(() => {
    const container = activeScrollRef.current ?? plainRef.current?.parentElement ?? null;
    if (!container || priorMode.current === enabled) return;
    if (enabled && modeAnchor.current) list.scrollToId(modeAnchor.current.id, modeAnchor.current.offset);
    if (!enabled && modeAnchor.current) {
      const index = items.findIndex(({ id }) => id === modeAnchor.current!.id);
      const row = index >= 0 ? plainRef.current!.children[index] as HTMLElement | undefined : undefined;
      if (row) container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top - modeAnchor.current.offset;
    }
    priorMode.current = enabled;
  }, [activeScrollRef, enabled, items, list.scrollToId]);
  useLayoutEffect(() => {
    if (enabled && list.snapshot.anchor) modeAnchor.current = { id: list.snapshot.anchor.id, offset: list.snapshot.anchor.offset };
  }, [enabled, list.snapshot.anchor]);
  useLayoutEffect(() => {
    if (enabled) return;
    const container = activeScrollRef.current ?? plainRef.current?.parentElement ?? null;
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
  }, [activeScrollRef, enabled, items]);
  // The newest row comes from the outline, not the DOM: a virtual timeline also mounts a row kept for focus after it.
  const newest = newestStreamableRow(items);
  if (!enabled) {
    return (
      <NewestRowProvider id={newest}><TimelineLayout unseenCount={0} scrollToEnd={list.scrollToEnd} renderJumpToLatest={renderJumpToLatest} ownedScrollRef={ownedScrollRef} hostOwned={scrollRef !== undefined} virtual={false}>
        <div ref={plainRef} className={className} data-part="timeline" data-virtual="false" role="log" aria-label={ariaLabel} aria-live="off">
          <ApprovalSkip items={items} reveal={(id) => {
            const card = plainRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`) ?? null;
            card?.scrollIntoView({ block: "nearest" });
            return card;
          }} />
          {items.map(({ id }) => <Row key={id} id={id} renderers={renderers} />)}
        </div>
        <LiveAnnouncer items={items} change={change} />
      </TimelineLayout></NewestRowProvider>
    );
  }
  const mounted = list.snapshot.rows;
  const retained = focusedId && !mounted.some(({ id }) => id === focusedId)
    ? items.findIndex(({ id }) => id === focusedId)
    : -1;
  const retainedRow = retained >= 0 ? { ...items[retained]!, index: retained, start: -10_000, size: 0, loaded: true } : null;
  return (
    <NewestRowProvider id={newest}><TimelineLayout unseenCount={list.unseenCount} scrollToEnd={list.scrollToEnd} renderJumpToLatest={renderJumpToLatest} ownedScrollRef={ownedScrollRef} hostOwned={scrollRef !== undefined} virtual>
      <div
        ref={list.timelineRef}
        className={className}
        data-part="timeline"
        data-virtual="true"
        data-unseen-count={list.unseenCount}
        role="log"
        aria-label={ariaLabel}
        aria-live="off"
        style={{ ...virtualContainerStyle, height: `calc(${list.snapshot.totalSize}px + 2 * var(--fulcrum-virtual-gutter, 8px))` }}
        onFocusCapture={(event) => setFocusedId(event.target instanceof Element ? event.target.closest<HTMLElement>("[data-virtual-id]")?.dataset.virtualId ?? null : null)}
        onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedId(null); }}
      >
        <ApprovalSkip items={items} reveal={(id) => {
          list.scrollToId(id);
          // The row mounts on the next frame once scrolled into the window.
          return new Promise((resolve) => requestAnimationFrame(() => resolve(document.querySelector<HTMLElement>(`[data-virtual-id="${CSS.escape(id)}"] [data-id="${CSS.escape(id)}"]`))));
        }} />
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
              if (event.target !== event.currentTarget) return; // arrows typed in a control inside the row belong to it
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
    </TimelineLayout></NewestRowProvider>
  );
});
