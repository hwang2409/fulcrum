import type { TextSourceSnapshot } from "./events.js";
import { fold } from "./fold.js";

export interface TextMatch {
  /** Inclusive UTF-16 offset into the logical source (omitted text counts, so offsets match the original output). */
  readonly start: number;
  /** Exclusive UTF-16 offset into the logical source. */
  readonly end: number;
  /** Zero-based logical line of `start`. */
  readonly line: number;
}
export interface TextFindUpdate {
  /** Matches found since the previous update, in source order; at most 256. */
  readonly matches: readonly TextMatch[];
  /** Retained UTF-16 units examined so far. */
  readonly scanned: number;
  readonly done: boolean;
  /** On the final update: every unit of the logical source was searched and no match was left out. */
  readonly complete: boolean;
  /** On the final update: the limit stopped the scan while more matches remained. */
  readonly capped: boolean;
}
export interface TextFindOptions {
  readonly caseSensitive?: boolean;
  /** The most matches reported; default 10,000. */
  readonly limit?: number;
  readonly signal?: AbortSignal;
}
/** What findText reads: retained chunks in order (a gap between two is not kept) and whether text is missing. */
export type TextFindSource = Pick<TextSourceSnapshot, "chunks" | "omission" | "protocolTruncated">;

const MAX_QUERY_BYTES = 64 * 1024;
const BATCH_MATCHES = 256;
const BATCH_UNITS = 256 * 1024;
const SLICE_MS = 8;
// Units folded and searched between checks of the clock and the signal: a non-ASCII piece folds one character at a
// time, and at this size one piece stays well under a slice on a 4x-throttled page.
const PIECE_UNITS = 8_192;
const encoder = new TextEncoder();

const abortError = () => new DOMException("the find was aborted", "AbortError");
/** A new task, so the page can paint and handle input between work slices (a microtask would not let it). */
const nextTask = () => new Promise<void>((resolve) => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    resolve();
  };
  channel.port2.postMessage(null);
});
const newlines = (text: string, from: number, to: number) => {
  let count = 0;
  for (let at = text.indexOf("\n", from); at >= 0 && at < to; at = text.indexOf("\n", at + 1)) count++;
  return count;
};
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const NON_ASCII = /[^\x00-\x7f]/;

/**
 * Finds `query` in a source's retained text, a slice of work at a time. Each update holds only the matches found since
 * the previous one; the last has `done`, and says whether the whole logical source was searched (`complete`) or the
 * limit stopped it (`capped`). A match never spans text that was not kept. Without `caseSensitive`, text and query
 * fold per character, and a match maps back to whole original characters. Aborting `signal` ends the iteration with an
 * AbortError, before any further update.
 */
export function findText(source: TextFindSource, query: string, options: TextFindOptions = {}): AsyncIterable<TextFindUpdate> {
  if (query.length > MAX_QUERY_BYTES || encoder.encode(query).length > MAX_QUERY_BYTES) throw new RangeError("a find query is at most 64 KiB");
  const limit = options.limit ?? 10_000;
  if (!Number.isInteger(limit) || limit <= 0) throw new RangeError("limit must be a positive integer");
  return scan(source, query, options.caseSensitive === true, limit, options.signal);
}

async function* scan(source: TextFindSource, query: string, caseSensitive: boolean, limit: number, signal: AbortSignal | undefined): AsyncGenerator<TextFindUpdate> {
  if (signal?.aborted) throw abortError();
  const missing = source.omission !== null || source.protocolTruncated;
  const needle = caseSensitive ? query : fold(query).folded;
  let pending: TextMatch[] = [];
  let found = 0;
  let capped = false;
  let scanned = 0;
  let sliceUnits = 0;
  let sliceStart = performance.now();
  const update = (done: boolean): TextFindUpdate => {
    const value = { matches: pending, scanned, done, complete: done && !capped && !missing, capped: done && capped };
    pending = [];
    return value;
  };
  // The end of a slice: hand over what was found, give the page a task, and stop if the find was aborted meanwhile.
  async function* yieldSlice() {
    if (signal?.aborted) throw abortError();
    yield update(false);
    await nextTask();
    if (signal?.aborted) throw abortError();
    sliceUnits = 0;
    sliceStart = performance.now();
  }
  if (needle) {
    // A match may start in the previous piece of the same run of kept text: its last units (`carry`, whole characters
    // from no earlier than the last match's end) are searched again ahead of the next piece. A gap clears it.
    let carry = "";
    let carryStart = 0;
    let carryLine = 0;
    let runEnd = -1;
    const piece = Math.max(PIECE_UNITS, needle.length);
    scan: for (const chunk of source.chunks()) {
      if (chunk.start !== runEnd || !carry) {
        carry = "";
        carryStart = chunk.start;
        carryLine = chunk.line;
      }
      runEnd = chunk.start + chunk.text.length;
      for (let at = 0; at < chunk.text.length;) {
        let end = Math.min(chunk.text.length, at + piece);
        if (end < chunk.text.length && isHigh(chunk.text.charCodeAt(end - 1))) end++;
        const added = chunk.text.slice(at, end);
        const text = carry + added;
        const origin = carryStart;
        const folded = caseSensitive || !NON_ASCII.test(text) ? null : fold(text);
        const hay = folded ? folded.folded : caseSensitive ? text : text.toLowerCase();
        let line = carryLine;
        let lineAt = 0;
        let next = 0; // where the next match may start, in `hay`
        let floor = 0; // the end of the last match, in `text`
        for (let index = hay.indexOf(needle); index >= 0; index = hay.indexOf(needle, next)) {
          if (found === limit) {
            capped = true;
            break scan;
          }
          const start = folded ? folded.starts[index]! : index;
          const stop = folded ? folded.ends[index + needle.length - 1]! : index + needle.length;
          line += newlines(text, lineAt, start);
          lineAt = start;
          pending.push({ start: origin + start, end: origin + stop, line });
          found++;
          floor = stop;
          next = index + needle.length;
          if (pending.length === BATCH_MATCHES) yield* yieldSlice();
        }
        // The next carry: the last needle.length - 1 folded units, widened to whole characters, never before `floor`.
        const tail = hay.length - needle.length + 1;
        const from = Math.max(floor, tail >= hay.length ? text.length : tail <= 0 ? 0 : folded ? folded.starts[tail]! : tail);
        carry = text.slice(from);
        carryStart = origin + from;
        carryLine = line + newlines(text, lineAt, from);
        scanned += added.length;
        sliceUnits += added.length;
        at = end;
        if (signal?.aborted) throw abortError();
        if (sliceUnits >= BATCH_UNITS || performance.now() - sliceStart >= SLICE_MS) yield* yieldSlice();
      }
    }
  }
  if (signal?.aborted) throw abortError();
  yield update(true);
}
