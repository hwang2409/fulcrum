import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { generationDigest, verifyBuiltLanguages, verifyGenerationCache } from "./generation-cache.js";
import { generationEntries } from "./generation-config.js";

const entries = generationEntries();
const expectedFiles = entries.flatMap((entry) => [`.grammar-entries/${entry.actual}.ts`, `.recipe-entries/${entry.actual}.ts`]).sort();
const packageRoot = new URL("../", import.meta.url);
const dist = new URL("dist", packageRoot);
const temporaryPrefix = "dist.tmp-";
for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith(temporaryPrefix)) continue;
  const path = new URL(`${entry.name}/`, packageRoot);
  if (Date.now() - (await stat(path)).mtimeMs > 10 * 60 * 1000) await rm(path, { recursive: true, force: true });
}
await Bun.$`bun ${new URL("./generate.ts", import.meta.url).pathname}`;
if (!await verifyGenerationCache(packageRoot, new URL("../.recipe-generation-manifest.json", import.meta.url), await generationDigest(), expectedFiles)) {
  throw new Error("highlight recipe cache failed verification after generation");
}
const temporary = new URL(`${temporaryPrefix}${process.pid}-${randomUUID()}/`, packageRoot);
await rm(temporary, { recursive: true, force: true });
await mkdir(temporary, { recursive: true });
const result = await Bun.build({
  entrypoints: [new URL("./index.ts", import.meta.url).pathname, new URL("./worker.ts", import.meta.url).pathname, new URL("./runtime.ts", import.meta.url).pathname, new URL("./names.ts", import.meta.url).pathname],
  outdir: temporary.pathname,
  root: new URL(".", import.meta.url).pathname,
  target: "browser",
  format: "esm",
  splitting: true,
  minify: true,
  sourcemap: "external",
  naming: { entry: "[name].js", chunk: "chunks/[name]-[hash].js" },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("highlight javascript build failed");
}

const buildAssets = async (source: string, output: string) => {
  const entries = new URL(source, import.meta.url);
  const names = (await readdir(entries)).filter((name) => name.endsWith(".ts"));
  const built = await Bun.build({
    entrypoints: names.map((name) => new URL(name, entries).pathname),
    outdir: new URL(output, import.meta.url).pathname,
    target: "browser",
    format: "esm",
    splitting: false,
    minify: true,
    sourcemap: "external",
    naming: { entry: "[name].js" },
  });
  if (!built.success) {
    for (const log of built.logs) console.error(log);
    throw new Error("highlight asset build failed");
  }
};
try {
  await buildAssets("../.grammar-entries/", `${temporary.pathname}/langs`);
  await buildAssets("../.recipe-entries/", `${temporary.pathname}/recipes`);
  await verifyBuiltLanguages(temporary, entries.map((entry) => entry.actual));
  const oldDist = new URL(`dist.old-${process.pid}-${randomUUID()}/`, packageRoot);
  // directory renames publish only complete trees; a lock would not protect consumers reading dist.
  await rename(dist, oldDist).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await rename(temporary, dist);
  await rm(oldDist, { recursive: true, force: true });
} catch (error) {
  await rm(temporary, { recursive: true, force: true });
  throw error;
}
