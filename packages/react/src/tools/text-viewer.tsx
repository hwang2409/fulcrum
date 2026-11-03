import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Tokens, useTokens, type Block } from "../highlight.js";
import { useVirtualList } from "../virtual.js";
import { spansIn, type AnsiSpan } from "./ansi.js";

const SEGMENT_CHARS = 500;
// The most text drawn as one highlighted block (one react commit of its tokens); larger text goes through the virtual
// viewer. Measured in chromium with the page's CPU throttled 4x (apps/playground/scripts/large-blocks.ts): about 1,900
// token spans cost one 50 ms frame. Real code has about 0.18 spans per character: 9,900 characters of typescript (157
// lines, 1,636 spans) committed with no long task and a 44-63 ms worst gap. The densest code (0.72 spans per character)
// at this cap costs about 175 ms at 4x, about 45 ms unthrottled.
const INLINE_CHARS = 10_000;
// A code block of this many lines or more is a scrolling viewer rather than a page-long box.
const INLINE_LINES = 200;
const MAX_PREVIEW_LINES = 60;
const HEAD_CHARS = INLINE_CHARS * 0.8;
const TAIL_CHARS = INLINE_CHARS * 0.2;
const ROW_HEIGHT = 21;
const HEAD_ROWS = 40;
const TAIL_ROWS = 20;
// A viewer group of structured rows ends at ROWS_PER_SEGMENT rows or SEGMENT_CHARS characters, whichever comes first
// (a longer row is a group of its own): long rows (grep hits in minified files) would otherwise put 400 kB in one group.
const ROWS_PER_SEGMENT = 40;
const GRAPHEME_LOOKBACK = 128;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export type TextMetrics = { characters: number; lines: number };
/** How text is colored: by a highlight language, or by ANSI spans over the text (already stripped of escapes). */
export type TextFormat = { language?: string; spans?: AnsiSpan[] };
export type TextSegment = { id: string; kind: string; start: number };
/** The longest structured row a parser keeps (diff lines, search lines); longer rows are cut with a notice. */
export const ROW_CHARS = INLINE_CHARS / 2; // a closed preview shows at least its first and last rows: both fit INLINE_CHARS
// Lines a viewer row of this many characters is assumed to wrap to before it is measured: a narrow viewer, so a group of
// long lines is never estimated short (an estimate too short mounts too many rows in the first commit).
const WRAP_CHARS = 80;
const wrapped = (chars: number) => Math.max(1, Math.ceil(chars / WRAP_CHARS));
// The estimated height, in lines, of one text segment: its share of the lines, or of the wrapped characters if more.
const segmentLines = (text: string, metrics: TextMetrics) => {
  const segments = Math.max(1, Math.ceil(text.length / SEGMENT_CHARS));
  return Math.max(Math.ceil(metrics.lines / segments), wrapped(text.length / segments));
};
/**
 * Structured rows (diff lines, search results). `render(start, end)` draws rows [start, end) and highlights them as one
 * block: the compact view draws every row, the viewer only its mounted groups, through the same renderer. `part`
 * names the compact view's box.
 */
export type RowModel = { count: number; part: string; language?: string; render: (start: number, end: number) => ReactNode; blocks: (start: number, end: number) => Block[]; size: (index: number) => number };

// Rows [0, head) and [tail, count) of a closed large viewer: at most HEAD_ROWS and HEAD_CHARS, TAIL_ROWS and TAIL_CHARS,
// and at least one row each. head >= tail: every row fits.
function previewRows(rows: RowModel) {
  let head = 0;
  for (let chars = 0; head < rows.count && head < HEAD_ROWS && (!head || chars + rows.size(head) <= HEAD_CHARS); head++) chars += rows.size(head);
  let tail = rows.count;
  for (let chars = 0; tail > head && rows.count - tail < TAIL_ROWS && (tail === rows.count || chars + rows.size(tail - 1) <= TAIL_CHARS); tail--) chars += rows.size(tail - 1);
  return { head, tail };
}

function rowGroups(rows: RowModel): TextSegment[] {
  const groups: TextSegment[] = [];
  for (let start = 0, end = 0; start < rows.count; start = end) {
    let lines = 0;
    for (let chars = 0; end < rows.count && end - start < ROWS_PER_SEGMENT && (end === start || chars + rows.size(end) <= SEGMENT_CHARS); end++) {
      chars += rows.size(end);
      lines += wrapped(rows.size(end));
    }
    groups.push({ id: `rows-${start}`, kind: String(lines), start });
  }
  return groups;
}

const safeEnd = (text: string, end: number) => {
  if (end >= text.length) return text.length;
  const before = text.charCodeAt(end - 1);
  const after = text.charCodeAt(end);
  if (before <= 0x7f && after <= 0x7f && !(before === 13 && after === 10)) return end;
  const windowStart = Math.max(0, end - GRAPHEME_LOOKBACK);
  let boundary = windowStart;
  for (const segment of graphemes.segment(text.slice(windowStart, end + GRAPHEME_LOOKBACK))) {
    const index = windowStart + segment.index;
    if (index > end) break;
    boundary = index;
  }
  return boundary;
};

// Native searches, not a loop over every character: a 440 kB block took tens of ms per pass on a 4x-throttled page.
export function textMetrics(text: string): TextMetrics {
  let newlines = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) newlines++;
  const pairs = text.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0; // one character each, as for...of counts
  return { characters: text.length - pairs, lines: text === "" ? 0 : newlines + (text.endsWith("\n") ? 0 : 1) };
}

export function useTextMetrics(text: string, appendOnly = false): TextMetrics {
  const cache = useRef<{ text: string; metrics: TextMetrics }>({ text: "", metrics: { characters: 0, lines: 0 } });
  const prior = cache.current;
  if (text === prior.text) return prior.metrics;
  let metrics: TextMetrics;
  if (appendOnly && text.length >= prior.text.length) {
    const delta = text.slice(prior.text.length);
    const deltaMetrics = textMetrics(delta);
    const joinsSurrogatePair = prior.text.length > 0 && delta.length > 0
      && /[\uD800-\uDBFF]/.test(prior.text.at(-1)!) && /[\uDC00-\uDFFF]/.test(delta[0]!);
    let newlines = prior.metrics.lines - (prior.text && !prior.text.endsWith("\n") ? 1 : 0);
    for (const character of delta) if (character === "\n") newlines++;
    metrics = {
      characters: prior.metrics.characters + deltaMetrics.characters - Number(joinsSurrogatePair),
      lines: text === "" ? 0 : newlines + (text.endsWith("\n") ? 0 : 1),
    };
  } else metrics = textMetrics(text);
  cache.current = { text, metrics };
  return metrics;
}

export const needsTextViewer = (text: string, metrics = textMetrics(text)) =>
  text.length > INLINE_CHARS || metrics.lines > MAX_PREVIEW_LINES;

/** Whether a code block is too large to draw inline: CodeViewer draws it. Stops counting lines at the limit. */
export function isLargeCode(text: string) {
  if (text.length > INLINE_CHARS) return true;
  let lines = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) if (++lines >= INLINE_LINES) return true;
  return false;
}

// A segment ends after its last newline when that keeps at least half a segment, so rows start on a line (which the
// highlighter needs) and a line is split only when it is longer than half a segment.
const segmentEnd = (text: string, start: number) => {
  const limit = start + SEGMENT_CHARS;
  if (limit >= text.length) return text.length;
  // Scans back at most half a segment: lastIndexOf has no lower bound and would rescan the whole text per segment.
  for (let index = limit - 1; index >= start + SEGMENT_CHARS / 2; index--) if (text.charCodeAt(index) === 10) return index + 1;
  return safeEnd(text, limit);
};

export function segmentText(text: string, estimatedLines: number): TextSegment[] {
  const segments: TextSegment[] = [];
  let start = 0;
  while (start < text.length) {
    const end = segmentEnd(text, start);
    segments.push({ id: `text-${start}`, kind: String(estimatedLines), start });
    start = end;
  }
  return segments;
}

/** Builds only newly reached fixed-size segments when appendOnly text grows. */
function useSegments(text: string, appendOnly: boolean, estimatedLines: number) {
  const cache = useRef<{ text: string; segments: TextSegment[] }>({ text: "", segments: [] });
  const prior = cache.current;
  if (text === prior.text) return prior.segments;
  const canAppend = appendOnly && prior.text.length > 0 && text.length >= prior.text.length;
  let segments: TextSegment[];
  if (canAppend) {
    segments = prior.segments;
    let start = segments.at(-1)?.start ?? 0;
    if (text.length - start > SEGMENT_CHARS) segments = [...segments];
    while (text.length - start > SEGMENT_CHARS) {
      start = segmentEnd(text, start);
      segments.push({ id: `text-${start}`, kind: String(estimatedLines), start });
    }
  } else segments = segmentText(text, estimatedLines);
  cache.current = { text, segments };
  return segments;
}

const AnsiRun = ({ text, spans }: { text: string; spans: AnsiSpan[] }) => {
  if (!spans.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.start > at) out.push(text.slice(at, span.start));
    out.push(<span key={span.start} className={span.style}>{text.slice(span.start, span.end)}</span>);
    at = span.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
};

const styledBlock = (text: string, start: number, end: number, format: TextFormat | undefined, id: string, done: boolean): Block =>
  ({ code: text.slice(start, end), language: format?.spans ? undefined : format?.language, id: `${id}@${start}`, done });

/** `text[start, end)` in its format. Each range is its own highlight block, so a viewer only highlights mounted rows. */
export const Styled = memo(function Styled({ text, start = 0, end = text.length, format, id, done = true }: { text: string; start?: number; end?: number; format?: TextFormat; id: string; done?: boolean }) {
  const { code: slice, language, id: block } = styledBlock(text, start, end, format, id, done);
  const tokens = useTokens(slice, language, block, done);
  if (format?.spans) return <AnsiRun text={slice} spans={spansIn(format.spans, start, end)} />;
  return tokens ? <Tokens tokens={tokens} /> : <>{slice}</>;
});

// One formatter: toLocaleString builds a new one per call (about 4 ms each on a 4x-throttled page).
const counts = new Intl.NumberFormat("en-US");
const count = (value: number) => counts.format(value);

type ViewerProps = { text: string; label: string; follow: boolean; metrics: TextMetrics; segments: TextSegment[]; rows?: RowModel; format?: TextFormat; id: string; done: boolean; copy?: boolean };

function VirtualText({ text, label, follow, metrics, segments, rows, format, id, done, copy }: ViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(follow);
  const [atBottom, setAtBottom] = useState(follow);
  const [newOutput, setNewOutput] = useState(false);
  const seenLength = useRef(text.length);
  const priorCount = useRef(0);
  const added = segments.length - priorCount.current;
  const update = added > 0 && priorCount.current > 0 ? { type: "append" as const, count: added } : null;
  priorCount.current = segments.length;
  const list = useVirtualList(segments, {
    estimateSize: (kind) => Number(kind) * ROW_HEIGHT,
    maxMounted: 200,
    overscan: ROW_HEIGHT * 8,
    scrollRef,
    enabled: true,
    outlineUpdate: update,
  });
  useLayoutEffect(() => {
    if (follow && following.current) list.scrollToEnd();
    else if (text.length > seenLength.current) setNewOutput(true);
    seenLength.current = text.length;
  }, [follow, text, list.scrollToEnd]);
  const onScroll = (node: HTMLDivElement) => {
    const bottom = node.scrollHeight - node.scrollTop - node.clientHeight < 1;
    following.current = follow && bottom;
    setAtBottom(bottom);
    if (bottom) setNewOutput(false);
  };
  const jump = (end: boolean) => {
    const node = scrollRef.current!;
    if (end) {
      following.current = follow;
      list.scrollToEnd();
    } else {
      following.current = false;
      node.scrollTop = 0;
    }
    node.focus({ preventScroll: true });
  };
  const position = newOutput ? "new output" : atBottom ? "at bottom" : "scrolled";
  return (
    <>
      <div data-part="text-viewer-head">
        <span data-part="text-viewer-count">{count(metrics.lines)} lines · {count(metrics.characters)} characters</span>
        <span data-part="text-viewer-position" data-position={position.replace(" ", "-")} aria-live="polite">{position}</span>
        <button type="button" data-action={atBottom ? "jump-top" : "jump-bottom"} onClick={() => jump(!atBottom)}>
          {atBottom ? "jump to top" : "jump to bottom"}
        </button>
        {copy ? <CopyButton label={label} value={text} /> : null}
      </div>
      <div
        ref={scrollRef}
        data-part="text-viewer"
        role="region"
        aria-label={`${label} viewer`}
        tabIndex={0}
        onScroll={(event) => onScroll(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key.endsWith("Up") || event.key === "Home") following.current = false;
          event.stopPropagation();
        }}
        onWheel={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
        onTouchMove={(event) => event.stopPropagation()}
      >
        <div ref={list.timelineRef} data-part="text-viewer-content" style={{ height: list.snapshot.totalSize }}>
          {list.snapshot.rows.map((row) => {
            const start = segments[row.index]!.start;
            const last = row.index === segments.length - 1;
            const end = segments[row.index + 1]?.start ?? (rows ? rows.count : text.length);
            const Row = rows ? "div" : "pre";
            return (
              <Row
                key={row.id}
                ref={list.observeRow(row.id)}
                data-part="text-viewer-row"
                data-language={rows?.language}
                style={{ position: "absolute", insetInline: 0, transform: `translateY(${row.start}px)` } as CSSProperties}
              >{rows ? rows.render(start, end) : <Styled text={text} start={start} end={end} format={format} id={id} done={done || !last} />}</Row>
            );
          })}
        </div>
      </div>
    </>
  );
}

// The preview's cut points: the first 40 lines (at most HEAD_CHARS) and the last 20 (at most TAIL_CHARS).
function previewRanges(text: string) {
  let headEnd = Math.min(HEAD_CHARS, text.length);
  let seen = 0;
  for (let index = 0; index < headEnd; index++) {
    if (text.charCodeAt(index) === 10 && ++seen === 40) { headEnd = index + 1; break; }
  }
  const tailCharStart = Math.max(headEnd, text.length - TAIL_CHARS);
  let tailStart = tailCharStart;
  seen = 0;
  for (let index = text.length - 1; index >= headEnd; index--) {
    if (text.charCodeAt(index) === 10 && ++seen === 21) { tailStart = Math.max(tailCharStart, index + 1); break; }
  }
  return { headEnd: safeEnd(text, headEnd), tailStart: safeEnd(text, tailStart) };
}

export type TextViewerProps = {
  text: string;
  label: string;
  /** Stable per surface (`<item id>:stdout`): highlight blocks and their cache are keyed by it. */
  id: string;
  appendOnly?: boolean;
  follow?: boolean;
  part?: string;
  stream?: string;
  metrics?: TextMetrics;
  format?: TextFormat;
  /** False while the text still streams in. */
  done?: boolean;
  /** Draw `text` as these structured rows instead of as text; `text` still decides the size and is what copy uses. */
  rows?: RowModel;
};

/** One bounded, virtualized disclosure for every large tool text surface. */
export function TextViewer({ text, label, id, appendOnly = false, follow = false, part = "tool-output", stream, metrics: suppliedMetrics, format, done = true, rows }: TextViewerProps) {
  const [open, setOpen] = useState(false);
  const measuredMetrics = useTextMetrics(suppliedMetrics ? "" : text, appendOnly);
  const metrics = suppliedMetrics ?? measuredMetrics;
  const large = needsTextViewer(text, metrics);
  // Segments are built only for an open viewer: text in fixed-size ranges that start on a line, rows in fixed groups.
  const textSegments = useSegments(open && !rows ? text : "", appendOnly, segmentLines(text, metrics));
  const rowSegments = useMemo(() => open && rows ? rowGroups(rows) : [], [open, rows]);
  if (rows && !(large && open)) {
    const { head, tail } = previewRows(rows);
    const cut = large && head < tail;
    return (
      <>
        <div data-part={rows.part} data-language={rows.language}>
          {cut ? <>
            {rows.render(0, head)}
            <div data-part="tool-gap">… {count(metrics.lines)} lines / {count(metrics.characters)} characters; open to view all …</div>
            {rows.render(tail, rows.count)}
          </> : rows.render(0, rows.count)}
        </div>
        {large ? <OpenButton metrics={metrics} open={() => setOpen(true)} /> : null}
      </>
    );
  }
  // One child in the pre: tool-output is a column-reverse flex box, which would reverse several.
  if (!large) return <pre data-part={part} data-stream={stream} data-language={format?.language} data-anchor={follow ? undefined : "start"}><span><Styled text={text} format={format} id={id} done={done} /></span></pre>;
  if (open) return <VirtualText text={text} label={label} follow={follow} metrics={metrics} segments={rows ? rowSegments : textSegments} rows={rows} format={format} id={id} done={done} />;
  const { headEnd, tailStart } = previewRanges(text);
  return (
    <>
      <pre data-part={part} data-stream={stream} data-language={format?.language} data-anchor={follow ? undefined : "start"}><span>
        <Styled text={text} end={headEnd} format={format} id={id} />
        <span data-part="tool-gap">… {count(metrics.lines)} lines / {count(metrics.characters)} characters; open to view all …{"\n"}</span>
        <Styled text={text} start={tailStart} format={format} id={id} done={done} />
      </span></pre>
      <OpenButton metrics={metrics} open={() => setOpen(true)} />
    </>
  );
}

export type CopyValue = string | (() => string);

export function CopyButton({ value, label }: { value: CopyValue; label: string }) {
  const [result, setResult] = useState<"copied" | "copy failed">();
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(undefined), 1500);
    return () => clearTimeout(timer);
  }, [result]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(typeof value === "function" ? value() : value);
      setResult("copied");
    } catch {
      setResult("copy failed"); // no clipboard (insecure context) or permission denied
    }
  };
  return <button type="button" data-action="copy" aria-label={`copy ${label}`} onClick={copy}>{result ?? `copy ${label}`}</button>;
}

/**
 * A code block over isLargeCode's limits: the virtual viewer, open at once, with a control that copies the whole text.
 * Only mounted ranges are in the DOM, so find-in-page reaches the visible lines; each range is highlighted on its own,
 * so the visible lines color without waiting for the whole block.
 */
export function CodeViewer({ text, language, id, done = true, label = "code" }: { text: string; language: string | undefined; id: string; done?: boolean; label?: string }) {
  const metrics = useTextMetrics(text, !done);
  const segments = useSegments(text, !done, segmentLines(text, metrics));
  const format = useMemo(() => language ? { language } : undefined, [language]);
  return <VirtualText text={text} label={label} follow={false} metrics={metrics} segments={segments} format={format} id={id} done={done} copy />;
}

const OpenButton = ({ metrics, open }: { metrics: TextMetrics; open: () => void }) => (
  <button type="button" data-action="open-viewer" onClick={open}>
    open all {count(metrics.lines)} lines / {count(metrics.characters)} characters
  </button>
);

/**
 * The highlight blocks a closed TextViewer asks for on its first render, for warming a body before it mounts. It mirrors
 * TextViewer's closed branches above; a test renders every tool body and checks the two agree.
 */
export function viewerBlocks({ text, id, format, done = true, rows }: Pick<TextViewerProps, "text" | "id" | "format" | "done" | "rows">): Block[] {
  const large = needsTextViewer(text);
  if (rows) {
    const { head, tail } = previewRows(rows);
    return large && head < tail ? [...rows.blocks(0, head), ...rows.blocks(tail, rows.count)] : rows.blocks(0, rows.count);
  }
  if (!large) return [styledBlock(text, 0, text.length, format, id, done)];
  const { headEnd, tailStart } = previewRanges(text);
  return [styledBlock(text, 0, headEnd, format, id, true), styledBlock(text, tailStart, text.length, format, id, done)];
}
