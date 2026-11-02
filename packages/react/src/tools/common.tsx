import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { ToolCall } from "@fulcrum/core";
import type { ItemState } from "../parts.js";
import { needsTextViewer, TextViewer, useTextMetrics } from "./text-viewer.js";

const HEAD_LINES = 40;
const TAIL_LINES = 20;
export const MAX_DOM_CHARS = 100_000;
export const MAX_SUMMARY_CHARS = 240;
const DOM_CHROME_BUDGET = 256;

type BoundedText = { text: string; shown: number; total: number; truncated: boolean };

const safePrefix = (text: string, length: number) => {
  let end = Math.max(0, length);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
  return text.slice(0, end);
};
const characters = (text: string) => {
  let count = 0;
  for (const _ of text) count++;
  return count;
};

/** The one truncation path for compact labels. Large bodies use TextViewer. */
export function boundText(value: string, limit = MAX_DOM_CHARS): BoundedText {
  if (value.length <= limit) return { text: value, shown: value.length, total: value.length, truncated: false };
  const total = characters(value);
  let prefix = safePrefix(value, Math.max(0, limit - 64));
  let notice = "";
  for (let pass = 0; pass < 2; pass++) {
    const shown = characters(prefix);
    notice = `… showing ${shown} of ${total} characters`;
    prefix = safePrefix(value, limit - notice.length);
  }
  const shown = characters(prefix);
  notice = `… showing ${shown} of ${total} characters`;
  return { text: `${prefix}${notice}`, shown, total, truncated: true };
}

export const asking = (state: ItemState) => state === "pending" || state === "submitting";
export const splitLines = (text: string) => (text === "" ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n"));

type Window<T> = { head: T[]; tail: T[]; tailFrom: number; hidden: number; total: number; truncated: boolean };

function take<T>(items: T[], from: number, step: 1 | -1, maxItems: number, budget: number, size: (item: T) => number, cut: (item: T, chars: number) => T) {
  const out: T[] = [];
  for (let i = from; out.length < maxItems && i >= 0 && i < items.length; i += step) {
    const length = size(items[i]!) + 1;
    if (length > budget) {
      if (!out.length) out.push(cut(items[i]!, budget));
      break;
    }
    budget -= length;
    out.push(items[i]!);
  }
  return step === 1 ? out : out.reverse();
}

/** A short first/last preview. Full large text is available through TextViewer. */
export function bound<T>(items: T[], size: (item: T) => number, cut: (item: T, chars: number) => T, tail = TAIL_LINES, budget = MAX_DOM_CHARS - DOM_CHROME_BUDGET): Window<T> {
  const total = items.length;
  let chars = 0;
  for (const item of items) chars += size(item) + 1;
  if (total <= HEAD_LINES + tail && chars <= budget) return { head: items, tail: [], tailFrom: total, hidden: 0, total, truncated: false };
  const head = take(items, 0, 1, HEAD_LINES, tail ? budget / 2 : budget, size, cut);
  const end = tail ? take(items.slice(head.length), total - head.length - 1, -1, tail, budget / 2, size, cut) : [];
  return { head, tail: end, tailFrom: total - end.length, hidden: total - head.length - end.length, total, truncated: chars > budget };
}
const cutLine = (line: string, chars: number) => boundText(line, chars).text;
export const boundLines = (lines: string[], tail?: number, budget?: number) => bound(lines, (line) => line.length, cutLine, tail, budget);

export function Gap({ window, noun = "lines" }: { window: Window<unknown>; noun?: string }) {
  if (!window.hidden && !window.truncated) return null;
  const text = window.hidden
    ? `… ${window.hidden} ${noun} hidden; open to view all …`
    : `… part of ${noun} shown; open to view all …`;
  return <span data-part="tool-gap">{text}</span>;
}

/** Plain text that switches to the shared virtual viewer above the preview budget. */
export function Output({ text, stream }: { text: string; stream?: "stderr" }) {
  return <TextViewer text={text} label={stream ?? "output"} appendOnly follow stream={stream} />;
}

const Row = ({ number, text }: { number: number; text: string }) => (
  <div data-part="line"><span data-part="line-number">{number}</span><span data-part="line-text">{text}</span></div>
);

/** Numbered text uses rich rows while small and the shared viewer while large. */
export function NumberedLines({ text, start = 1 }: { text: string; start?: number }) {
  const metrics = useTextMetrics(text, true);
  if (needsTextViewer(text, metrics)) return <TextViewer text={text} label="content" appendOnly metrics={metrics} />;
  const lines = splitLines(text);
  const digits = String(start + lines.length).length;
  return (
    <div data-part="tool-lines" style={{ "--gutter": `${digits}ch` } as CSSProperties}>
      {lines.map((line, index) => <Row key={index} number={start + index} text={line} />)}
    </div>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [result, setResult] = useState<"copied" | "copy failed">();
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(undefined), 1500);
    return () => clearTimeout(timer);
  }, [result]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setResult("copied");
    } catch {
      setResult("copy failed"); // no clipboard (insecure context) or permission denied
    }
  };
  return <button type="button" data-action="copy" aria-label={`copy ${label}`} onClick={copy}>{result ?? `copy ${label}`}</button>;
}

/** The last row of every body: facts on the left (exit code, cwd, size), copy buttons on the right. */
export function Foot({ children, copy }: { children?: ReactNode; copy: Array<[label: string, value: string | undefined]> }) {
  const buttons = copy.filter((entry): entry is [string, string] => !!entry[1]);
  if (!children && !buttons.length) return null;
  return (
    <div data-part="tool-foot">
      <span data-part="tool-meta">{children}</span>
      {buttons.map(([label, value]) => <CopyButton key={label} label={label} value={value} />)}
    </div>
  );
}

export function Empty({ state, noun = "output" }: { state: ItemState; noun?: string }) {
  if (asking(state)) return null;
  const text = state === "streaming" ? `waiting for ${noun}` : state === "error" ? `failed without ${noun}` : state === "canceled" ? `canceled before ${noun}` : `no ${noun}`;
  return <p data-part="tool-empty">{text}</p>;
}

/** Raw arguments serialize only when visible, and only when their immutable value changes. */
export function Arguments({ call, open }: { call: ToolCall; open?: boolean }) {
  const [expanded, setExpanded] = useState(!!open);
  const value = useMemo(() => expanded ? JSON.stringify(call.arguments, null, 2) : undefined, [call.arguments, expanded]);
  const content = value === undefined ? null : <><TextViewer text={value} label="arguments" part="tool-args" /><CopyButton label="arguments" value={value} /></>;
  return open ? <div data-part="tool-args-wrap">{content}</div> : (
    <details data-part="tool-args-details" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>arguments</summary>
      {content}
    </details>
  );
}

export const bytes = (value: number) => (value < 1_000 ? `${value} B` : value < 1_000_000 ? `${(value / 1_000).toFixed(1)} kB` : `${(value / 1_000_000).toFixed(1)} MB`);
export const duration = (ms: number) =>
  ms < 1_000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1_000).toFixed(1)} s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
