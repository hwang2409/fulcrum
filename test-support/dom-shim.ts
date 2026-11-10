type Restore = () => void;

export function shimProperty(target: object, name: PropertyKey, descriptor?: PropertyDescriptor): Restore {
  const previous = Object.getOwnPropertyDescriptor(target, name);
  if (descriptor) Object.defineProperty(target, name, descriptor);
  else Reflect.deleteProperty(target, name);

  let restored = false;
  return () => {
    if (restored) return;
    if (previous) Object.defineProperty(target, name, previous);
    else Reflect.deleteProperty(target, name);
    restored = true;
  };
}

export function shimGlobal<K extends keyof typeof globalThis>(name: K, value: (typeof globalThis)[K]): Restore;
export function shimGlobal(name: PropertyKey, value: unknown): Restore;
export function shimGlobal(name: PropertyKey, value: unknown): Restore {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  return shimProperty(globalThis, name, previous && "value" in previous
    ? { ...previous, value }
    : { configurable: true, enumerable: true, writable: true, value });
}
