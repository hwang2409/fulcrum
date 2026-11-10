import { expect, test } from "bun:test";
import { shimGlobal, shimProperty } from "./dom-shim.js";

test("restores exact own descriptors", () => {
  const getter = () => 1;
  const setter = (_value: number) => {};
  const target = Object.create({ inherited: "parent" }) as Record<string, unknown>;
  Object.defineProperty(target, "accessor", { configurable: true, enumerable: false, get: getter, set: setter });
  const accessor = Object.getOwnPropertyDescriptor(target, "accessor");

  const restoreAccessor = shimProperty(target, "accessor", { configurable: true, value: 2 });
  const restoreInherited = shimProperty(target, "inherited", { configurable: true, value: "child" });
  const restoreAbsent = shimProperty(target, "absent", { configurable: true, value: true });

  restoreAbsent();
  restoreInherited();
  restoreAccessor();
  restoreAccessor();

  expect(Object.getOwnPropertyDescriptor(target, "accessor")).toEqual(accessor);
  expect(Object.hasOwn(target, "inherited")).toBe(false);
  expect(target.inherited).toBe("parent");
  expect(Object.hasOwn(target, "absent")).toBe(false);
});

test("nested shims restore in LIFO order", () => {
  const target = { value: "original" };
  const restoreOuter = shimProperty(target, "value", { configurable: true, value: "outer" });
  const restoreInner = shimProperty(target, "value", { configurable: true, value: "inner" });

  restoreInner();
  expect(target.value).toBe("outer");
  restoreOuter();
  expect(target.value).toBe("original");
});

test("shimGlobal restores the original descriptor", () => {
  const name = Symbol("dom-shim-test");
  const restore = shimGlobal(name, "temporary");
  expect(Reflect.get(globalThis, name)).toBe("temporary");
  restore();
  restore();
  expect(Object.hasOwn(globalThis, name)).toBe(false);
});
