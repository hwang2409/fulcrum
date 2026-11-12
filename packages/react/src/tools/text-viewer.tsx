import { memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { HighlightContext, requestTokens, Tokens, useTokens, type Block } from "../highlight.js";
import type { Token } from "@fulcrum/highlight";
import { useVirtualList } from "../virtual.js";
import { spansIn, type AnsiSpan } from "./ansi.js";
import { markScrollable } from "../overflow.js";

const SEGMENT_CHARS = 2_000;
// A code viewer's ranges are smaller: each scrolled-in range is one react commit of its tokens, and dense code reaches
// about 1,400 spans per 2,000 characters (a 57-97 ms gap per fast-scrolled frame on a CI runner, 38-46 ms with 500).
// Plain and ANSI text keeps 2,000: four times the ranges made opening a 1,000,000-line output take 17 ms instead of 3.
const CODE_SEGMENT_CHARS = 500;
/** A code fence's range rule: highlighted text in 500-character ranges, plain text in 2,000. */
const rangeChars = (language: string | undefined) => language ? CODE_SEGMENT_CHARS : SEGMENT_CHARS;
// The most text drawn as one highlighted block (one react commit of its tokens); larger text goes through the virtual
// viewer. Measured in chromium with the page's CPU throttled 4x (apps/playground/scripts/large-blocks.ts): about 1,900
// token spans cost one 50 ms frame. Real code has about 0.18 spans per character: 9,900 characters of typescript (157
// lines, 1,636 spans) committed with no long task and a 44-63 ms worst gap. The densest code (0.72 spans per character)
// at this cap costs about 175 ms at 4x, about 45 ms unthrottled.
const INLINE_CHARS = 10_000;
// A code block of this many lines or more is a scrolling viewer rather than a page-long box. The markdown viewer is
// this many lines tall (styles.css), so a block that crosses the limit keeps its height.
const INLINE_LINES = 40;
/**
 * The most token spans drawn inline in one react commit: about 50 ms at 4x CPU throttling for the densest code (the
 * cost follows spans, not characters). A block whose tokens are more than this is drawn by CodeViewer instead.
 */
export const INLINE_SPANS = 1_000;
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
const segmentLines = (text: string, metrics: TextMetrics, size = SEGMENT_CHARS) => {
  const segments = Math.max(1, Math.ceil(text.length / size));
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
const newlinesIn = (text: string) => {
  let count = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) count++;
  return count;
};
export function textMetrics(text: string): TextMetrics {
  const newlines = newlinesIn(text);
  const pairs = text.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0; // one character each, as for...of counts
  return { characters: text.length - pairs, lines: text === "" ? 0 : newlines + (text.endsWith("\n") ? 0 : 1) };
}

/** `text` is `previous` followed by `tail`: a known append, so hooks extend their result from the tail alone. */
export type Grown = { previous: string; tail: string };

type MetricsCache = { text: string; metrics: TextMetrics; newlines: number; last: number };
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * `textMetrics(text)`, extended from the tail when the text grew by a known append (`grown`) or, with `appendOnly`,
 * extends the previous text (checked in full). The cache keeps the last code unit, so an append never reads the old text.
 */
export function useTextMetrics(text: string, appendOnly = false, grown?: Grown): TextMetrics {
  const cache = useRef<MetricsCache>({ text: "", metrics: { characters: 0, lines: 0 }, newlines: 0, last: -1 });
  const prior = cache.current;
  if (text === prior.text) return prior.metrics;
  const delta = grown && grown.previous === prior.text ? grown.tail
    : appendOnly && text.startsWith(prior.text) ? text.slice(prior.text.length)
    : undefined;
  let next: MetricsCache;
  if (delta !== undefined) {
    const newlines = prior.newlines + newlinesIn(delta);
    const last = delta ? delta.charCodeAt(delta.length - 1) : prior.last;
    const joinsPair = delta !== "" && isHigh(prior.last) && isLow(delta.charCodeAt(0));
    const characters = prior.metrics.characters + textMetrics(delta).characters - Number(joinsPair);
    next = { text, newlines, last, metrics: { characters, lines: text.length === 0 ? 0 : newlines + (last === 10 ? 0 : 1) } };
  } else {
    const metrics = textMetrics(text);
    const last = text ? text.charCodeAt(text.length - 1) : -1;
    next = { text, metrics, newlines: metrics.lines - (text && last !== 10 ? 1 : 0), last };
  }
  cache.current = next;
  return next.metrics;
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
const segmentEnd = (text: string, start: number, size: number) => {
  const limit = start + size;
  if (limit >= text.length) return text.length;
  // Scans back at most half a segment: lastIndexOf has no lower bound and would rescan the whole text per segment.
  for (let index = limit - 1; index >= start + size / 2; index--) if (text.charCodeAt(index) === 10) return index + 1;
  return safeEnd(text, limit);
};

export function segmentText(text: string, estimatedLines: number, size = SEGMENT_CHARS): TextSegment[] {
  const segments: TextSegment[] = [];
  let start = 0;
  while (start < text.length) {
    const end = segmentEnd(text, start, size);
    segments.push({ id: `text-${start}`, kind: String(estimatedLines), start });
    start = end;
  }
  return segments;
}

/** The viewer's segments with each one's text: `sealed[i]` for every segment but the last, `open` for the last. */
type Segmented = { text: string; segments: TextSegment[]; sealed: string[]; open: string };

const segmentTextAt = ({ sealed, open }: Segmented, index: number) => sealed[index] ?? open;

/**
 * Text in fixed-size segments. A known append (`grown`, or with `appendOnly` a text that extends the previous one,
 * checked in full) extends the last segment from the tail and builds only newly reached segments; the old segments
 * stay the same objects. Rows draw from the segment texts, so an append never reads the whole text.
 */
function useSegments(text: string, appendOnly: boolean, estimatedLines: number, size = SEGMENT_CHARS, grown?: Grown): Segmented {
  const cache = useRef<Segmented>({ text: "", segments: [], sealed: [], open: "" });
  const prior = cache.current;
  if (text === prior.text) return prior;
  const tail = prior.text === "" ? undefined
    : grown && grown.previous === prior.text ? grown.tail
    : appendOnly && text.startsWith(prior.text) ? text.slice(prior.text.length)
    : undefined;
  let next: Segmented;
  if (tail !== undefined) {
    let { segments, sealed } = prior;
    let open = prior.open + tail;
    let start = segments.at(-1)!.start;
    // shortcut (timeline lane): an append that seals a segment copies the segment arrays (O(n / SEGMENT_CHARS) references), because
    // useVirtualList (virtual.tsx) applies an outline only when its identity changes (`appliedOutline.current !==
    // outline`). The 1-line fix there: also apply when `options.outlineUpdate` is new; then push here in place.
    if (open.length > size) {
      segments = [...segments];
      sealed = [...sealed];
    }
    while (open.length > size) {
      const end = segmentEnd(open, 0, size);
      sealed.push(open.slice(0, end));
      open = open.slice(end);
      start += end;
      segments.push({ id: `text-${start}`, kind: String(estimatedLines), start });
    }
    next = { text, segments, sealed, open };
  } else {
    const segments = segmentText(text, estimatedLines, size);
    const sealed = segments.slice(0, -1).map((segment, index) => text.slice(segment.start, segments[index + 1]!.start));
    next = { text, segments, sealed, open: text.slice(segments.at(-1)?.start ?? 0) };
  }
  cache.current = next;
  return next;
}

const AnsiRun = ({ text, spans }: { text: string; spans: AnsiSpan[] }) => {
  if (!spans.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  for (const [index, span] of spans.entries()) {
    if (span.start > at) out.push(text.slice(at, span.start));
    out.push(<span key={index} className={span.style}>{text.slice(span.start, span.end)}</span>);
    at = span.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
};

// The most text a viewer also asks for as one whole block, in the background: a construct longer than a range (a block
// comment, a docstring, a template string) is colored from the grammar's real state, not restarted at each range edge.
// The whole request goes out only once the mounted ranges have colored, and the worker cannot split it, so the cap
// bounds what it holds up: at 10,000 characters one request took 50 ms for the densest cpp line (the large-blocks
// fixture), 10 ms for tsx, 3.5 ms for python, 1 ms for json (V8, median of 3; 100,000 was 479 / 98 / 25 / 8 ms).
// shortcut: a block over WHOLE_CHARS keeps range-local colors; upgrade by carrying grammar state across range requests
// (the worker keeps a session per block already; it needs delta replies so each slice does not resend the prefix).
const WHOLE_CHARS = 10_000;
// The highlighter answers a block over this many lines as plain text (packages/highlight/src/controller.ts MAX_LINES).
const WHOLE_LINES = 10_000;
type WholeTokens = { tokens: Token[]; starts: number[]; length: number };

const indexed = (tokens: Token[]): WholeTokens => {
  const starts: number[] = [];
  let at = 0;
  for (const token of tokens) { starts.push(at); at += token.text.length; }
  return { tokens, starts, length: at };
};

// The whole block's tokens once they arrive; until then `seed` (tokens an inline block already had for a prefix of the
// text), so a block that becomes a viewer keeps its colors. `ranges`: the mounted rows' blocks, which color first; the
// whole block is asked for once they have, and never when the viewer unmounts or its text changes before then.
function useWholeTokens(text: string, lines: number, format: TextFormat | undefined, id: string, done: boolean, ranges: Block[], seed?: Token[] | null): WholeTokens | null {
  const highlight = useContext(HighlightContext);
  const language = done && !format?.spans && text.length <= WHOLE_CHARS && lines <= WHOLE_LINES ? format?.language : undefined;
  const [asked, setAsked] = useState<string>();
  const mounted = useRef(ranges);
  mounted.current = ranges;
  const hasRanges = ranges.length > 0;
  useEffect(() => {
    if (!language || !hasRanges) return;
    let live = true;
    void Promise.all(mounted.current.map((block) => requestTokens(highlight, block))).then(() => { if (live) setAsked(text); });
    return () => { live = false; };
  }, [highlight, language, text, hasRanges]);
  const tokens = useTokens(language && asked === text ? text : "", language, `${id}:whole`);
  // One untyped token is the highlighter's plain answer (no worker, or over its limits): the ranges' colors stay.
  const whole = useMemo(() => tokens && !(tokens.length === 1 && !tokens[0]!.type) ? indexed(tokens) : null, [tokens]);
  const seeded = useMemo(() => {
    const prefix = seed && indexed(seed);
    return prefix && text.startsWith(seed!.map((token) => token.text).join("")) ? prefix : null;
  }, [seed, text]);
  return whole ?? seeded ?? null;
}

/** The whole block's tokens over [start, end), cut at the edges. */
function sliceTokens({ tokens, starts }: WholeTokens, start: number, end: number): Token[] {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (starts[mid]! + tokens[mid]!.text.length <= start) low = mid + 1;
    else high = mid;
  }
  const out: Token[] = [];
  for (let index = low; index < tokens.length && starts[index]! < end; index++) {
    const token = tokens[index]!;
    const from = Math.max(start - starts[index]!, 0);
    const to = Math.min(end - starts[index]!, token.text.length);
    out.push(from === 0 && to === token.text.length ? token : { ...token, text: token.text.slice(from, to) });
  }
  return out;
}

// `text` holds the whole text's [offset, offset + text.length); start and end are positions in the whole text.
const styledBlock = (text: string, start: number, end: number, format: TextFormat | undefined, id: string, done: boolean, offset = 0): Block =>
  ({ code: text.slice(start - offset, end - offset), language: format?.spans ? undefined : format?.language, id: `${id}@${start}`, done });

/**
 * `[start, end)` of the whole text in its format; `text` is the whole text from `offset` on (a viewer passes one
 * segment). Each range is its own highlight block, so a viewer only highlights mounted rows.
 */
export const Styled = memo(function Styled({ text, offset = 0, start = offset, end = offset + text.length, format, id, done = true, whole }: { text: string; offset?: number; start?: number; end?: number; format?: TextFormat; id: string; done?: boolean; whole?: WholeTokens | null }) {
  const { code: slice, language, id: block } = styledBlock(text, start, end, format, id, done, offset);
  const covered = whole && whole.length >= end ? whole : null; // a seed may cover only a prefix of the text
  const own = useTokens(slice, covered ? undefined : language, block, done);
  const tokens = covered ? sliceTokens(covered, start, end) : own;
  if (format?.spans) return <AnsiRun text={slice} spans={spansIn(format.spans, start, end)} />;
  return tokens ? <Tokens tokens={tokens} /> : <>{slice}</>;
});

// One formatter: toLocaleString builds a new one per call (about 4 ms each on a 4x-throttled page).
const counts = new Intl.NumberFormat("en-US");
const count = (value: number) => counts.format(value);

type ViewerProps = { text: string; label: string; follow: boolean; metrics: TextMetrics; segments: TextSegment[]; texts?: Segmented; rows?: RowModel; format?: TextFormat; id: string; done: boolean; copy?: boolean; seed?: Token[] | null; caption?: string; focus?: boolean; live?: boolean };
type Place = "top" | "middle" | "bottom";
const placeWords: Record<Place, string> = { top: "at top", middle: "scrolled", bottom: "at bottom" };

function VirtualText({ text, label, follow, metrics, segments, texts, rows, format, id, done, copy, seed, caption, focus, live }: ViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(follow);
  const lastTop = useRef(0);
  const [place, setPlace] = useState<Place>(follow ? "bottom" : "top");
  const [newOutput, setNewOutput] = useState(false);
  const seenLength = useRef(text.length);
  // useSegments either extends its array (a copy whose old segments are the same objects) or builds a new one: an
  // extension is one splice after the prior segments.
  const prior = useRef<TextSegment[]>([]);
  const from = prior.current;
  const update = from.length > 0 && segments.length > from.length && segments[from.length - 1] === from.at(-1)
    ? { from, splices: [{ index: from.length, deleteCount: 0, items: segments.slice(from.length) }] }
    : null;
  prior.current = segments;
  const list = useVirtualList(segments, {
    estimateSize: (kind) => Number(kind) * ROW_HEIGHT,
    maxMounted: 200,
    overscan: ROW_HEIGHT * 8,
    scrollRef,
    enabled: true,
    outlineUpdate: update,
  });
  // A text row is one segment: it draws from the segment's own text, never from a slice of the whole text. The list's
  // rows are one render behind a text that was replaced rather than extended (a cut output's tail slid), so a row past
  // the new segments is skipped until the list catches up.
  const ranges = list.snapshot.rows.filter((row) => row.index < segments.length).map((row) => {
    const last = row.index === segments.length - 1;
    const slice = texts ? segmentTextAt(texts, row.index) : "";
    return { row, start: segments[row.index]!.start, end: segments[row.index + 1]?.start ?? (rows ? rows.count : text.length), done: done || !last, slice };
  });
  const whole = useWholeTokens(rows ? "" : text, metrics.lines, format, id, done, rows ? [] : ranges.map(({ start, end, done, slice }) => styledBlock(slice, start, end, format, id, done, start)), seed);
  useLayoutEffect(() => {
    if (follow && following.current) list.scrollToEnd();
    else if (text.length > seenLength.current) setNewOutput(true);
    seenLength.current = text.length;
  }, [follow, text, list.scrollToEnd]);
  // Opened by a control that unmounts (the closed preview's "open all"): focus moves to the viewer, not to the page.
  useLayoutEffect(() => { if (focus) scrollRef.current?.focus({ preventScroll: true }); }, []);
  const onScroll = (node: HTMLDivElement) => {
    const bottom = node.scrollHeight - node.scrollTop - node.clientHeight < 1;
    // Only a move up leaves the bottom: rows that grow or settle after their measure move nothing and are no user scroll.
    if (bottom) following.current = follow;
    else if (node.scrollTop < lastTop.current) following.current = false;
    lastTop.current = node.scrollTop;
    setPlace(bottom || following.current ? "bottom" : node.scrollTop < 1 ? "top" : "middle");
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
  const atBottom = place === "bottom";
  const position = newOutput ? "new output" : placeWords[place];
  const target = atBottom ? "top" : "bottom";
  return (
    <>
      <div data-part="text-viewer-head">
        {caption ? <span data-part="text-viewer-language">{caption}</span> : null}
        {/* Narrow heads drop the character count and the buttons' verbs (styles.css): the head stays one row. */}
        <span data-part="text-viewer-count">{count(metrics.lines)}<span data-part="text-viewer-unit"> {metrics.lines === 1 ? "line" : "lines"}</span><span data-part="text-viewer-wide"> · {count(metrics.characters)} characters</span></span>
        {/* A streaming fence has no cursor in its lazily mounted rows: the head says it streams, as a running tool does. */}
        {live ? <span data-part="text-viewer-status"><span>streaming</span></span> : null}
        <span data-part="text-viewer-position" data-position={position.replace(" ", "-")} aria-live="polite">{position}</span>
        <button type="button" data-action={`jump-${target}`} aria-label={`jump to ${target}`} onClick={() => jump(!atBottom)}>
          <span data-part="text-viewer-wide">jump to </span>{target}
        </button>
        {copy ? <CopyButton label={label} value={text} /> : null}
      </div>
      <div
        ref={scrollRef}
        data-part="text-viewer"
        data-language={rows ? undefined : format?.language}
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
          {ranges.map(({ row, start, end, done: rangeDone, slice }) => {
            const Row = rows ? "div" : "pre";
            return (
              <Row
                key={row.id}
                ref={list.observeRow(row.id)}
                data-part="text-viewer-row"
                data-language={rows?.language}
                style={{ position: "absolute", insetInline: 0, transform: `translateY(${row.start}px)` } as CSSProperties}
              >{rows ? rows.render(start, end) : <Styled text={slice} offset={start} format={format} id={id} done={rangeDone} whole={whole} />}</Row>
            );
          })}
        </div>
      </div>
    </>
  );
}

/**
 * A closed preview's text: `head` is the text's first characters, `tail` its last (positions from `length -
 * tail.length`). Each window holds what the preview's cut points read, with room for safeEnd's grapheme lookback, so a
 * known append (`grown`) moves the tail window by the appended text alone and never reads the whole text.
 */
type Ends = { text: string; head: string; tail: string };
const HEAD_WINDOW = HEAD_CHARS + 2 * GRAPHEME_LOOKBACK;
const TAIL_WINDOW = TAIL_CHARS + 2 * GRAPHEME_LOOKBACK;
const endsOf = (text: string): Ends => ({ text, head: text.slice(0, HEAD_WINDOW), tail: text.slice(-TAIL_WINDOW) });

function useEnds(text: string, grown?: Grown): Ends {
  const cache = useRef<Ends>({ text: "", head: "", tail: "" });
  const prior = cache.current;
  if (text === prior.text) return prior;
  const delta = grown && grown.previous === prior.text ? grown.tail : undefined;
  const next = delta === undefined
    ? endsOf(text)
    : {
      text,
      head: prior.head.length >= HEAD_WINDOW ? prior.head : (prior.head + delta).slice(0, HEAD_WINDOW),
      tail: (prior.tail + delta).slice(-TAIL_WINDOW),
    };
  cache.current = next;
  return next;
}

// The preview's cut points: the first 40 lines (at most HEAD_CHARS) and the last 20 (at most TAIL_CHARS). Reads only
// the two windows: a position past the head window is in the tail window.
function previewRanges({ text, head, tail }: Ends) {
  const length = text.length;
  const offset = length - tail.length;
  let headEnd = Math.min(HEAD_CHARS, length);
  let seen = 0;
  for (let index = 0; index < headEnd; index++) {
    if (head.charCodeAt(index) === 10 && ++seen === 40) { headEnd = index + 1; break; }
  }
  const tailCharStart = Math.max(headEnd, length - TAIL_CHARS);
  let tailStart = tailCharStart;
  seen = 0;
  // A newline before tailCharStart - 1 cannot move tailStart past tailCharStart: the scan stops there.
  for (let index = length - 1; index >= Math.max(headEnd, tailCharStart - 1); index--) {
    if (tail.charCodeAt(index - offset) === 10 && ++seen === 21) { tailStart = Math.max(tailCharStart, index + 1); break; }
  }
  return { headEnd: safeEnd(head, headEnd), tailStart: offset + safeEnd(tail, tailStart - offset), offset };
}

export type TextViewerProps = {
  text: string;
  label: string;
  /** Stable per surface (`<item id>:stdout`): highlight blocks and their cache are keyed by it. */
  id: string;
  appendOnly?: boolean;
  /** How `text` grew from the previous render's text, when the caller knows (a streamed output): nothing re-reads it. */
  grown?: Grown;
  follow?: boolean;
  part?: string;
  stream?: string;
  metrics?: TextMetrics;
  format?: TextFormat;
  /** False while the text still streams in. */
  done?: boolean;
  /** Draw `text` as these structured rows instead of as text; `text` still decides the size and is what copy uses. */
  rows?: RowModel;
  /** Start a large text in the open viewer instead of its cut preview (what an approval asks about is never cut). */
  opened?: boolean;
};

/** One bounded, virtualized disclosure for every large tool text surface. */
export function TextViewer({ text, label, id, appendOnly = false, grown, follow = false, part = "tool-output", stream, metrics: suppliedMetrics, format, done = true, rows, opened = false }: TextViewerProps) {
  const [open, setOpen] = useState<boolean | "focus">(opened);
  const measuredMetrics = useTextMetrics(suppliedMetrics ? "" : text, appendOnly, grown);
  const metrics = suppliedMetrics ?? measuredMetrics;
  const large = needsTextViewer(text, metrics);
  // Segments are built only for an open viewer: text in fixed-size ranges that start on a line, rows in fixed groups.
  // shortcut: the tool viewer keeps 2,000 even for highlighted text; 500 made opening a 1,000,000-line .ts read take
  // 20 ms (the layout gate's bound is 16). Upgrade when segments are built lazily, so their count no longer costs the open.
  const textSegments = useSegments(open && !rows ? text : "", appendOnly, segmentLines(text, metrics), SEGMENT_CHARS, grown);
  const ends = useEnds(large && !open && !rows ? text : "", grown);
  // "open all" unmounts itself: the viewer it opens takes focus.
  const openViewer = () => setOpen("focus");
  const rowSegments = useMemo(() => open && rows ? rowGroups(rows) : [], [open, rows]);
  const cap = useCap(rows ? rows.count : text, label);
  if (rows && !(large && open)) {
    const { head, tail } = previewRows(rows);
    const cut = large && head < tail;
    return (
      <>
        <div ref={cap.ref} data-part={rows.part} data-language={rows.language} data-expanded={cap.expanded ? "" : undefined}>
          {cut ? <>
            {rows.render(0, head)}
            <div data-part="tool-gap">… {count(tail - head)} more lines of {count(rows.count)} …</div>
            {rows.render(tail, rows.count)}
          </> : rows.render(0, rows.count)}
        </div>
        {cap.expand ? <ExpandButton lines={metrics.lines} expand={cap.expand} /> : null}
        {large ? <OpenButton metrics={metrics} open={openViewer} /> : null}
      </>
    );
  }
  // One child in the pre: tool-output is a column-reverse flex box, which would reverse several.
  if (!large) return (
    <>
      <pre ref={cap.ref} data-part={part} data-stream={stream} data-language={format?.language} data-anchor={follow ? undefined : "start"} data-expanded={cap.expanded ? "" : undefined}><span><Styled text={text} format={format} id={id} done={done} /></span></pre>
      {cap.expand ? <ExpandButton lines={metrics.lines} expand={cap.expand} /> : null}
    </>
  );
  if (open) return <VirtualText text={text} label={label} follow={follow} metrics={metrics} segments={rows ? rowSegments : textSegments.segments} texts={rows ? undefined : textSegments} rows={rows} format={format} id={id} done={done} focus={open === "focus"} />;
  const { headEnd, tailStart, offset } = previewRanges(ends);
  const shown = textMetrics(ends.head.slice(0, headEnd)).lines + textMetrics(ends.tail.slice(tailStart - offset)).lines;
  return (
    <>
      <pre ref={cap.ref} data-part={part} data-stream={stream} data-language={format?.language} data-anchor={follow ? undefined : "start"}><span>
        <Styled text={ends.head} end={headEnd} format={format} id={id} />
        <span data-part="tool-gap">… {count(metrics.lines - shown)} more lines of {count(metrics.lines)} …{"\n"}</span>
        <Styled text={ends.tail} offset={offset} start={tailStart} format={format} id={id} done={done} />
      </span></pre>
      <OpenButton metrics={metrics} open={openViewer} />
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
  return <button type="button" data-action="copy" aria-label={`copy ${label}`} onClick={copy}>{result ?? <>copy<span data-part="text-viewer-wide"> {label}</span></>}</button>;
}

/**
 * A code block over isLargeCode's limits: the virtual viewer, open at once, with a control that copies the whole text.
 * Only mounted ranges are in the DOM, so find-in-page reaches the visible lines; each range is highlighted on its own,
 * so the visible lines color without waiting for the whole block. `seed`: tokens the block already has for a prefix of
 * `text` (an inline block that became this viewer), shown until the viewer's own colors arrive.
 */
export function CodeViewer({ text, language, id, done = true, label = "code", seed }: { text: string; language: string | undefined; id: string; done?: boolean; label?: string; seed?: Token[] | null }) {
  const metrics = useTextMetrics(text, !done);
  const size = rangeChars(language);
  const segments = useSegments(text, !done, segmentLines(text, metrics, size), size);
  const format = useMemo(() => language ? { language } : undefined, [language]);
  // A block still streaming in follows its newest line, as the timeline follows the run; a finished one starts at its top.
  return <VirtualText text={text} label={label} follow={!done} metrics={metrics} segments={segments.segments} texts={segments} format={format} id={id} done={done} copy seed={seed} caption={language} live={!done} />;
}

/**
 * A box capped by styles.css (output, arguments, numbered lines) says when it cuts its content: a fade on each cut
 * edge (`data-fade`, set on scroll without a render) and `expand`, which lifts the cap. `content` changes re-measure.
 */
function useCap(content: unknown, label: string) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [cut, setCut] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    if (!node || expanded || typeof ResizeObserver === "undefined") return;
    const reverse = getComputedStyle(node).flexDirection === "column-reverse"; // a log scrolled from its bottom
    const update = () => {
      const hidden = node.scrollHeight - node.clientHeight;
      const top = reverse ? hidden + node.scrollTop : node.scrollTop;
      const fade = hidden > 1 ? `${top > 1 ? "top " : ""}${top < hidden - 1 ? "bottom" : ""}`.trim() : "";
      if (fade) node.dataset.fade = fade;
      else delete node.dataset.fade;
      markScrollable(node, hidden > 1 || node.scrollWidth - node.clientWidth > 1 ? label : null);
      setCut(hidden > 1);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    for (const child of node.children) observer.observe(child); // the content grows inside a box held at its cap
    node.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      node.removeEventListener("scroll", update);
      delete node.dataset.fade;
      markScrollable(node, null);
    };
  }, [node, expanded, content, label]);
  // "show all" unmounts itself: focus moves to the box it opened (tabIndex -1: focusable by script, not a tab stop).
  const expand = () => {
    setExpanded(true);
    if (!node) return;
    node.tabIndex = -1;
    node.focus({ preventScroll: true });
  };
  return { ref: setNode, expanded, expand: cut && !expanded ? expand : undefined };
}

const ExpandButton = ({ lines, expand }: { lines: number; expand: () => void }) => (
  <button type="button" data-action="expand" onClick={expand}>show all {count(lines)} lines</button>
);

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
  const ends = endsOf(text);
  const { headEnd, tailStart, offset } = previewRanges(ends);
  return [styledBlock(ends.head, 0, headEnd, format, id, true), styledBlock(ends.tail, tailStart, text.length, format, id, done, offset)];
}
