import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const rows = [
  ["alias", `const root = globalThis as any; root.__guard_slot = 1;`, true],
  ["direct", `(globalThis as any).__guard_slot = 1;`, true],
  ["parameter-default-alias", `((root: any = globalThis) => { root.__guard_slot = 1; })();`, true],
  ["computed-name", `(globalThis as any)["__guard_slot"] = 1;`, true],
  ["reflect", `Reflect.defineProperty(globalThis, "__guard_slot", { configurable: true, value: 1, writable: true });`, true],
  ["delete", `Reflect.deleteProperty(globalThis, "__guard_slot");`, true],
  ["set-prototype-of", `Object.setPrototypeOf((globalThis as any).__GuardConstructor.prototype, null);`, true],
  ["added-global", `(globalThis as any).__guard_added = 1;`, true],
  ["restored", `(globalThis as any).__guard_slot = 1; (globalThis as any).__guard_slot = 0;`, false],
  ["local-window-fixture", `const window = { value: 0 }; window.value = 1;`, false],
] as const;

test("the public DOM shim alarm catches leaked runtime forms", () => {
  // The source hint must distinguish a local fixture from the real browser global.
  const window = { value: 0 };
  window.value = 1;
  expect(window.value).toBe(1);

  const directory = mkdtempSync(join(import.meta.dir, ".dom-shim-cases-"));
  try {
    for (const [name, mutation, fails] of rows) {
      const path = join(directory, `${name}.test.ts`);
      writeFileSync(path, `
import { afterAll, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { domShimAlarm } from "../dom-shim.js";

GlobalRegistrator.register();
Object.defineProperty(globalThis, "__guard_slot", { configurable: true, value: 0, writable: true });
Object.defineProperty(globalThis, "__GuardConstructor", { configurable: true, value: function GuardConstructor() {} });
domShimAlarm(import.meta.path);
afterAll(() => GlobalRegistrator.unregister());

test(${JSON.stringify(name)}, () => { ${mutation} });
`);
      const result = Bun.spawnSync({ cmd: [process.execPath, "test", path], stdout: "pipe", stderr: "pipe" });
      const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
      if (fails) {
        expect(`${name} exit=${result.exitCode}`).toBe(`${name} exit=1`);
        expect(output).toContain(`${basename(path)} leaked DOM shim`);
      } else {
        expect(`${name} exit=${result.exitCode}`).toBe(`${name} exit=0`);
        expect(output).not.toContain("leaked DOM shim");
      }
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
