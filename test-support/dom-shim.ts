import { afterAll } from "bun:test";

type Restore = () => void;
type TrackedShim = { owner: string; name: PropertyKey };
type Snapshot = { target: object; owner: string; name: PropertyKey; descriptor?: PropertyDescriptor };

const alarms = new Map<string, { shims: Set<TrackedShim>; snapshot: Snapshot[] }>();

const sameDescriptor = (left?: PropertyDescriptor, right?: PropertyDescriptor) =>
  left?.configurable === right?.configurable
  && left?.enumerable === right?.enumerable
  && left?.writable === right?.writable
  && left?.value === right?.value
  && left?.get === right?.get
  && left?.set === right?.set;

const ownerName = (target: object) => {
  if (target === globalThis) return "globalThis";
  if (typeof HTMLElement !== "undefined" && target === HTMLElement.prototype) return "HTMLElement.prototype";
  if (typeof Element !== "undefined" && target === Element.prototype) return "Element.prototype";
  if (typeof Node !== "undefined" && target === Node.prototype) return "Node.prototype";
  if (typeof Navigator !== "undefined" && target === Navigator.prototype) return "Navigator.prototype";
  if (typeof Window !== "undefined" && target === Window.prototype) return "Window.prototype";
  if (typeof document !== "undefined" && target === document) return "document";
  if (typeof navigator !== "undefined" && target === navigator) return "navigator";
  if (typeof performance !== "undefined" && target === performance) return "performance";
  return target.constructor?.name ?? "object";
};

export function domShimAlarm(file: string): void {
  if (alarms.has(file)) throw new Error(`${file} registered the DOM shim alarm twice`);
  const alarm = { shims: new Set<TrackedShim>(), snapshot: [] as Snapshot[] };
  alarms.set(file, alarm);

  const check = () => {
    for (const shim of alarm.shims) throw new Error(`${file} leaked DOM shim ${shim.owner}.${String(shim.name)}`);
    for (const entry of alarm.snapshot) {
      if (!sameDescriptor(entry.descriptor, Object.getOwnPropertyDescriptor(entry.target, entry.name))) {
        throw new Error(`${file} leaked DOM shim ${entry.owner}.${String(entry.name)}`);
      }
    }
    alarms.delete(file);
  };
  afterAll(check);
}

export function shimProperty(target: object, name: PropertyKey, descriptor?: PropertyDescriptor): Restore {
  const file = Bun.main;
  const alarm = alarms.get(file);
  if (!alarm) throw new Error(`${file} used shimProperty without domShimAlarm(import.meta.path)`);
  const previous = Object.getOwnPropertyDescriptor(target, name);
  const owner = ownerName(target);
  if (!alarm.snapshot.some((entry) => entry.target === target && entry.name === name)) {
    alarm.snapshot.push({ target, owner, name, descriptor: previous });
  }
  const shim: TrackedShim = { owner, name };
  alarm.shims.add(shim);
  if (descriptor) Object.defineProperty(target, name, descriptor);
  else Reflect.deleteProperty(target, name);
  let restored = false;
  return () => {
    if (restored) return;
    if (previous) Object.defineProperty(target, name, previous);
    else Reflect.deleteProperty(target, name);
    restored = true;
    alarm.shims.delete(shim);
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
