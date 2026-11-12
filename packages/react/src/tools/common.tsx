import { Children, createContext, useContext, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { TextChunk, TextSourceSnapshot, ToolCall } from "@fulcrum/core";
import { sourceTail } from "@fulcrum/core/internal";
import type { ItemState } from "../parts.js";
import { tokenLines, Tokens, useTokens, type Block } from "../highlight.js";
import { continueAnsi, hasControls, parseAnsi, type AnsiText } from "./ansi.js";
import { jsonText } from "./json.js";
import { CopyButton, needsTextViewer, TextViewer, useTextMetrics, viewerBlocks, type CopyValue, type Grown, type Retained, type TextFormat } from "./text-viewer.js";

const JSON_FORMAT: TextFormat = { language: "json" };
export const MAX_DOM_CHARS = 100_000;
export const MAX_SUMMARY_CHARS = 240;

export const humanBytes = (value: number) => value < 1024 ? `${value} bytes` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;
/** The visible line at a local cut: a whole body the run let go of, or the middle an item kept out. */
export const omissionNotice = ({ reason, whole, bytes }: NonNullable<TextSourceSnapshot["omission"]>) =>
  whole && reason === "run-cap" ? `output not kept (${humanBytes(bytes)}) to save memory in this long run` : `${humanBytes(bytes)} not kept`;
const PROTOCOL_NOTICE = "host did not provide the complete output";
const shownText = new WeakMap<TextSourceSnapshot, string>();
// The shown text's length at its last flat copy, per snapshot (see sourceText).
const flatLength = new WeakMap<TextSourceSnapshot, number>();
const withNotice = (text: string, notice: string) => `${text}${text && !text.endsWith("\n") ? "\n" : ""}${notice}`;
/**
 * A source as the viewer shows it: the retained text, with one plain line where the middle (or all of it) was not kept,
 * and a last line when the host itself cut the output. Each snapshot is read once; pass the snapshot it grew from
 * (`previous`), and the text it added when already known (`added`), and an append costs only the added chunks.
 */
export function sourceText(source: TextSourceSnapshot, previous?: TextSourceSnapshot, added?: string): string {
  const known = shownText.get(source);
  if (known !== undefined) return known;
  const base = previous && shownText.get(previous);
  const tail = base !== undefined && !previous!.protocolTruncated ? added ?? sourceTail(previous, source) : undefined;
  let text: string;
  if (tail !== undefined) {
    // Each append is a rope node over the previous text. Once the text has grown by an eighth since its last flat copy,
    // join (one flat string) so the nodes behind it are free; the copies cost at most nine characters per added one.
    const rebuilt = flatLength.get(previous!) ?? base!.length;
    if (base!.length + tail.length - rebuilt > rebuilt / 8) {
      text = [base, tail].join("");
      flatLength.set(source, text.length);
    } else {
      text = base + tail;
      flatLength.set(source, rebuilt);
    }
  } else {
    const omission = source.omission;
    let head = "", rest = "";
    for (const chunk of source.chunks()) {
      if (omission && chunk.start >= omission.end) rest += chunk.text;
      else head += chunk.text;
    }
    if (omission) {
      // Style never crosses the cut: a color or bold run the head opened must not paint the notice or the tail. (The
      // parser never sees the omitted text, so only the head can leave a style open; deciding by the head alone keeps
      // the shown text the same whether it was built at once or grown append by append.)
      const reset = head.includes("\u001b") ? "\u001b[0m" : "";
      text = withNotice(head, reset + omissionNotice(omission)) + (rest ? `\n${rest}` : "");
    } else text = head;
    if (source.protocolTruncated) text = withNotice(text, PROTOCOL_NOTICE);
  }
  shownText.set(source, text);
  return text;
}

/**
 * Where a cut source's notice line sits among the rows sourceText shows (`row`), and the zero-based line of the source
 * the next row shows (`line`), so numbered rows keep the file's own numbers past the cut. Undefined unless part of the
 * source is kept on either side of the cut.
 */
export function cutRows(source: TextSourceSnapshot): { row: number; line: number } | undefined {
  const omission = source.omission;
  if (!omission || omission.whole) return undefined;
  let last: TextChunk | undefined;
  let line = source.lines;
  for (const chunk of source.chunks()) {
    if (chunk.start >= omission.end) { line = chunk.line; break; }
    last = chunk;
  }
  if (!last) return { row: 0, line };
  // Snapshots of one stream share their head chunks: count the last one's lines once, not on every append.
  let row = headRows.get(last);
  if (row === undefined) headRows.set(last, row = last.line + lineCount(last.text));
  return { row, line };
}
const headRows = new WeakMap<TextChunk, number>();

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
// The header cuts a summary longer than this to one line (a few on narrow screens); a pending body repeats what the
// header shows (a command, a path) only then, so a short one is said once.
const HEADER_CHARS = 72;
export const cutByHeader = (text: string) => text.length > HEADER_CHARS || text.includes("\n");
export const splitLines = (text: string) => (text === "" ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n"));
export const lineCount = (text: string) => {
  if (text === "") return 0;
  let lines = text.endsWith("\n") ? 0 : 1;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) lines++;
  return lines;
};

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

/**
 * A streamed text the caller knows grew by appending: `text` is `previous` followed by `tail`, both known without
 * reading the text (core's streamTail). ToolCall provides it for the row's output; Output passes the shown text's
 * growth to TextViewer.
 */
export const GrownText = createContext<(Grown & { text: string }) | null>(null);

/**
 * Terminal text with its escape codes applied (undefined while the text has no control characters), and how the shown
 * text grew when `text` is a known append to the previous text.
 */
function useAnsi(text: string, grown: Grown | undefined, done: boolean): { parsed: AnsiText | undefined; grown?: Grown } {
  // `owned`: parsed is this hook's own copy. parseAnsi extends its prior's spans in place, so a memoized (shared) result
  // is copied once before it is extended; extending it in place corrupted the next replay of the same text.
  const cache = useRef<{ source: string; parsed?: AnsiText; owned: boolean }>({ source: "", owned: false });
  const prior = cache.current;
  if (text === prior.source) return { parsed: prior.parsed };
  // A known append continues from the tail alone. Unknown text that extends the previous text is checked in full;
  // anything else (a replay, a reconnect, a reset store) is parsed from the start.
  const delta = grown && grown.previous === prior.source ? grown.tail
    : prior.source.length > 0 && text.length > prior.source.length && text.startsWith(prior.source) ? text.slice(prior.source.length)
    : undefined;
  let parsed: AnsiText | undefined;
  let shown: Grown | undefined;
  if (delta === undefined) {
    parsed = ansiOf(text);
    // A streaming text takes its own copy of the shared parse now, inside this already whole-text render, so the
    // first append does not copy every span.
    if (parsed && !done) parsed = { ...parsed, spans: [...parsed.spans] };
  } else if (prior.parsed || hasControls(delta)) {
    const base = prior.parsed ? (prior.owned ? prior.parsed : { ...prior.parsed, spans: [...prior.parsed.spans] }) : parseAnsi(prior.source);
    const step = continueAnsi(delta, base);
    parsed = step.parsed;
    if (prior.parsed) shown = { previous: base.text, tail: step.added };
  } else shown = { previous: prior.source, tail: delta };
  cache.current = { source: text, parsed, owned: parsed !== undefined && (delta !== undefined || !done) };
  return { parsed, grown: shown };
}

/** What a viewer exports for a source shown as `text` (sourceText(source)), and whether nothing of it was cut. */
function useRetained(text: string, source: TextSourceSnapshot | undefined): Retained | undefined {
  const complete = !source?.omission && !source?.protocolTruncated;
  return useMemo(() => source ? { text, complete } : undefined, [source, text, complete]);
}

/** Output text without its escape codes, for copying. */
export const plainOutput = (text: string) => (hasControls(text) ? parseAnsi(text).text : text);

/**
 * Tool output in the shared viewer, colored by what it structurally is: ANSI escape codes as theme colors, else the
 * given language, else JSON when the finished text parses as one JSON object or array. `pretty` indents compact JSON.
 * Logs `follow` their newest line; a document (`follow={false}`) starts at its top.
 */
type OutputProps = {
  text: string;
  id: string;
  stream?: "stderr";
  done?: boolean;
  language?: string;
  pretty?: boolean;
  follow?: boolean;
  /** The source `text` shows (`text` is sourceText(source)): the open viewer exports it, and says when it was cut. */
  source?: TextSourceSnapshot;
};

// What Output shows and how it is colored, from the text with its escape codes applied.
function outputView(ansi: AnsiText | undefined, text: string, done: boolean, language: string | undefined, pretty: boolean) {
  const plain = ansi?.text ?? text;
  const json = !ansi?.spans.length && done && (!language || language === "json") ? jsonOf(plain) : undefined;
  const shown = json?.json && pretty ? json.text : plain;
  const format: TextFormat | undefined = ansi?.spans.length ? { spans: ansi.spans } : json?.json ? JSON_FORMAT : language ? { language } : undefined;
  return { shown, format, appendOnly: shown === plain };
}

export function Output({ text, id, stream, done = true, language, pretty = false, follow = true, source }: OutputProps) {
  const known = useContext(GrownText);
  const { parsed: ansi, grown } = useAnsi(text, known?.text === text ? known : undefined, done);
  const { shown, format, appendOnly } = useMemo(() => outputView(ansi, text, done, language, pretty), [ansi, text, done, language, pretty]);
  const retained = useRetained(text, source);
  return <TextViewer text={shown} id={id} label={stream ?? "output"} appendOnly={appendOnly} grown={appendOnly ? grown : undefined} follow={follow} stream={stream} format={format} done={done} retained={retained} />;
}

/** The highlight blocks Output asks for when it first mounts; see viewerBlocks. */
export function outputBlocks({ text, id, done = true, language, pretty = false }: OutputProps): Block[] {
  const { shown, format } = outputView(ansiOf(text), text, done, language, pretty);
  return viewerBlocks({ text: shown, id, format, done });
}

const Row = ({ number, children }: { number: number | undefined; children: ReactNode }) => (
  <div data-part="line"><span data-part="line-number">{number}</span><span data-part="line-text">{children}</span></div>
);

type NumberedProps = { text: string; start?: number; id: string; language?: string; done?: boolean; cut?: { row: number; line: number }; source?: TextSourceSnapshot };

/** The highlight blocks NumberedLines asks for when it first mounts. */
export function numberedBlocks({ text, id, language, done = true }: NumberedProps): Block[] {
  return needsTextViewer(text) ? viewerBlocks({ text, id, format: language ? { language } : undefined, done }) : [{ code: text, language, id, done }];
}

/** Numbered text uses rich rows while small and the shared viewer while large. */
export function NumberedLines({ text, start = 1, id, language, done = true, cut, source }: NumberedProps) {
  const known = useContext(GrownText);
  const grown = known?.text === text ? known : undefined;
  const metrics = useTextMetrics(text, true, grown);
  const large = needsTextViewer(text, metrics);
  const tokens = useTokens(large ? "" : text, language, id, done);
  const format = useMemo(() => language ? { language } : undefined, [language]);
  const retained = useRetained(text, source);
  if (large) return <TextViewer text={text} id={id} label="content" appendOnly grown={grown} metrics={metrics} format={format} done={done} retained={retained} />;
  const lines = splitLines(text);
  const tokenRows = tokens ? tokenLines(tokens) : undefined;
  // Past a cut's notice row, rows resume at the source line the kept tail starts on.
  const number = (index: number) => !cut || index < cut.row ? start + index : index === cut.row ? undefined : start + cut.line + index - cut.row - 1;
  const digits = String(number(lines.length - 1) ?? start + lines.length).length;
  return (
    <div data-part="tool-lines" data-language={language} style={{ "--gutter": `${digits}ch` } as CSSProperties}>
      {lines.map((line, index) => <Row key={index} number={number(index)}>{tokenRows?.[index] ? <Tokens tokens={tokenRows[index]} /> : line}</Row>)}
    </div>
  );
}

/** The last row of every body: facts on the left (exit code, cwd, size), copy buttons on the right; with no facts the
 * buttons start at the left, so the row has no empty side. */
export function Foot({ children, copy }: { children?: ReactNode; copy: Array<[label: string, value: CopyValue | undefined]> }) {
  const buttons = copy.filter((entry): entry is [string, CopyValue] => !!entry[1]);
  const facts = Children.toArray(children).length > 0;
  if (!facts && !buttons.length) return null;
  return (
    <div data-part="tool-foot">
      {facts ? <span data-part="tool-meta">{children}</span> : null}
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
      {call.meta?.argumentsTruncated ? <div data-part="tool-truncated">arguments truncated</div> : null}
      <TextViewer text={value} id={`${id}:arguments`} label="arguments" part="tool-args" format={JSON_FORMAT} opened={open} />
      <div data-part="tool-foot"><CopyButton label="arguments" value={value} /></div>
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
