import type {
  ContentBlock,
  StoredResultBlock,
  StoredToolResult,
  StoredToolView,
  TextChunk,
  TextOmission,
  TextSourceSnapshot,
  ToolResult,
  ToolView,
} from "./events.js";

export const DEFAULT_TOOL_OUTPUT_ITEM_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TOOL_OUTPUT_RUN_BYTES = 10 * 1024 * 1024;
/**
 * Completed tools whose bodies run-cap eviction never omits, newest first. Three covers the usual "run, read the
 * failure, run again" loop the reader is looking at, while a long run still frees everything older.
 */
export const PROTECTED_COMPLETED_TOOLS = 3;
const CHUNK_BYTES = 32 * 1024;
// A cut never lands inside an escape sequence; the longest one a terminal parser keeps (an OSC string) is 4096 units.
const ANSI_LOOKBACK = 4_096 + 16;

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const unitBytes = (code: number) => (code < 0x80 ? 1 : code < 0x800 ? 2 : 3);

// Native UTF-8 passes over pieces of at most PIECE units (a pair is never split), through one scratch buffer: no
// per-character calls and no allocation proportional to the text.
const PIECE = 16_384;
const encoder = new TextEncoder();
// ignoreBOM: a leading U+FEFF is text here, not a byte-order mark to drop.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const scratch = new Uint8Array(PIECE * 3 + 3);
const pieceEnd = (text: string, at: number, to: number) => {
  const end = Math.min(to, at + PIECE);
  return end < to && isHigh(text.charCodeAt(end - 1)) ? end + 1 : end;
};
/** UTF-8 bytes of text[from, to), which is canonical (no lone surrogate). */
const utf8Length = (text: string, from = 0, to = text.length) => {
  let bytes = 0;
  for (let at = from; at < to;) {
    const end = pieceEnd(text, at, to);
    bytes += encoder.encodeInto(at === 0 && end === text.length ? text : text.slice(at, end), scratch).written;
    at = end;
  }
  return bytes;
};
const newlines = (text: string, from = 0, to = text.length) => {
  let count = 0;
  for (let at = text.indexOf("\n", from); at >= 0 && at < to; at = text.indexOf("\n", at + 1)) count++;
  return count;
};
// Lone surrogates become U+FFFD, so byte accounting and every later cut see well-formed text.
const canonical = (text: string) => text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\ufffd");

// Where the escape sequence starting at `at` ends, by the terminal parser's rules and bounds; -1 if the text ends first.
const sequenceEnd = (text: string, at: number) => {
  const code = text.charCodeAt(at);
  const next = text[at + 1];
  if (code === 0x1b && next === undefined) return -1;
  if (code === 0x9b || (code === 0x1b && next === "[")) {
    const from = code === 0x9b ? at + 1 : at + 2;
    let index = from;
    while (index < text.length && index - from <= 64 && text.charCodeAt(index) >= 0x20 && text.charCodeAt(index) <= 0x3f) index++;
    if (index === text.length && index - from <= 64) return -1;
    const final = text.charCodeAt(index);
    return index - from <= 64 && final >= 0x40 && final <= 0x7e ? index + 1 : from;
  }
  if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f || (code === 0x1b && "]PX^_".includes(next!))) {
    const from = code === 0x1b ? at + 2 : at + 1;
    for (let index = from; index < text.length && index - from <= 4_096; index++) {
      const value = text.charCodeAt(index);
      if (value === 0x07 || value === 0x9c) return index + 1;
      if (value === 0x1b) return index + 1 === text.length ? -1 : text[index + 1] === "\\" ? index + 2 : index;
    }
    return text.length - from <= 4_096 ? -1 : from;
  }
  if (code !== 0x1b) return at + 1;
  let index = at + 1;
  while (index < text.length && index - at <= 16 && text.charCodeAt(index) >= 0x20 && text.charCodeAt(index) <= 0x2f) index++;
  if (index === text.length && index - at <= 16) return -1;
  const final = text.charCodeAt(index);
  return final >= 0x30 && final <= 0x7e && index - at <= 16 ? index + 1 : at + 1;
};
const INTRODUCER = /[\x1b\x90\x98\x9b\x9d\x9e\x9f]/g;
/** The escape sequence `at` falls inside, as [start, end), or undefined. Reads at most ANSI_LOOKBACK units before `at`. */
const sequenceAround = (text: string, at: number): [number, number] | undefined => {
  // A window, so a long text with no escape after `at` is not searched to its end. A sequence that starts before `at`
  // ends within ANSI_LOOKBACK of it, so a window end before the text's end never reads as an unfinished sequence.
  const from = Math.max(0, at - ANSI_LOOKBACK);
  const to = Math.min(text.length, at + ANSI_LOOKBACK);
  const window = from === 0 && to === text.length ? text : text.slice(from, to);
  const local = at - from;
  INTRODUCER.lastIndex = 0;
  for (let match = INTRODUCER.exec(window); match && match.index < local; match = INTRODUCER.exec(window)) {
    const end = sequenceEnd(window, match.index);
    if (end < 0 || end > local) return [from + match.index, end < 0 ? text.length : from + end];
    INTRODUCER.lastIndex = end;
  }
  return undefined;
};
/**
 * The nearest cut at or before (`left`) or after (`right`) `at` that splits no surrogate pair, no CRLF, and no
 * escape sequence, so neither side of an omission shows half a character, line ending, or control.
 */
const safeCut = (text: string, at: number, side: "left" | "right") => {
  const sequence = sequenceAround(text, at);
  if (sequence) at = side === "left" ? sequence[0] : sequence[1];
  if (at > 0 && at < text.length) {
    const before = text.charCodeAt(at - 1);
    if (isHigh(before) && isLow(text.charCodeAt(at))) at += side === "left" ? -1 : 1;
    else if (before === 13 && text.charCodeAt(at) === 10) at += side === "left" ? -1 : 1;
  }
  return at;
};
/** The largest end in [from, to] with utf8(text[from, end)) <= budget. Never splits a pair. */
const prefixEnd = (text: string, from: number, to: number, budget: number) => {
  let at = from;
  while (at < to) {
    const code = text.charCodeAt(at);
    const pair = isHigh(code) && at + 1 < to && isLow(text.charCodeAt(at + 1));
    const bytes = pair ? 4 : unitBytes(code);
    if (bytes > budget) break;
    budget -= bytes;
    at += pair ? 2 : 1;
  }
  return at;
};
/** The smallest start in [from, to] with utf8(text[start, to)) <= budget. Never splits a pair. */
const suffixStart = (text: string, from: number, to: number, budget: number) => {
  let at = to;
  while (at > from) {
    const code = text.charCodeAt(at - 1);
    const pair = isLow(code) && at - 2 >= from && isHigh(text.charCodeAt(at - 2));
    const bytes = pair ? 4 : unitBytes(code);
    if (bytes > budget) break;
    budget -= bytes;
    at -= pair ? 2 : 1;
  }
  return at;
};

/**
 * A fresh copy of canonical text[start, end): decoded from its UTF-8 bytes, so the result cannot share storage with
 * (and keep alive) a larger parent string, as a slice or substring may in either engine.
 */
const owned = (text: string, start: number, end: number) => {
  let result = "";
  for (let at = start; at < end;) {
    const stop = pieceEnd(text, at, end);
    const { written } = encoder.encodeInto(text.slice(at, stop), scratch);
    result += decoder.decode(scratch.subarray(0, written));
    at = stop;
  }
  return result;
};

type Chunk = TextChunk & { readonly bytes: number };
const chunk = (start: number, line: number, text: string, bytes: number): Chunk => Object.freeze({ start, line, text, bytes });
/** Owned chunks of at most `size` bytes for text[from, to), whose first unit is at logical `start` on logical `line`. */
const chunksOf = (text: string, from: number, to: number, start: number, line: number, into: Chunk[] = [], size = CHUNK_BYTES) => {
  for (let at = from; at < to;) {
    let end = prefixEnd(text, at, to, size);
    // Keep CR with its LF, so a chunk ends a whole line ending (end > at + 1 always: size >= 4 holds a pair or CRLF).
    if (end < to && text.charCodeAt(end - 1) === 13 && text.charCodeAt(end) === 10) end--;
    const value = owned(text, at, end);
    into.push(chunk(start + at - from, line, value, utf8Length(value)));
    line += newlines(value);
    at = end;
  }
  return into;
};
/**
 * Appends `added`, which starts at logical `start` on logical `line`, to `values` in place. The last chunk fills to
 * `size` first, so a stream of small deltas keeps few chunks; both halves of a filled chunk are owned strings.
 */
function appendChunks(values: Chunk[], added: string, start: number, line: number, size: number) {
  const last = values.at(-1);
  let from = 0;
  if (last && added && last.bytes < size) {
    let end = prefixEnd(added, 0, added.length, size - last.bytes);
    if (end < added.length && added.charCodeAt(end - 1) === 13 && added.charCodeAt(end) === 10) end--;
    if (end > 0) {
      const value = owned(added, 0, end);
      values[values.length - 1] = chunk(last.start, last.line, last.text + value, last.bytes + utf8Length(value));
      from = end;
    }
  }
  return chunksOf(added, from, added.length, start + from, line + newlines(added, 0, from), values, size);
}
/**
 * Chunk size for a cut source's tail, which slides by dropping whole chunks: small against the tail's budget, so a
 * slide keeps all but at most one chunk of it.
 */
const tailGrain = (budget: number) => Math.max(4, Math.min(CHUNK_BYTES, Math.floor(budget / 8)));
/**
 * What a tail keeps when it slides: one grain under its budget. A slide replaces the kept text (a reader rebuilds it),
 * so this headroom makes the next slide wait for at least one more grain of output instead of the next append.
 */
const slidBudget = (budget: number) => Math.max(0, budget - tailGrain(budget));
/** `chunks` split so none holds more than `size` bytes (a one-time copy when a source is first cut). */
const regrain = (chunks: readonly Chunk[], size: number) => {
  const out: Chunk[] = [];
  for (const value of chunks) {
    if (value.bytes <= size) out.push(value);
    else chunksOf(value.text, 0, value.text.length, value.start, value.line, out, size);
  }
  return out;
};

// A lineage is an identity token, so two equal texts compare equal structurally whatever their history.
type Lineage = object | undefined;
const lineage = (): Lineage => ({});
class Source implements TextSourceSnapshot {
  readonly lines: number;
  constructor(
    readonly version: number,
    readonly length: number,
    readonly bytes: number,
    readonly retainedBytes: number,
    readonly omission: TextOmission | null,
    readonly protocolTruncated: boolean,
    /** Head chunks (before the omission) then tail chunks. */
    readonly values: readonly Chunk[],
    readonly headCount: number,
    readonly newlineCount: number,
    readonly endsNewline: boolean,
    /** A held high surrogate waiting for its low half; not part of the published text. */
    readonly pendingHigh: string,
    /** Shared by snapshots that only appended to one another, so a reader can take the added text alone. */
    readonly lineage: Lineage,
  ) {
    this.lines = newlineCount + (length > 0 && !endsNewline ? 1 : 0);
    Object.freeze(this);
  }
  chunks(): IterableIterator<TextChunk> { return this.values.values(); }
}
const asSource = (source: TextSourceSnapshot) => source as Source;
const sumBytes = (chunks: readonly Chunk[]) => chunks.reduce((sum, { bytes }) => sum + bytes, 0);
const omission = (reason: TextOmission["reason"], start: number, end: number, bytes: number, whole: boolean): TextOmission =>
  Object.freeze({ kind: "omitted", reason, start, end, bytes, whole });

/** A source for one whole string, cut to `limit` bytes: a quarter of the budget for the head, the rest for the tail. */
function fromText(
  value: string,
  limit: number,
  reason: TextOmission["reason"],
  meta: { version: number; protocolTruncated: boolean; pendingHigh: string; lineage: Lineage },
): Source {
  const bytes = utf8Length(value);
  const count = newlines(value);
  const endsNewline = value.endsWith("\n");
  if (bytes <= limit) {
    const values = chunksOf(value, 0, value.length, 0, 0);
    return new Source(meta.version, value.length, bytes, bytes, null, meta.protocolTruncated, values, values.length, count, endsNewline, meta.pendingHigh, meta.lineage);
  }
  const headEnd = Math.max(0, safeCut(value, prefixEnd(value, 0, value.length, Math.floor(limit / 4)), "left"));
  const head = chunksOf(value, 0, headEnd, 0, 0);
  const headBytes = sumBytes(head);
  const tailStart = Math.max(headEnd, safeCut(value, suffixStart(value, headEnd, value.length, slidBudget(limit - headBytes)), "right"));
  const values = chunksOf(value, tailStart, value.length, tailStart, newlines(value, 0, tailStart), [...head], tailGrain(limit - headBytes));
  const retained = sumBytes(values);
  const cut = omission(reason, headEnd, tailStart, bytes - retained, retained === 0);
  return new Source(meta.version, value.length, bytes, retained, cut, meta.protocolTruncated, values, head.length, count, endsNewline, meta.pendingHigh, lineage());
}

/**
 * The tail unchanged while it holds at most `budget` bytes; over it, the tail after dropping whole leading chunks until
 * it holds at most slidBudget(budget), its new first chunk moved to a safe start. Chunk edges respect pairs and CRLF only within one delta and may sit inside an escape sequence, so the
 * first kept chunk is checked against the dropped text before it. Whole-chunk steps keep a streamed append's cost
 * independent of how much output came before.
 */
function slideTail(tail: readonly Chunk[], budget: number): Chunk[] {
  let bytes = sumBytes(tail);
  if (bytes <= budget) return tail.slice();
  const target = slidBudget(budget);
  let index = 0;
  while (index < tail.length && bytes > target) bytes -= tail[index++]!.bytes;
  for (; index < tail.length; index++) {
    let context = "";
    for (let back = index - 1; back >= 0 && context.length < ANSI_LOOKBACK; back--) context = tail[back]!.text + context;
    context = context.slice(-ANSI_LOOKBACK);
    const first = tail[index]!;
    const at = safeCut(context + first.text, context.length, "right") - context.length;
    if (at === 0) return tail.slice(index);
    if (at < first.text.length) {
      const value = owned(first.text, at, first.text.length);
      return [chunk(first.start + at, first.line + newlines(first.text, 0, at), value, utf8Length(value)), ...tail.slice(index + 1)];
    }
  }
  return [];
}

/** The chunks from text offset `at` on; a chunk that `at` falls inside keeps its own copy of the part after `at`. */
function chunksFrom(chunks: readonly Chunk[], at: number): Chunk[] {
  let index = 0;
  while (index < chunks.length && chunks[index]!.start + chunks[index]!.text.length <= at) index++;
  const first = chunks[index];
  if (!first || first.start >= at) return chunks.slice(index);
  const offset = at - first.start;
  const value = owned(first.text, offset, first.text.length);
  return [chunk(at, first.line + newlines(first.text, 0, offset), value, utf8Length(value)), ...chunks.slice(index + 1)];
}

/** Chunks from the front worth at most `budget` bytes, cutting the last kept one at a safe place. */
function keepHead(chunks: readonly Chunk[], budget: number): Chunk[] {
  let index = 0;
  let used = 0;
  while (index < chunks.length && used + chunks[index]!.bytes <= budget) used += chunks[index++]!.bytes;
  const kept = chunks.slice(0, index);
  const cutChunk = chunks[index];
  if (!cutChunk) return kept;
  const context = index > 0 ? chunks[index - 1]!.text.slice(-ANSI_LOOKBACK) : "";
  const text = context + cutChunk.text;
  const at = safeCut(text, context.length + prefixEnd(cutChunk.text, 0, cutChunk.text.length, budget - used), "left") - context.length;
  if (at <= 0) {
    // The edge itself is inside a sequence that started in the kept text: drop back to the sequence start.
    if (index === 0 || at === 0) return kept;
    const last = kept[index - 1]!;
    const back = last.text.length + at;
    const value = owned(last.text, 0, Math.max(0, back));
    return value ? [...kept.slice(0, -1), chunk(last.start, last.line, value, utf8Length(value))] : kept.slice(0, -1);
  }
  const value = owned(cutChunk.text, 0, at);
  return [...kept, chunk(cutChunk.start, cutChunk.line, value, utf8Length(value))];
}

const streamingDelta = (text: string, pendingHigh: string, final: boolean) => {
  let input = pendingHigh + text;
  let pending = "";
  if (!final && isHigh(input.charCodeAt(input.length - 1))) pending = input.slice(-1), input = input.slice(0, -1);
  return { text: canonical(input), pending };
};

export function createTextSource(text: string, limit = DEFAULT_TOOL_OUTPUT_ITEM_BYTES): TextSourceSnapshot {
  return fromText(canonical(text), limit, "item-cap", { version: 1, protocolTruncated: false, pendingHigh: "", lineage: lineage() });
}
/** The first output of a streamed generation: a trailing high surrogate waits for the next delta. */
export function createStreamingTextSource(text: string, limit = DEFAULT_TOOL_OUTPUT_ITEM_BYTES): TextSourceSnapshot {
  const step = streamingDelta(text, "", false);
  return fromText(step.text, limit, "item-cap", { version: 1, protocolTruncated: false, pendingHigh: step.pending, lineage: lineage() });
}
export const emptyTextSource = () => createTextSource("");

/** Appends a streamed delta. Over `limit`, the head stays and the tail slides to the newest bytes. */
export function appendTextSource(source: TextSourceSnapshot, delta: string, limit = DEFAULT_TOOL_OUTPUT_ITEM_BYTES, final = false): TextSourceSnapshot {
  const prior = asSource(source);
  const step = streamingDelta(delta, prior.pendingHigh, final);
  const added = step.text;
  if (!added && step.pending === prior.pendingHigh) return source;
  const addedBytes = utf8Length(added);
  const length = prior.length + added.length;
  const bytes = prior.bytes + addedBytes;
  const count = prior.newlineCount + newlines(added);
  const endsNewline = added ? added.endsWith("\n") : prior.endsNewline;
  if (!prior.omission && bytes <= limit) {
    const values = appendChunks(prior.values.slice(), added, prior.length, prior.newlineCount, CHUNK_BYTES);
    return new Source(prior.version + 1, length, bytes, bytes, null, prior.protocolTruncated, values, values.length, count, endsNewline, step.pending, prior.lineage);
  }
  let head: Chunk[];
  let tail: Chunk[];
  if (!prior.omission) {
    // The first cut, over the chunks already held (never one joined string): a quarter for the head, the rest the tail.
    const values = appendChunks(prior.values.slice(), added, prior.length, prior.newlineCount, CHUNK_BYTES);
    head = keepHead(values, Math.floor(limit / 4));
    const end = head.length ? head.at(-1)!.start + head.at(-1)!.text.length : 0;
    tail = regrain(chunksFrom(values, end), tailGrain(limit - sumBytes(head)));
  } else {
    head = prior.values.slice(0, prior.headCount);
    tail = appendChunks(prior.values.slice(prior.headCount), added, prior.length, prior.newlineCount, tailGrain(limit - sumBytes(head)));
  }
  const headBytes = sumBytes(head);
  tail = slideTail(tail, Math.max(0, limit - headBytes));
  const retained = headBytes + sumBytes(tail);
  const start = prior.omission ? prior.omission.start : head.length ? head.at(-1)!.start + head.at(-1)!.text.length : 0;
  const cut = omission(prior.omission?.reason ?? "item-cap", start, tail[0]?.start ?? length, bytes - retained, retained === 0);
  // While the tail only grew (no chunk slid out), the kept text is the prior kept text plus the delta: same lineage.
  const grew = prior.omission !== null && cut.end === prior.omission.end;
  return new Source(prior.version + 1, length, bytes, retained, cut, prior.protocolTruncated, [...head, ...tail], head.length, count, endsNewline, step.pending, grew ? prior.lineage : lineage());
}

/** Ends a stream: a held high surrogate that never met its low half becomes U+FFFD. */
export function finalizeTextSource(source: TextSourceSnapshot, limit = DEFAULT_TOOL_OUTPUT_ITEM_BYTES): TextSourceSnapshot {
  return asSource(source).pendingHigh ? appendTextSource(source, "", limit, true) : source;
}

const derive = (source: Source, changes: Partial<Pick<Source, "retainedBytes" | "omission" | "protocolTruncated" | "values" | "headCount" | "lineage">>) => new Source(
  source.version + 1, source.length, source.bytes, changes.retainedBytes ?? source.retainedBytes, changes.omission === undefined ? source.omission : changes.omission,
  changes.protocolTruncated ?? source.protocolTruncated, changes.values ?? source.values, changes.headCount ?? source.headCount,
  source.newlineCount, source.endsNewline, source.pendingHigh, changes.lineage ?? source.lineage,
);

export function markProtocolTruncated(source: TextSourceSnapshot): TextSourceSnapshot {
  return source.protocolTruncated ? source : derive(asSource(source), { protocolTruncated: true, lineage: lineage() });
}

/** Drops every retained byte, keeping the logical totals so the row can say what was not kept. */
export function omitTextSource(source: TextSourceSnapshot, reason: TextOmission["reason"]): TextSourceSnapshot {
  if (source.retainedBytes === 0 && (source.omission || source.length === 0)) return source;
  return derive(asSource(source), { retainedBytes: 0, omission: omission(reason, 0, source.length, source.bytes, true), values: [], headCount: 0, lineage: lineage() });
}

/** The same source retaining at most `limit` bytes: a quarter for the head, the rest for the tail. */
export function limitTextSource(source: TextSourceSnapshot, limit: number, reason: TextOmission["reason"]): TextSourceSnapshot {
  const prior = asSource(source);
  if (prior.retainedBytes <= limit) return source;
  if (!prior.omission) return fromText(retainedText(prior), limit, reason, { version: prior.version + 1, protocolTruncated: prior.protocolTruncated, pendingHigh: prior.pendingHigh, lineage: undefined });
  const head = keepHead(prior.values.slice(0, prior.headCount), Math.floor(limit / 4));
  const headBytes = sumBytes(head);
  // Only the old tail: old head text past the new head joins the omission, so the source keeps one cut.
  const tail = slideTail(regrain(prior.values.slice(prior.headCount), tailGrain(limit - headBytes)), limit - headBytes);
  const retained = headBytes + sumBytes(tail);
  const start = head.length ? head.at(-1)!.start + head.at(-1)!.text.length : 0;
  const cut = omission(reason, start, tail[0]?.start ?? prior.length, prior.bytes - retained, retained === 0);
  return derive(prior, { retainedBytes: retained, omission: cut, values: [...head, ...tail], headCount: head.length, lineage: lineage() });
}

/** The retained text joined (an omission's two sides meet with nothing between them). */
export function retainedText(source: TextSourceSnapshot): string {
  let text = "";
  for (const { text: value } of source.chunks()) text += value;
  return text;
}

/**
 * The text `next` added after `previous` when `next` only appended to its kept text (the same cut, if any), else
 * undefined. Reads only the added chunks, so a streaming viewer continues from the tail instead of reading it all again.
 */
export function sourceTail(previous: TextSourceSnapshot | undefined, next: TextSourceSnapshot): string | undefined {
  if (!previous || previous.protocolTruncated !== next.protocolTruncated) return undefined;
  if (previous.omission?.start !== next.omission?.start || previous.omission?.end !== next.omission?.end) return undefined;
  const before = asSource(previous);
  const after = asSource(next);
  if (before === after) return "";
  if (!before.lineage || before.lineage !== after.lineage || after.length < before.length) return undefined;
  // A cut that kept no tail shows its notice last; the added text then starts a new line after it, so it is no append.
  if (before.omission && before.omission.end === before.length) return undefined;
  let tail = "";
  for (let index = after.values.length - 1; index >= 0; index--) {
    const { start, text } = after.values[index]!;
    if (start + text.length <= before.length) break;
    // A copy, not a slice: the reader keeps this tail inside its shown text, and a slice would keep this chunk version
    // alive with it (one chunk-sized string per append).
    tail = (start >= before.length ? text : owned(text, before.length - start, text.length)) + tail;
  }
  return tail;
}

export function storeToolView(view: ToolView, limit?: number): StoredToolView;
export function storeToolView(view: ToolView | undefined, limit?: number): StoredToolView | undefined;
export function storeToolView(view: ToolView | undefined, limit = DEFAULT_TOOL_OUTPUT_ITEM_BYTES): StoredToolView | undefined {
  if (!view) return undefined;
  const text = (value: string) => createTextSource(value, limit);
  switch (view.kind) {
    case "shell": {
      const { stdout, stderr, ...rest } = view;
      return { ...rest, ...(stdout === undefined ? {} : { stdout: text(stdout) }), ...(stderr === undefined ? {} : { stderr: text(stderr) }) };
    }
    case "edit": return { ...view, diff: text(view.diff) };
    case "write": {
      const { content, ...rest } = view;
      return { ...rest, ...(content === undefined ? {} : { content: text(content) }) };
    }
    case "search": {
      const { matches, ...rest } = view;
      return { ...rest, ...(matches === undefined ? {} : { matches: matches.map(text) }) };
    }
    default: return view;
  }
}
const storeBlock = (block: ContentBlock, limit: number): StoredResultBlock => {
  const { text, ...metadata } = block as ContentBlock & { text?: unknown };
  return Object.freeze(typeof text === "string" ? { metadata, text: createTextSource(text, limit) } : { metadata: block });
};
export function storeToolResult(result: ToolResult, relation: StoredToolResult["relation"], finalContent: TextSourceSnapshot | undefined, limit = DEFAULT_TOOL_OUTPUT_ITEM_BYTES): StoredToolResult {
  return Object.freeze({
    tool_call_id: result.tool_call_id,
    is_error: result.is_error,
    ...(result.is_canceled === undefined ? {} : { is_canceled: result.is_canceled }),
    ...(result.blocks === undefined ? {} : { blocks: result.blocks.map((block) => storeBlock(block, limit)) }),
    ...(result.truncated === undefined ? {} : { truncated: result.truncated }),
    relation,
    ...(finalContent ? { finalContent } : {}),
  });
}
