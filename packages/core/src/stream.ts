type Chunk = {
  readonly previous?: Chunk;
  readonly value: string;
  readonly length: number;
};

const chunks = new WeakMap<object, Chunk>();
const text = new WeakMap<Chunk, string>();

const chunkFor = (item: object, value: () => string) => {
  const chunk = chunks.get(item);
  if (chunk) return chunk;
  const materialized = value();
  return materialized
    ? { value: materialized, length: materialized.length }
    : undefined;
};

function read(chunk: Chunk): string {
  const cached = text.get(chunk);
  if (cached !== undefined) return cached;

  const suffix: string[] = [];
  let cursor: Chunk | undefined = chunk;
  let prefix = "";
  while (cursor) {
    const value = text.get(cursor);
    if (value !== undefined) {
      prefix = value;
      break;
    }
    suffix.push(cursor.value);
    cursor = cursor.previous;
  }
  const value = prefix + suffix.reverse().join("");
  text.set(chunk, value);
  return value;
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
  };
  Object.defineProperty(item, field, {
    enumerable: true,
    get: () => read(chunk),
  });
  chunks.set(item, chunk);
  return item;
}
