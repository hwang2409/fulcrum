import type { RunItem } from "./events.js";

/** The newest full text read on one stream. One per chain, so held older versions never each pin a full copy. */
type Cache = { chunk?: Chunk; text: string };

type Chunk = {
  readonly previous?: Chunk;
  readonly value: string;
  readonly length: number;
  readonly cache: Cache;
};

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
  const first: Chunk = { value: materialized, length: materialized.length, cache: { chunk: undefined, text: "" } };
  chunks[field].set(item, first); // so streamTail can continue from a row whose text was a plain string
  return first;
};

/**
 * A frame read joins only the chunks after the stream's last read, so reading every frame costs the new text, not the
 * whole chain. The cache moves to the longest version read; reading an older version joins its chain and leaves it.
 */
function read(chunk: Chunk): string {
  const { cache } = chunk;
  if (cache.chunk === chunk) return cache.text;
  const values: string[] = [];
  let cursor: Chunk | undefined = chunk;
  while (cursor && cursor !== cache.chunk) {
    values.push(cursor.value);
    cursor = cursor.previous;
  }
  const text = (cursor ? cache.text : "") + values.reverse().join("");
  if (chunk.length >= (cache.chunk?.length ?? 0)) {
    cache.chunk = chunk;
    cache.text = text;
  }
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
    cache: base?.cache ?? { chunk: undefined, text: "" },
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
 * stream: a replace, a restarted tool, a resync or history reload, an older snapshot, a row that never streamed.
 * Costs the chunks appended since `previous`; it never reads or compares the whole text.
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
