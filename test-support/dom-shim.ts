import { afterAll } from "bun:test";
import { performance as nodePerformance } from "node:perf_hooks";

// Bun installs these members lazily. Initialize them before any alarm takes its snapshot.
void nodePerformance.nodeTiming;
void nodePerformance.timerify;
void nodePerformance.eventLoopUtilization;

type Restore = () => void;
type TrackedShim = { owner: string; name: PropertyKey };
type DescriptorEntry = readonly [PropertyKey, PropertyDescriptor];
type TargetSnapshot = {
  target: object;
  owner: string;
  prototype: object | null;
  descriptors: DescriptorEntry[];
};
type Alarm = { file: string; shims: TrackedShim[]; targets: TargetSnapshot[] };

// The alarm watches these prototypes, so its own operations cannot depend on them after tests start.
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const defineProperty = Object.defineProperty;
const getPrototypeOf = Object.getPrototypeOf;
const objectIs = Object.is;
const isArray = Array.isArray;
const ownKeys = Reflect.ownKeys;
const reflectGet = Reflect.get;
const deleteProperty = Reflect.deleteProperty;
const stringEndsWith = Function.call.bind(String.prototype.endsWith) as (value: string, suffix: string) => boolean;
const stringStartsWith = Function.call.bind(String.prototype.startsWith) as (value: string, prefix: string) => boolean;
const symbolDescription = Function.call.bind(getOwnPropertyDescriptor(Symbol.prototype, "description")!.get!) as (value: symbol) => string | undefined;
const propertyName = String;
const AlarmError = Error;
const objectPrototype = Object.prototype;
const weakRefPrototype = WeakRef.prototype;

const alarms: Alarm[] = [];

const findAlarm = (file: string): Alarm | undefined => {
  for (let index = 0; index < alarms.length; index += 1) {
    if (alarms[index]!.file === file) return alarms[index];
  }
};

const sameDescriptor = (left?: PropertyDescriptor, right?: PropertyDescriptor) =>
  left?.configurable === right?.configurable
  && left?.enumerable === right?.enumerable
  && left?.writable === right?.writable
  && objectIs(left?.value, right?.value)
  && left?.get === right?.get
  && left?.set === right?.set;

const objectValue = (value: unknown): object | undefined =>
  value !== null && (typeof value === "object" || typeof value === "function") ? value : undefined;

const snapshotDescriptors = (target: object): DescriptorEntry[] => {
  const names = ownKeys(target);
  const descriptors: DescriptorEntry[] = [];
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]!;
    descriptors[index] = [name, getOwnPropertyDescriptor(target, name)!];
  }
  return descriptors;
};

const findDescriptor = (descriptors: DescriptorEntry[], name: PropertyKey): PropertyDescriptor | undefined => {
  for (let index = 0; index < descriptors.length; index += 1) {
    if (descriptors[index]![0] === name) return descriptors[index]![1];
  }
};

const snapshotTargets = (): TargetSnapshot[] => {
  const targets: Array<readonly [object, string]> = [];
  const add = (value: unknown, owner: string) => {
    const target = objectValue(value);
    if (!target) return;
    for (let index = 0; index < targets.length; index += 1) {
      if (targets[index]![0] === target) return;
    }
    targets[targets.length] = [target, owner];
  };

  add(globalThis, "globalThis");
  const windowValue = objectValue(reflectGet(globalThis, "window"));
  if (windowValue && windowValue !== globalThis) add(windowValue, "window");
  const rootCount = targets.length;

  for (let rootIndex = 0; rootIndex < rootCount; rootIndex += 1) {
    const [root, owner] = targets[rootIndex]!;
    const rootNames = ["document", "navigator", "performance", "location"] as const;
    for (let index = 0; index < rootNames.length; index += 1) {
      const name = rootNames[index]!;
      add(reflectGet(root, name), `${owner}.${name}`);
    }
    const names = ownKeys(root);
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index]!;
      const descriptor = getOwnPropertyDescriptor(root, name);
      if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") continue;
      const prototype = getOwnPropertyDescriptor(descriptor.value, "prototype");
      if (prototype && "value" in prototype) {
        const prefix = owner === "globalThis" ? "" : `${owner}.`;
        add(prototype.value, `${prefix}${propertyName(name)}.prototype`);
      }
    }
  }

  for (let index = 0; index < targets.length; index += 1) {
    const [target, owner] = targets[index]!;
    let prototype = getPrototypeOf(target) as object | null;
    let depth = 1;
    while (prototype) {
      add(prototype, `${owner}[[Prototype:${depth}]]`);
      prototype = getPrototypeOf(prototype) as object | null;
      depth += 1;
    }
  }

  const snapshots: TargetSnapshot[] = [];
  for (let index = 0; index < targets.length; index += 1) {
    const [target, owner] = targets[index]!;
    snapshots[index] = {
      target,
      owner,
      prototype: getPrototypeOf(target) as object | null,
      descriptors: snapshotDescriptors(target),
    };
  }
  return snapshots;
};

const sameDescriptorExceptValue = (left: PropertyDescriptor, right: PropertyDescriptor) =>
  left.configurable === right.configurable
  && left.enumerable === right.enumerable
  && left.writable === right.writable
  && left.get === right.get
  && left.set === right.set;

const cacheEntryResult = (entry: unknown) => {
  if (typeof entry !== "object" || entry === null) return undefined;
  const keys = ownKeys(entry);
  if (keys.length !== 1 || keys[0] !== "result") return undefined;
  const descriptor = getOwnPropertyDescriptor(entry, "result");
  if (!descriptor || !descriptor.configurable || !descriptor.enumerable || !descriptor.writable || descriptor.get || descriptor.set) return undefined;
  return descriptor.value;
};

const isCacheResult = (value: unknown) => {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const prototype = getPrototypeOf(value);
  if (prototype === weakRefPrototype) return true;
  const names = ownKeys(value);
  if (prototype !== objectPrototype || names.length !== 1 || (names[0] !== "match" && names[0] !== "element")) return false;
  const result = getOwnPropertyDescriptor(value, names[0]);
  return result?.configurable === true
    && result.enumerable === true
    && result.writable === true
    && (names[0] === "match"
      ? result.value === null || typeof result.value === "object"
      : result.value === null || (typeof result.value === "object" && getPrototypeOf(result.value) === weakRefPrototype))
    && result.get === undefined
    && result.set === undefined;
};

const isExpectedLifecycleChange = (
  snapshot: TargetSnapshot,
  name: PropertyKey,
  before: PropertyDescriptor | undefined,
  after: PropertyDescriptor | undefined,
) => {
  if (!stringEndsWith(snapshot.owner, ".document") && snapshot.owner !== "document") return false;
  if (typeof name === "symbol" && symbolDescription(name) === "readyState" && before && after) {
    return sameDescriptorExceptValue(before, after) && before.value === "interactive" && after.value === "complete";
  }
  const description = typeof name === "symbol" ? symbolDescription(name) : undefined;
  if ((description === "affectsCache" || description === "affectsComputedStyleCache") && before && after) {
    if (!sameDescriptorExceptValue(before, after) || !isArray(before.value) || !isArray(after.value) || before.value.length === after.value.length) return false;
    for (let index = 0; index < before.value.length; index += 1) if (!isCacheResult(cacheEntryResult(before.value[index]))) return false;
    for (let index = 0; index < after.value.length; index += 1) if (!isCacheResult(cacheEntryResult(after.value[index]))) return false;
    return true;
  }
  if (typeof name === "string" && stringStartsWith(name, "_reactListening") && !before && after) {
    return after.configurable === true
      && after.enumerable === true
      && after.writable === true
      && after.value === true
      && after.get === undefined
      && after.set === undefined;
  }
  return false;
};

const changedProperty = (snapshot: TargetSnapshot): PropertyKey | "[[Prototype]]" | undefined => {
  if (getPrototypeOf(snapshot.target) !== snapshot.prototype) return "[[Prototype]]";
  const current = snapshotDescriptors(snapshot.target);
  for (let index = 0; index < snapshot.descriptors.length; index += 1) {
    const [name, before] = snapshot.descriptors[index]!;
    const after = findDescriptor(current, name);
    if (!sameDescriptor(before, after) && !isExpectedLifecycleChange(snapshot, name, before, after)) return name;
  }
  for (let index = 0; index < current.length; index += 1) {
    const [name, after] = current[index]!;
    const before = findDescriptor(snapshot.descriptors, name);
    if (!before && !isExpectedLifecycleChange(snapshot, name, before, after)) return name;
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
  return "object";
};

export function domShimAlarm(file: string): void {
  if (findAlarm(file)) throw new AlarmError(`${file} registered the DOM shim alarm twice`);
  const alarm: Alarm = { file, shims: [], targets: snapshotTargets() };
  alarms[alarms.length] = alarm;

  afterAll(() => {
    if (alarm.shims.length > 0) {
      const shim = alarm.shims[0]!;
      throw new AlarmError(`${file} leaked DOM shim ${shim.owner}.${propertyName(shim.name)}`);
    }
    for (let index = 0; index < alarm.targets.length; index += 1) {
      const target = alarm.targets[index]!;
      const name = changedProperty(target);
      if (name !== undefined) throw new AlarmError(`${file} leaked DOM shim ${target.owner}.${propertyName(name)}`);
    }
    for (let index = 0; index < alarms.length; index += 1) {
      if (alarms[index] !== alarm) continue;
      for (let next = index + 1; next < alarms.length; next += 1) alarms[next - 1] = alarms[next]!;
      alarms.length -= 1;
      break;
    }
  });
}

export function shimProperty(target: object, name: PropertyKey, descriptor?: PropertyDescriptor): Restore {
  const file = Bun.main;
  const alarm = findAlarm(file);
  if (!alarm) throw new AlarmError(`${file} used shimProperty without domShimAlarm(import.meta.path)`);
  const previous = getOwnPropertyDescriptor(target, name);
  const owner = ownerName(target);
  const shim: TrackedShim = { owner, name };
  alarm.shims[alarm.shims.length] = shim;
  if (descriptor) defineProperty(target, name, descriptor);
  else deleteProperty(target, name);

  let restored = false;
  return () => {
    if (restored) return;
    if (previous) defineProperty(target, name, previous);
    else deleteProperty(target, name);
    restored = true;
    for (let index = 0; index < alarm.shims.length; index += 1) {
      if (alarm.shims[index] !== shim) continue;
      for (let next = index + 1; next < alarm.shims.length; next += 1) alarm.shims[next - 1] = alarm.shims[next]!;
      alarm.shims.length -= 1;
      break;
    }
  };
}

export function shimGlobal<K extends keyof typeof globalThis>(name: K, value: (typeof globalThis)[K]): Restore;
export function shimGlobal(name: PropertyKey, value: unknown): Restore;
export function shimGlobal(name: PropertyKey, value: unknown): Restore {
  const previous = getOwnPropertyDescriptor(globalThis, name);
  return shimProperty(globalThis, name, previous && "value" in previous
    ? { ...previous, value }
    : { configurable: true, enumerable: true, writable: true, value });
}
