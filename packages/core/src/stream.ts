type Chunk = {
  readonly previous?: Chunk;
  readonly value: string;
  readonly length: number;
};

const chunks = new WeakMap<object, Chunk>();

const chunkFor = (item: object, value: () => string) => {
  const chunk = chunks.get(item);
  if (chunk) return chunk;
  const materialized = value();
  return materialized
    ? { value: materialized, length: materialized.length }
    : undefined;
};

function read(chunk: Chunk): string {
  const values: string[] = [];
  let cursor: Chunk | undefined = chunk;
  while (cursor) {
    values.push(cursor.value);
    cursor = cursor.previous;
  }
  return values.reverse().join("");
}

export const hasTextStream = (item: object) => chunks.has(item);

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
  let materialized: string | undefined;
  Object.defineProperty(item, field, {
    enumerable: true,
    get() {
      materialized ??= read(chunk);
      return materialized;
    },
  });
  chunks.set(item, chunk);
  return item;
}
