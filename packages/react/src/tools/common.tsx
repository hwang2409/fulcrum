import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { ToolCall } from "@fulcrum/core";
import type { ItemState } from "../parts.js";

const HEAD_LINES = 40;
const TAIL_LINES = 20;
/** The most text one body puts in the DOM, even after "show all": the rest stays in the store and in copy. */
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

/** The one truncation path for text put in the DOM. Copy controls keep the original value separately. */
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

type Window<T> = { head: T[]; tail: T[]; tailFrom: number; hidden: number; total: number };

// Take items from one end while they fit the line and character budgets; an item that alone overflows is cut.
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

/**
 * Bounds a list of lines (or rows) for the DOM: collapsed, the first 40 and last 20; expanded, everything up to
 * MAX_DOM_CHARS, split between head and tail. `tail` 0 keeps only the head (search results read top-down).
 */
export function bound<T>(items: T[], expanded: boolean, size: (item: T) => number, cut: (item: T, chars: number) => T, tail = TAIL_LINES): Window<T> {
  const total = items.length;
  let chars = 0;
  for (const item of items) chars += size(item) + 1;
  const maxLines = expanded ? Infinity : HEAD_LINES + tail;
  const budget = MAX_DOM_CHARS - DOM_CHROME_BUDGET;
  if (total <= maxLines && chars <= budget) return { head: items, tail: [], tailFrom: total, hidden: 0, total };
  const head = take(items, 0, 1, expanded ? Infinity : HEAD_LINES, tail ? budget / 2 : budget, size, cut);
  const end = tail ? take(items.slice(head.length), total - head.length - 1, -1, expanded ? Infinity : tail, budget / 2, size, cut) : [];
  return { head, tail: end, tailFrom: total - end.length, hidden: total - head.length - end.length, total };
}
const cutLine = (line: string, chars: number) => boundText(line, chars).text;
export const boundLines = (lines: string[], expanded: boolean, tail?: number) => bound(lines, expanded, (line) => line.length, cutLine, tail);

/** What a bound left out, in words, and the button that shows the rest. */
const gapText = (window: Window<unknown>, expanded: boolean, noun: string) =>
  expanded ? `… ${window.hidden} ${noun} not shown, over ${MAX_DOM_CHARS / 1000} kB …` : `… ${window.hidden} ${noun} hidden …`;
export function Gap({ window, expanded, noun = "lines" }: { window: Window<unknown>; expanded: boolean; noun?: string }) {
  return window.hidden ? <span data-part="tool-gap">{gapText(window, expanded, noun)}</span> : null;
}
export function ShowAll({ window, expanded, expand, noun = "lines" }: { window: Window<unknown>; expanded: boolean; expand: () => void; noun?: string }) {
  return window.hidden && !expanded ? <button type="button" data-action="show-all" onClick={expand}>show all {window.total} {noun}</button> : null;
}

/** Plain bounded text. It stays one text node when it fits, so streaming output is cheap. */
export function Output({ text, stream }: { text: string; stream?: "stderr" }) {
  const [expanded, setExpanded] = useState(false);
  const lines = splitLines(text);
  const window = boundLines(lines, expanded);
  // `bound` returns the same array when everything fits.
  const visible = window.head === lines ? text : [...window.head, ...(window.hidden ? [gapText(window, expanded, "lines")] : []), ...window.tail].join("\n");
  const shown = boundText(visible).text;
  return (
    <>
      <pre data-part="tool-output" data-stream={stream}>{shown}</pre>
      <ShowAll window={window} expanded={expanded} expand={() => setExpanded(true)} />
    </>
  );
}

const Row = ({ number, text }: { number: number; text: string }) => (
  <div data-part="line"><span data-part="line-number">{number}</span><span data-part="line-text">{text}</span></div>
);

/** Bounded lines with a line-number gutter that starts at `start`. */
export function NumberedLines({ text, start = 1 }: { text: string; start?: number }) {
  const [expanded, setExpanded] = useState(false);
  const lines = splitLines(text);
  const digits = String(start + lines.length).length;
  const window = bound(lines, expanded, (line) => line.length + digits, (line, chars) => cutLine(line, Math.max(0, chars - digits)));
  return (
    <>
      <div data-part="tool-lines" style={{ "--gutter": `${digits}ch` } as CSSProperties}>
        {window.head.map((line, i) => <Row key={i} number={start + i} text={line} />)}
        <Gap window={window} expanded={expanded} />
        {window.tail.map((line, i) => <Row key={window.tailFrom + i} number={start + window.tailFrom + i} text={line} />)}
      </div>
      <ShowAll window={window} expanded={expanded} expand={() => setExpanded(true)} />
    </>
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

const json = (args: unknown) => JSON.stringify(args, null, 2);
/** Raw arguments are bounded in the DOM; copy always receives the complete JSON. */
export function Arguments({ call, open }: { call: ToolCall; open?: boolean }) {
  const value = json(call.arguments);
  const content = <><pre data-part="tool-args">{boundText(value).text}</pre><CopyButton label="arguments" value={value} /></>;
  return open ? <div data-part="tool-args-wrap">{content}</div> : (
    <details data-part="tool-args-details">
      <summary>arguments</summary>
      {content}
    </details>
  );
}

export const bytes = (value: number) => (value < 1_000 ? `${value} B` : value < 1_000_000 ? `${(value / 1_000).toFixed(1)} kB` : `${(value / 1_000_000).toFixed(1)} MB`);
export const duration = (ms: number) =>
  ms < 1_000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1_000).toFixed(1)} s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
