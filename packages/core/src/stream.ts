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
  return materialized
    ? { value: materialized, length: materialized.length, cache: { chunk: undefined, text: "" } }
    : undefined;
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
