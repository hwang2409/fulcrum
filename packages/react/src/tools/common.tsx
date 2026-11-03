import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ToolCall } from "@fulcrum/core";
import type { ItemState } from "../parts.js";
import { tokenLines, Tokens, useTokens, type Block } from "../highlight.js";
import { hasControls, parseAnsi, type AnsiText } from "./ansi.js";
import { jsonText } from "./json.js";
import { CopyButton, needsTextViewer, TextViewer, useTextMetrics, viewerBlocks, type CopyValue, type TextFormat } from "./text-viewer.js";

const JSON_FORMAT: TextFormat = { language: "json" };
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
export const lineCount = (text: string) => {
  if (text === "") return 0;
  let lines = text.endsWith("\n") ? 0 : 1;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) lines++;
  return lines;
};

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

const MEMO_ENTRIES = 32;
const MEMO_CHARS = 2_000_000;
/**
 * The latest results of a pure function of one text, so a body warmed before it opens and the body once mounted share
 * one computation (JSON detection, ANSI parsing, row models). Least recently used entries go first; the kept texts
 * total at most MEMO_CHARS, so a streaming body does not pin its old revisions.
 */
export function memoText<T>(compute: (text: string) => T): (text: string) => T {
  const cache = new Map<string, T>();
  let chars = 0;
  return (text) => {
    if (cache.has(text)) {
      const hit = cache.get(text)!;
      cache.delete(text);
      cache.set(text, hit);
      return hit;
    }
    const value = compute(text);
    if (text.length > MEMO_CHARS) return value;
    cache.set(text, value);
    chars += text.length;
    for (const [key] of cache) {
      if (cache.size <= MEMO_ENTRIES && chars <= MEMO_CHARS) break;
      cache.delete(key);
      chars -= key.length;
    }
    return value;
  };
}

const ansiOf = memoText((text) => (hasControls(text) ? parseAnsi(text) : undefined));
const jsonOf = memoText(jsonText);

/** Append-only terminal text with its escape codes applied; undefined while the text has no control characters. */
function useAnsi(text: string): AnsiText | undefined {
  const cache = useRef<{ source: string; parsed?: AnsiText }>({ source: "" });
  const prior = cache.current;
  if (text === prior.source) return prior.parsed;
  const appended = text.length > prior.source.length && prior.source.length > 0;
  const delta = appended ? text.slice(prior.source.length) : text;
  const base = appended ? prior.parsed : undefined;
  const parsed = !appended ? ansiOf(text) : !base && !hasControls(delta) ? undefined : parseAnsi(delta, base ?? parseAnsi(prior.source));
  cache.current = { source: text, parsed };
  return parsed;
}

/** Output text without its escape codes, for copying. */
export const plainOutput = (text: string) => (hasControls(text) ? parseAnsi(text).text : text);

/**
 * Tool output in the shared viewer, colored by what it structurally is: ANSI escape codes as theme colors, else the
 * given language, else JSON when the finished text parses as one JSON object or array. `pretty` indents compact JSON.
 * Logs `follow` their newest line; a document (`follow={false}`) starts at its top.
 */
type OutputProps = { text: string; id: string; stream?: "stderr"; done?: boolean; language?: string; pretty?: boolean; follow?: boolean };

// What Output shows and how it is colored, from the text with its escape codes applied.
function outputView(ansi: AnsiText | undefined, text: string, done: boolean, language: string | undefined, pretty: boolean) {
  const plain = ansi?.text ?? text;
  const json = !ansi?.spans.length && done && (!language || language === "json") ? jsonOf(plain) : undefined;
  const shown = json?.json && pretty ? json.text : plain;
  const format: TextFormat | undefined = ansi?.spans.length ? { spans: ansi.spans } : json?.json ? JSON_FORMAT : language ? { language } : undefined;
  return { shown, format, appendOnly: shown === plain };
}

export function Output({ text, id, stream, done = true, language, pretty = false, follow = true }: OutputProps) {
  const ansi = useAnsi(text);
  const { shown, format, appendOnly } = useMemo(() => outputView(ansi, text, done, language, pretty), [ansi, text, done, language, pretty]);
  return <TextViewer text={shown} id={id} label={stream ?? "output"} appendOnly={appendOnly} follow={follow} stream={stream} format={format} done={done} />;
}

/** The highlight blocks Output asks for when it first mounts; see viewerBlocks. */
export function outputBlocks({ text, id, done = true, language, pretty = false }: OutputProps): Block[] {
  const { shown, format } = outputView(ansiOf(text), text, done, language, pretty);
  return viewerBlocks({ text: shown, id, format, done });
}

const Row = ({ number, children }: { number: number; children: ReactNode }) => (
  <div data-part="line"><span data-part="line-number">{number}</span><span data-part="line-text">{children}</span></div>
);

type NumberedProps = { text: string; start?: number; id: string; language?: string; done?: boolean };

/** The highlight blocks NumberedLines asks for when it first mounts. */
export function numberedBlocks({ text, id, language, done = true }: NumberedProps): Block[] {
  return needsTextViewer(text) ? viewerBlocks({ text, id, format: language ? { language } : undefined, done }) : [{ code: text, language, id, done }];
}

/** Numbered text uses rich rows while small and the shared viewer while large. */
export function NumberedLines({ text, start = 1, id, language, done = true }: NumberedProps) {
  const metrics = useTextMetrics(text, true);
  const large = needsTextViewer(text, metrics);
  const tokens = useTokens(large ? "" : text, language, id, done);
  if (large) return <TextViewer text={text} id={id} label="content" appendOnly metrics={metrics} format={language ? { language } : undefined} done={done} />;
  const lines = splitLines(text);
  const tokenRows = tokens ? tokenLines(tokens) : undefined;
  const digits = String(start + lines.length).length;
  return (
    <div data-part="tool-lines" data-language={language} style={{ "--gutter": `${digits}ch` } as CSSProperties}>
      {lines.map((line, index) => <Row key={index} number={start + index}>{tokenRows?.[index] ? <Tokens tokens={tokenRows[index]} /> : line}</Row>)}
    </div>
  );
}

/** The last row of every body: facts on the left (exit code, cwd, size), copy buttons on the right. */
export function Foot({ children, copy }: { children?: ReactNode; copy: Array<[label: string, value: CopyValue | undefined]> }) {
  const buttons = copy.filter((entry): entry is [string, CopyValue] => !!entry[1]);
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
  return <p data-part="tool-empty" data-state={state}>{text}</p>;
}

/** Raw arguments serialize only when visible, and only when their immutable value changes. */
export function Arguments({ call, id, open }: { call: ToolCall; id: string; open?: boolean }) {
  const [expanded, setExpanded] = useState(!!open);
  const value = useMemo(() => expanded ? JSON.stringify(call.arguments, null, 2) : undefined, [call.arguments, expanded]);
  const content = value === undefined ? null : (
    <>
      <TextViewer text={value} id={`${id}:arguments`} label="arguments" part="tool-args" format={JSON_FORMAT} />
      <div data-part="tool-foot"><span data-part="tool-meta" /><CopyButton label="arguments" value={value} /></div>
    </>
  );
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
