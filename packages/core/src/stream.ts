interface StreamView {
  buffer: string[];
  end: number;
}

const streams = new WeakMap<object, StreamView>();

const publish = <T extends object, K extends string>(
  entity: T,
  key: K,
  view: StreamView,
): T & Record<K, string[]> => {
  streams.set(entity, view);
  Object.defineProperty(entity, key, {
    enumerable: true,
    get: () => view.buffer.slice(0, view.end),
  });
  return entity as T & Record<K, string[]>;
};

export const appendStream = <T extends object, K extends string>(
  entity: T,
  key: K,
  previous: object | undefined,
  chunk: string,
): T & Record<K, string[]> => {
  const prior = previous ? streams.get(previous) : undefined;
  const buffer = prior?.buffer ?? [];
  buffer.push(chunk);
  return publish(entity, key, { buffer, end: (prior?.end ?? 0) + 1 });
};

export const shareStream = <T extends object, K extends string>(
  entity: T,
  key: K,
  source: object,
): T & Record<K, string[]> => {
  const view = streams.get(source);
  if (!view) throw new Error("stream source is not published");
  return publish(entity, key, view);
};
