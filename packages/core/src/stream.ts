/** The newest full text read on one stream. One per chain, so held older versions never each pin a full copy. */
type Cache = { chunk?: Chunk; text: string };

type Chunk = {
  readonly previous?: Chunk;
  readonly value: string;
  readonly length: number;
  readonly cache: Cache;
};

const chunks = new WeakMap<object, Chunk>();

const chunkFor = (item: object, value: () => string): Chunk | undefined => {
  const chunk = chunks.get(item);
  if (chunk) return chunk;
  const materialized = value();
  if (!materialized) return undefined;
  const first: Chunk = { value: materialized, length: materialized.length, cache: { chunk: undefined, text: "" } };
  chunks.set(item, first); // so streamTail can continue from a row whose text was a plain string
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
  field: "text" | "output",
  prior: () => string,
  delta: string,
): T {
  const base = previous ? chunkFor(previous, prior) : undefined;
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
  chunks.set(item, chunk);
  return item;
}

/**
 * The text appended to `item`'s streamed field (a message's `text`, a tool's `output`) since `previous`, an earlier
 * snapshot of the same row: `item`'s text is exactly `previous`'s text followed by the result. Undefined when `item`
 * does not continue `previous`'s stream: a replace, a restarted tool, a resync or history reload, an older snapshot, a
 * row that never streamed. Costs the chunks appended since `previous`; it never reads or compares the whole text.
 */
export function streamTail(previous: object | undefined, item: object): string | undefined {
  const base = previous && chunks.get(previous);
  const chunk = chunks.get(item);
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
