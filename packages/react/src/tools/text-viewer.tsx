import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useVirtualList } from "../virtual.js";

const SEGMENT_CHARS = 2_000;
const MAX_PREVIEW_CHARS = 50_000;
const MAX_PREVIEW_LINES = 60;
const HEAD_CHARS = 40_000;
const TAIL_CHARS = 10_000;
const ROW_HEIGHT = 21;
const GRAPHEME_LOOKBACK = 128;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export type TextMetrics = { characters: number; lines: number };
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

function previewText(text: string, metrics: TextMetrics) {
  if (!needsTextViewer(text, metrics)) return text;
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
  headEnd = safeEnd(text, headEnd);
  tailStart = safeEnd(text, tailStart);
  return `${text.slice(0, headEnd)}… ${metrics.lines.toLocaleString("en-US")} lines / ${metrics.characters.toLocaleString("en-US")} characters; open to view all …\n${text.slice(tailStart)}`;
}

export function segmentText(text: string, estimatedLines: number): TextSegment[] {
  const segments: TextSegment[] = [];
  let start = 0;
  while (start < text.length) {
    const end = safeEnd(text, Math.min(text.length, start + SEGMENT_CHARS));
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
      start = safeEnd(text, start + SEGMENT_CHARS);
      segments.push({ id: `text-${start}`, kind: String(estimatedLines), start });
    }
  } else segments = segmentText(text, estimatedLines);
  cache.current = { text, segments };
  return segments;
}

function VirtualText({ text, label, appendOnly, follow, metrics }: { text: string; label: string; appendOnly: boolean; follow: boolean; metrics: TextMetrics }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(follow);
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
  }, [follow, text, list.scrollToEnd]);
  return (
    <div
      ref={scrollRef}
      data-part="text-viewer"
      role="region"
      aria-label={`${label} viewer`}
      tabIndex={0}
      onScroll={(event) => { following.current = event.currentTarget.scrollHeight - event.currentTarget.scrollTop - event.currentTarget.clientHeight < 1; }}
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
          const end = segments[row.index + 1]?.start ?? text.length;
          return (
            <pre
              key={row.id}
              ref={list.observeRow(row.id)}
              data-part="text-viewer-row"
              style={{ position: "absolute", insetInline: 0, transform: `translateY(${row.start}px)` } as CSSProperties}
            >{text.slice(start, end)}</pre>
          );
        })}
      </div>
    </div>
  );
}

/** One bounded, virtualized disclosure for every large tool text surface. */
export function TextViewer({ text, label, appendOnly = false, follow = false, preview, part = "tool-output", stream, metrics: suppliedMetrics }: { text: string; label: string; appendOnly?: boolean; follow?: boolean; preview?: ReactNode; part?: string; stream?: string; metrics?: TextMetrics }) {
  const [open, setOpen] = useState(false);
  const measuredMetrics = useTextMetrics(suppliedMetrics ? "" : text, appendOnly);
  const metrics = suppliedMetrics ?? measuredMetrics;
  if (!needsTextViewer(text, metrics)) return preview ?? <pre data-part={part} data-stream={stream}>{text}</pre>;
  if (open) return <VirtualText text={text} label={label} appendOnly={appendOnly} follow={follow} metrics={metrics} />;
  return (
    <>
      {preview ?? <pre data-part={part} data-stream={stream}>{previewText(text, metrics)}</pre>}
      <button type="button" data-action="open-viewer" onClick={() => setOpen(true)}>
        open all {metrics.lines.toLocaleString("en-US")} lines / {metrics.characters.toLocaleString("en-US")} characters
      </button>
    </>
  );
}
