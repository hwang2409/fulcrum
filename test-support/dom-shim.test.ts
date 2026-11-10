import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { domShimAlarm, shimGlobal, shimProperty } from "./dom-shim.js";
domShimAlarm(import.meta.path);

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

const rows = [
  ["alias", `const root = globalThis as any; root.__guard_slot = 1;`, "globalThis.__guard_slot"],
  ["direct", `(globalThis as any).__guard_slot = 1;`, "globalThis.__guard_slot"],
  ["parameter-default-alias", `((root: any = globalThis) => { root.__guard_slot = 1; })();`, "globalThis.__guard_slot"],
  ["computed-name", `(globalThis as any)["__guard_slot"] = 1;`, "globalThis.__guard_slot"],
  ["reflect", `Reflect.defineProperty(globalThis, "__guard_slot", { configurable: true, value: 1, writable: true });`, "globalThis.__guard_slot"],
  ["delete", `Reflect.deleteProperty(globalThis, "__guard_slot");`, "globalThis.__guard_slot"],
  ["set-prototype-of", `Object.setPrototypeOf((globalThis as any).__GuardConstructor.prototype, null);`, "__GuardConstructor.prototype.[[Prototype]]"],
  ["added-global", `(globalThis as any).__guard_added = 1;`, "globalThis.__guard_added"],
  ["ready-state-wrong-transition", `
    let readyState: symbol | undefined;
    for (const key of Reflect.ownKeys(document)) if (typeof key === "symbol" && key.description === "readyState") readyState = key;
    if (!readyState) throw new Error("readyState symbol missing");
    const descriptor = Object.getOwnPropertyDescriptor(document, readyState)!;
    Object.defineProperty(document, readyState, { ...descriptor, value: "loading" });
    if (document.readyState !== "loading") throw new Error("readyState mutation did not apply");
  `, "globalThis.document.Symbol(readyState)"],
  ["react-marker-replace", `(document as any)._reactListeningReview = false;`, "globalThis.document._reactListeningReview"],
  ["affects-cache-replace", `replaceDocumentSymbol("affectsCache", ["leak"]);`, "globalThis.document.Symbol(affectsCache)"],
  ["affects-cache-shaped-replace", `appendDocumentCacheResult("affectsCache");`, "globalThis.document.Symbol(affectsCache)"],
  ["affects-computed-style-cache-replace", `replaceDocumentSymbol("affectsComputedStyleCache", ["leak"]);`, "globalThis.document.Symbol(affectsComputedStyleCache)"],
  ["affects-computed-style-cache-shaped-replace", `appendDocumentCacheResult("affectsComputedStyleCache");`, "globalThis.document.Symbol(affectsComputedStyleCache)"],
  ["node-timing-replace", `Object.defineProperty(Performance.prototype, "nodeTiming", { configurable: true, value: 123, writable: true });`, "Performance.prototype.nodeTiming"],
  ["prototype-method-replace", `
    Object.defineProperty(Array.prototype, "map", { configurable: true, writable: true, value() { return []; } });
  `, "Array.prototype.map"],
  ["object-static-replace", `Object.keys = (() => []) as typeof Object.keys;`, "Object.keys"],
  ["reflect-static-replace", `Reflect.ownKeys = (() => []) as typeof Reflect.ownKeys;`, "Reflect.ownKeys"],
  ["math-static-replace", `Math.max = (() => 0) as typeof Math.max;`, "Math.max"],
  ["json-static-replace", `JSON.parse = (() => null) as typeof JSON.parse;`, "JSON.parse"],
  ["restored", `(globalThis as any).__guard_slot = 1; (globalThis as any).__guard_slot = 0;`, null],
  ["local-window-fixture", `const window = { value: 0 }; window.value = 1;`, null],
] as const;

for (const [name, mutation, expected] of rows) {
  test(`the public DOM shim alarm handles ${name} and names the exact property`, () => {
    const directory = mkdtempSync(join(import.meta.dir, "../packages/react/test/.dom-shim-cases-"));
    const path = join(directory, `${name}.test.ts`);
    try {
      writeFileSync(path, `
import { afterAll, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { domShimAlarm } from "../../../../test-support/dom-shim.js";

GlobalRegistrator.register();
Object.defineProperty(globalThis, "__guard_slot", { configurable: true, value: 0, writable: true });
Object.defineProperty(globalThis, "__GuardConstructor", { configurable: true, value: function GuardConstructor() {} });
Object.defineProperty(document, "_reactListeningReview", { configurable: true, enumerable: true, value: true, writable: true });
function replaceDocumentSymbol(description: string, value: unknown) {
  for (const key of Reflect.ownKeys(document)) {
    if (typeof key !== "symbol" || key.description !== description) continue;
    Object.defineProperty(document, key, { ...Object.getOwnPropertyDescriptor(document, key), value });
    return;
  }
  throw new Error(description + " symbol missing");
}
function appendDocumentCacheResult(description: string) {
  for (const key of Reflect.ownKeys(document)) {
    if (typeof key !== "symbol" || key.description !== description) continue;
    const before = (document as any)[key] as unknown[];
    replaceDocumentSymbol(description, [...before, { result: null }]);
    return;
  }
  throw new Error(description + " symbol missing");
}
domShimAlarm(import.meta.path);
afterAll(() => GlobalRegistrator.unregister());

test(${JSON.stringify(name)}, () => { ${mutation} });
`);
      const result = Bun.spawnSync({ cmd: [process.execPath, "test", path], stdout: "pipe", stderr: "pipe" });
      const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
      if (expected) {
        expect(`${name} exit=${result.exitCode}`).toBe(`${name} exit=1`);
        expect(output).toContain(`${basename(path)} leaked DOM shim ${expected}`);
      } else {
        expect(`${name} exit=${result.exitCode}`).toBe(`${name} exit=0`);
        expect(output).not.toContain("leaked DOM shim");
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }, 20_000);
}
