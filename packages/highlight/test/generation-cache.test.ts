import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createGenerationManifest, generationDigest, verifyBuiltLanguages, verifyGenerationCache } from "../src/generation-cache.js";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function cacheFixture() {
  const path = await mkdtemp(join(tmpdir(), "fulcrum-highlight-cache-"));
  temporary.push(path);
  const root = pathToFileURL(`${path}/`);
  await Promise.all([mkdir(new URL(".grammar-entries/", root)), mkdir(new URL(".recipe-entries/", root))]);
  const files = [".grammar-entries/julia.ts", ".recipe-entries/julia.ts"];
  await Promise.all(files.map((file) => writeFile(new URL(file, root), file)));
  const manifest = await createGenerationManifest(root, "digest", files);
  const manifestUrl = new URL("manifest.json", root);
  await writeFile(manifestUrl, JSON.stringify(manifest));
  return { root, manifestUrl, files };
}

describe("generated recipe cache", () => {
  test("rejects a missing, truncated, extra, or half-published file set", async () => {
    for (const mutation of [
      async ({ root }: Awaited<ReturnType<typeof cacheFixture>>) => rm(new URL(".recipe-entries/julia.ts", root)),
      async ({ root }: Awaited<ReturnType<typeof cacheFixture>>) => writeFile(new URL(".recipe-entries/julia.ts", root), ""),
      async ({ root }: Awaited<ReturnType<typeof cacheFixture>>) => writeFile(new URL(".recipe-entries/stray.ts", root), "stray"),
      async ({ root }: Awaited<ReturnType<typeof cacheFixture>>) => rm(new URL(".grammar-entries/julia.ts", root)),
    ]) {
      const fixture = await cacheFixture();
      expect(await verifyGenerationCache(fixture.root, fixture.manifestUrl, "digest", fixture.files)).toBe(true);
      await mutation(fixture);
      expect(await verifyGenerationCache(fixture.root, fixture.manifestUrl, "digest", fixture.files)).toBe(false);
    }
  });

  test("includes the bun engine version in the generation digest", async () => {
    expect(await generationDigest("engine-a")).not.toBe(await generationDigest("engine-b"));
  });

  test("rejects built output that omits a language", async () => {
    const path = await mkdtemp(join(tmpdir(), "fulcrum-highlight-dist-"));
    temporary.push(path);
    const root = pathToFileURL(`${path}/`);
    await Promise.all([mkdir(new URL("langs/", root)), mkdir(new URL("recipes/", root))]);
    await Promise.all([
      writeFile(new URL("langs/typescript.js", root), ""),
      writeFile(new URL("langs/julia.js", root), ""),
      writeFile(new URL("recipes/typescript.js", root), ""),
    ]);
    await expect(verifyBuiltLanguages(root, ["typescript", "julia"])).rejects.toThrow("incomplete recipes");
  });
});
