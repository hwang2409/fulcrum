// Host callbacks must not break delivery to other listeners or the transport loop.
const sink = (error: unknown) => {
  try {
    if (typeof reportError === "function") reportError(error);
    else console.error(error);
  } catch {}
};

export const call = <T>(run: () => T extends PromiseLike<unknown> ? never : T) => {
  try {
    run();
  } catch (error) {
    sink(error);
  }
};

export const deliver = <T>(listeners: ReadonlySet<(value: T) => void>, value: T) => {
  for (const listener of listeners) call(() => listener(value));
};
