import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Tokens, useTokens } from "../highlight.js";
import { useVirtualList } from "../virtual.js";
import { spansIn, type AnsiSpan } from "./ansi.js";

const SEGMENT_CHARS = 2_000;
const MAX_PREVIEW_CHARS = 50_000;
const MAX_PREVIEW_LINES = 60;
const HEAD_CHARS = 40_000;
const TAIL_CHARS = 10_000;
const ROW_HEIGHT = 21;
const GRAPHEME_LOOKBACK = 128;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export type TextMetrics = { characters: number; lines: number };
/** How text is colored: by a highlight language, or by ANSI spans over the text (already stripped of escapes). */
export type TextFormat = { language?: string; spans?: AnsiSpan[] };
export type TextSegment = { id: string; kind: string; start: number };

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

export function textMetrics(text: string): TextMetrics {
  let characters = 0;
  let newlines = 0;
  for (const character of text) {
    characters++;
    if (character === "\n") newlines++;
  }
  return { characters, lines: text === "" ? 0 : newlines + (text.endsWith("\n") ? 0 : 1) };
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
  text.length > MAX_PREVIEW_CHARS || metrics.lines > MAX_PREVIEW_LINES;

// A segment ends after its last newline when that keeps at least half a segment, so rows start on a line (which the
// highlighter needs) and a line is split only when it is longer than half a segment.
const segmentEnd = (text: string, start: number) => {
  const limit = start + SEGMENT_CHARS;
  if (limit >= text.length) return text.length;
  const newline = text.lastIndexOf("\n", limit - 1);
  return newline >= start + SEGMENT_CHARS / 2 ? newline + 1 : safeEnd(text, limit);
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

/** `text[start, end)` in its format. Each range is its own highlight block, so a viewer only highlights mounted rows. */
export function Styled({ text, start = 0, end = text.length, format, id, done = true }: { text: string; start?: number; end?: number; format?: TextFormat; id: string; done?: boolean }) {
  const slice = text.slice(start, end);
  const tokens = useTokens(slice, format?.spans ? undefined : format?.language, `${id}@${start}`, done);
  if (format?.spans) return <AnsiRun text={slice} spans={spansIn(format.spans, start, end)} />;
  return tokens ? <Tokens tokens={tokens} /> : <>{slice}</>;
}

const count = (value: number) => value.toLocaleString("en-US");

type ViewerProps = { text: string; label: string; appendOnly: boolean; follow: boolean; metrics: TextMetrics; format?: TextFormat; id: string; done: boolean };

function VirtualText({ text, label, appendOnly, follow, metrics, format, id, done }: ViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(follow);
  const [atBottom, setAtBottom] = useState(follow);
  const [newOutput, setNewOutput] = useState(false);
  const seenLength = useRef(text.length);
  const segmentCount = Math.max(1, Math.ceil(text.length / SEGMENT_CHARS));
  const segments = useSegments(text, appendOnly, Math.max(1, Math.ceil(metrics.lines / segmentCount)));
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
            const end = segments[row.index + 1]?.start ?? text.length;
            return (
              <pre
                key={row.id}
                ref={list.observeRow(row.id)}
                data-part="text-viewer-row"
                style={{ position: "absolute", insetInline: 0, transform: `translateY(${row.start}px)` } as CSSProperties}
              ><Styled text={text} start={start} end={end} format={format} id={id} done={done || !last} /></pre>
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
  preview?: ReactNode;
  part?: string;
  stream?: string;
  metrics?: TextMetrics;
  format?: TextFormat;
  /** False while the text still streams in. */
  done?: boolean;
};

/** One bounded, virtualized disclosure for every large tool text surface. */
export function TextViewer({ text, label, id, appendOnly = false, follow = false, preview, part = "tool-output", stream, metrics: suppliedMetrics, format, done = true }: TextViewerProps) {
  const [open, setOpen] = useState(false);
  const measuredMetrics = useTextMetrics(suppliedMetrics ? "" : text, appendOnly);
  const metrics = suppliedMetrics ?? measuredMetrics;
  // One child in the pre: tool-output is a column-reverse flex box, which would reverse several.
  if (!needsTextViewer(text, metrics)) return preview ?? <pre data-part={part} data-stream={stream}><span><Styled text={text} format={format} id={id} done={done} /></span></pre>;
  if (open) return <VirtualText text={text} label={label} appendOnly={appendOnly} follow={follow} metrics={metrics} format={format} id={id} done={done} />;
  const { headEnd, tailStart } = previewRanges(text);
  return (
    <>
      {preview ?? (
        <pre data-part={part} data-stream={stream}><span>
          <Styled text={text} end={headEnd} format={format} id={id} />
          <span data-part="tool-gap">… {count(metrics.lines)} lines / {count(metrics.characters)} characters; open to view all …{"\n"}</span>
          <Styled text={text} start={tailStart} format={format} id={id} done={done} />
        </span></pre>
      )}
      <button type="button" data-action="open-viewer" onClick={() => setOpen(true)}>
        open all {count(metrics.lines)} lines / {count(metrics.characters)} characters
      </button>
    </>
  );
}
