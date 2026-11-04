import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { generationDigest, verifyBuiltLanguages, verifyGenerationCache } from "./generation-cache.js";
import { generationEntries } from "./generation-config.js";

const entries = generationEntries();
const expectedFiles = entries.flatMap((entry) => [`.grammar-entries/${entry.actual}.ts`, `.recipe-entries/${entry.actual}.ts`]).sort();
const packageRoot = new URL("../", import.meta.url);
const dist = new URL("dist", packageRoot);
const temporaryPrefix = "dist.tmp-";
const lock = new URL("dist.build-lock/", packageRoot);
while (true) {
  try {
    await mkdir(lock);
    await writeFile(new URL("pid", lock), String(process.pid));
    break;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = Number(await readFile(new URL("pid", lock), "utf8").catch(() => ""));
    try {
      if (owner) process.kill(owner, 0);
      else if (Date.now() - (await stat(lock)).mtimeMs > 10 * 60 * 1000) throw Object.assign(new Error(), { code: "ESRCH" });
      await Bun.sleep(50);
    } catch (ownerError) {
      if ((ownerError as NodeJS.ErrnoException).code !== "ESRCH") throw ownerError;
      await rm(lock, { recursive: true, force: true });
    }
  }
}
try {
  for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(temporaryPrefix)) continue;
    const path = new URL(`${entry.name}/`, packageRoot);
    if (Date.now() - (await stat(path)).mtimeMs > 10 * 60 * 1000) await rm(path, { recursive: true, force: true });
  }
  await Bun.$`bun ${new URL("./generate.ts", import.meta.url).pathname}`;
  if (!await verifyGenerationCache(packageRoot, new URL("../.recipe-generation-manifest.json", import.meta.url), await generationDigest(), expectedFiles)) {
    throw new Error("highlight recipe cache failed verification after generation");
  }
  const temporary = new URL(`${temporaryPrefix}build/`, packageRoot);
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
    // the build lock serializes publishers; directory renames keep consumers on a complete tree.
    await rename(dist, oldDist).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rename(temporary, dist);
    await rm(oldDist, { recursive: true, force: true });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
} finally {
  await rm(lock, { recursive: true, force: true });
}
