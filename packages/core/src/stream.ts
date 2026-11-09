import type { RunItem } from "./events.js";

/**
 * The newest full text read on one stream, and its chain's compaction state: `boundary` is the last compacted chunk,
 * `run` the chunks and characters read since it. One per chain, so held older versions never each pin a full copy.
 */
type Cache = { chunk?: Chunk; text: string; boundary?: Chunk; runChunks: number; runChars: number };

// `previous` and `value` change only when a read compacts the chunk into a run (see read); its text stays the same.
type Chunk = {
  previous?: Chunk;
  value: string;
  readonly length: number;
  readonly cache: Cache;
};

// Past this many chunks, or this much text, read since the last compaction, the next read compacts them into one.
const RUN_CHUNKS = 32;
const RUN_CHARS = 4_096;

const emptyCache = (): Cache => ({ chunk: undefined, text: "", boundary: undefined, runChunks: 0, runChars: 0 });

type MessageItem = Extract<RunItem, { type: "message" }>;
type ToolItem = Extract<RunItem, { type: "tool" }>;
/** The streamed fields: a message's `text`, a tool's `output`. A new stream (on any row) adds a member and a chain map. */
type Field = "text" | "output";

// One chain per (row, field), so a row with two streams keeps them apart.
const chunks: Record<Field, WeakMap<object, Chunk>> = { text: new WeakMap(), output: new WeakMap() };

const chunkFor = (item: object, field: Field, value: () => string): Chunk | undefined => {
  const chunk = chunks[field].get(item);
  if (chunk) return chunk;
  const materialized = value();
  if (!materialized) return undefined;
  const first: Chunk = { value: materialized, length: materialized.length, cache: emptyCache() };
  chunks[field].set(item, first); // so streamTail can continue from a row whose text was a plain string
  return first;
};

/**
 * A frame read joins only the chunks after the stream's last read, so reading every frame costs the new text, not the
 * whole chain. The text is the previous read's string plus the new text (engines extend that string cheaply, even
 * after a consumer flattened it). The cache moves to the longest version read; reading an older version joins its
 * chain and leaves it.
 *
 * Compaction: once the chunks read since the last compaction pass a run, the previous read's chunk takes the run joined
 * as its value and links straight to the last compacted chunk. Its text is unchanged, snapshots held from inside the
 * run keep their own chains, and the chunks in between are free otherwise. So a long stream keeps about one chunk per
 * run, not one per append. The previous read's chunk, never the newest: a renderer takes its next tail from it.
 */
function read(chunk: Chunk): string {
  const { cache } = chunk;
  if (cache.chunk === chunk) return cache.text;
  const values: string[] = [];
  let chars = 0;
  let cursor: Chunk | undefined = chunk;
  while (cursor && cursor !== cache.chunk) {
    values.push(cursor.value);
    chars += cursor.value.length;
    cursor = cursor.previous;
  }
  const text = (cursor ? cache.text : "") + values.reverse().join("");
  if (chunk.length < (cache.chunk?.length ?? 0)) return text;
  const previous = cursor; // the previous read's chunk when this read extends it, otherwise undefined
  cache.chunk = chunk;
  cache.text = text;
  if (!previous) {
    // A first read, or another branch: this chunk starts the compaction run.
    cache.boundary = undefined;
    cache.runChunks = 0;
    cache.runChars = 0;
    return text;
  }
  if (cache.runChunks > RUN_CHUNKS || cache.runChars > RUN_CHARS) {
    const run: string[] = [];
    for (let at: Chunk | undefined = previous; at && at !== cache.boundary; at = at.previous) run.push(at.value);
    previous.value = run.reverse().join("");
    previous.previous = cache.boundary;
    cache.boundary = previous;
    cache.runChunks = 0;
    cache.runChars = 0;
  }
  cache.runChunks += values.length;
  cache.runChars += chars;
  return text;
}

export function appendText<T extends object>(
  item: T,
  previous: object | undefined,
  field: Field,
  prior: () => string,
  delta: string,
): T {
  const base = previous ? chunkFor(previous, field, prior) : undefined;
  const chunk: Chunk = {
    previous: base,
    value: delta,
    length: (base?.length ?? 0) + delta.length,
    cache: base?.cache ?? emptyCache(),
  };
  Object.defineProperty(item, field, {
    enumerable: true,
    get: () => read(chunk),
  });
  chunks[field].set(item, chunk);
  return item;
}

/**
 * The text appended to a row's streamed `field` since `previous`, an earlier snapshot of the same row: `item`'s field
 * is exactly `previous`'s followed by the result. The streamed fields are a message's `text` (`message_delta` of kind
 * text or assistant) and a tool's `output` (`tool_output`; `tool_end` keeps it). A message's reasoning and other
 * content blocks are not addressable: each delta copies the block into a new `message.content`, so there is no chain to
 * take a tail from; making one a stream adds a field here. Undefined when `item` does not continue `previous`'s
 * stream: a replace, a restarted tool, a resync or history reload, an older snapshot, a row that never streamed, or a
 * `previous` from before the field's previous read (a long stream compacts runs behind it; read the field of each
 * snapshot you keep as a base, as a render does). Costs the chunks appended since `previous`; it never reads or
 * compares the whole text.
 */
export function streamTail(previous: MessageItem | undefined, item: MessageItem, field: "text"): string | undefined;
export function streamTail(previous: ToolItem | undefined, item: ToolItem, field: "output"): string | undefined;
export function streamTail(previous: RunItem | undefined, item: RunItem, field: Field): string | undefined {
  const base = previous && chunks[field].get(previous);
  const chunk = chunks[field].get(item);
  // A different cache is a different stream: only appendText from a prior row shares its cache.
  if (!base || !chunk || chunk.cache !== base.cache) return undefined;
  const values: string[] = [];
  let cursor: Chunk | undefined = chunk;
  while (cursor && cursor !== base && cursor.length >= base.length) {
    values.push(cursor.value);
    cursor = cursor.previous;
  }
  return cursor === base ? values.reverse().join("") : undefined;
}
