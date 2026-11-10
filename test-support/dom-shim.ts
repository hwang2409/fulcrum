import { afterAll } from "bun:test";

type Restore = () => void;
type TrackedShim = { owner: string; name: PropertyKey };
type TargetSnapshot = {
  target: object;
  owner: string;
  prototype: object | null;
  descriptors: Map<PropertyKey, PropertyDescriptor>;
};

const alarms = new Map<string, { shims: Set<TrackedShim>; targets: TargetSnapshot[] }>();

const sameDescriptor = (left?: PropertyDescriptor, right?: PropertyDescriptor) =>
  left?.configurable === right?.configurable
  && left?.enumerable === right?.enumerable
  && left?.writable === right?.writable
  && Object.is(left?.value, right?.value)
  && left?.get === right?.get
  && left?.set === right?.set;

const objectValue = (value: unknown): object | undefined =>
  value !== null && (typeof value === "object" || typeof value === "function") ? value : undefined;

const snapshotTargets = (): TargetSnapshot[] => {
  const targets = new Map<object, string>();
  const add = (value: unknown, owner: string) => {
    const target = objectValue(value);
    if (target && !targets.has(target)) targets.set(target, owner);
  };

  add(globalThis, "globalThis");
  const windowValue = objectValue(Reflect.get(globalThis, "window"));
  if (windowValue && windowValue !== globalThis) add(windowValue, "window");
  const roots = [...targets];

  for (const [root, owner] of roots) {
    for (const name of ["document", "navigator", "performance", "location"] as const) add(Reflect.get(root, name), `${owner}.${name}`);
    for (const name of Reflect.ownKeys(root)) {
      const descriptor = Object.getOwnPropertyDescriptor(root, name);
      if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") continue;
      const prototype = Object.getOwnPropertyDescriptor(descriptor.value, "prototype");
      if (prototype && "value" in prototype) add(prototype.value, `${owner}.${String(name)}.prototype`);
    }
  }

  for (const [target, owner] of [...targets]) {
    let prototype = Object.getPrototypeOf(target) as object | null;
    let depth = 1;
    while (prototype) {
      add(prototype, `${owner}[[Prototype:${depth}]]`);
      prototype = Object.getPrototypeOf(prototype) as object | null;
      depth += 1;
    }
  }

  return [...targets].map(([target, owner]) => ({
    target,
    owner,
    prototype: Object.getPrototypeOf(target) as object | null,
    descriptors: new Map(Reflect.ownKeys(target).map((name) => [name, Object.getOwnPropertyDescriptor(target, name)!])),
  }));
};

const isExpectedLifecycleProperty = (snapshot: TargetSnapshot, name: PropertyKey) => {
  // node:perf_hooks installs these Bun-owned descriptors lazily; they are not test shims.
  if (snapshot.owner.endsWith(".Performance.prototype")
    && ["nodeTiming", "timerify", "eventLoopUtilization"].includes(String(name))) return true;
  if (!snapshot.owner.endsWith(".document")) return false;
  // happy-dom and React change these internal document-state slots during normal work; they are not shim surfaces.
  return typeof name === "symbol"
    ? ["readyState", "affectsCache", "affectsComputedStyleCache"].includes(name.description ?? "")
    : name.startsWith("_reactListening");
};

const changedProperty = (snapshot: TargetSnapshot): PropertyKey | "[[Prototype]]" | undefined => {
  if (Object.getPrototypeOf(snapshot.target) !== snapshot.prototype) return "[[Prototype]]";
  const current = new Map(Reflect.ownKeys(snapshot.target).map((name) => [name, Object.getOwnPropertyDescriptor(snapshot.target, name)!]));
  for (const [name, descriptor] of snapshot.descriptors) {
    if (!isExpectedLifecycleProperty(snapshot, name) && !sameDescriptor(descriptor, current.get(name))) return name;
  }
  for (const name of current.keys()) {
    if (!isExpectedLifecycleProperty(snapshot, name) && !snapshot.descriptors.has(name)) return name;
  }
};

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
  const alarm = { shims: new Set<TrackedShim>(), targets: snapshotTargets() };
  alarms.set(file, alarm);

  afterAll(() => {
    for (const shim of alarm.shims) throw new Error(`${file} leaked DOM shim ${shim.owner}.${String(shim.name)}`);
    for (const target of alarm.targets) {
      const name = changedProperty(target);
      if (name !== undefined) throw new Error(`${file} leaked DOM shim ${target.owner}.${String(name)}`);
    }
    alarms.delete(file);
  });
}

export function shimProperty(target: object, name: PropertyKey, descriptor?: PropertyDescriptor): Restore {
  const file = Bun.main;
  const alarm = alarms.get(file);
  if (!alarm) throw new Error(`${file} used shimProperty without domShimAlarm(import.meta.path)`);
  const previous = Object.getOwnPropertyDescriptor(target, name);
  const owner = ownerName(target);
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
