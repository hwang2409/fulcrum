import { expect, test } from "bun:test";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const rawShim = /Object\.defineProperty\(\s*(?:(?:HTMLElement|Element|Node|Navigator|Window)\.prototype|globalThis\b|window\b|navigator\b|performance\b|proto\b)|(?:globalThis|window)\.(?:ResizeObserver|requestAnimationFrame|cancelAnimationFrame|matchMedia|Worker|reportError)\s*=|delete\s+(?:globalThis|window|navigator|(?:HTMLElement|Element|Node|Navigator|Window)\.prototype)\b/;

test("test DOM shims use the shared helper and register its alarm", async () => {
  const failures: string[] = [];
  for await (const path of new Bun.Glob("{packages,apps}/**/*.{test,spec}.{ts,tsx}").scan({ cwd: root, absolute: true })) {
    const source = await Bun.file(path).text();
    if (rawShim.test(source)) failures.push(`${relative(root, path)} uses a raw DOM shim; use test-support/dom-shim.ts`);
    if (source.includes("test-support/dom-shim") && !source.includes("domShimAlarm(import.meta.path)")) {
      failures.push(`${relative(root, path)} imports the DOM shim helper without domShimAlarm(import.meta.path)`);
    }
  }
  expect(failures).toEqual([]);
});
