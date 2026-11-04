import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir, rename, rm, writeFile } from "node:fs/promises";
import { createBuildManifest, generationDigest, verifyBuildManifest, verifyBuiltLanguages, verifyGenerationCache } from "./generation-cache.js";
import { generationEntries } from "./generation-config.js";

const entries = generationEntries();
const expectedFiles = entries.flatMap((entry) => [`.grammar-entries/${entry.actual}.ts`, `.recipe-entries/${entry.actual}.ts`]).sort();
const packageRoot = new URL("../", import.meta.url);
const dist = new URL("dist/", packageRoot);
const distPath = new URL("dist", packageRoot).pathname;
const lock = new URL(".build.lock", packageRoot);
const manifest = new URL(".build-manifest.json", dist);
const pendingManifest = new URL(".build-manifest.pending", packageRoot);
const lockContents = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
const waitStartedAt = Date.now();
let backoff = 50;

const releaseLock = () => {
  try {
    if (readFileSync(lock, "utf8") === lockContents) unlinkSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

while (true) {
  try {
    const descriptor = openSync(lock, "wx");
    try {
      writeFileSync(descriptor, lockContents);
    } finally {
      closeSync(descriptor);
    }
    break;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (Date.now() - waitStartedAt >= 10 * 60 * 1000) throw new Error("timed out waiting for highlight build lock");
    let current: string;
    try {
      current = readFileSync(lock, "utf8");
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw readError;
    }
    let owner = 0;
    try {
      owner = Number((JSON.parse(current) as { pid?: number }).pid);
    } catch {}
    if (owner) {
      try {
        process.kill(owner, 0);
      } catch (ownerError) {
        if ((ownerError as NodeJS.ErrnoException).code !== "ESRCH") throw ownerError;
        try {
          if (readFileSync(lock, "utf8") === current) unlinkSync(lock);
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError;
        }
        continue;
      }
    }
    await Bun.sleep(backoff);
    backoff = Math.min(backoff * 2, 500);
  }
}

const releaseOnSignal = (signal: NodeJS.Signals) => {
  releaseLock();
  process.exit(signal === "SIGINT" ? 130 : 143);
};
process.once("SIGINT", releaseOnSignal);
process.once("SIGTERM", releaseOnSignal);

try {
  await Bun.$`bun ${new URL("./generate.ts", import.meta.url).pathname}`;
  if (!await verifyGenerationCache(packageRoot, new URL(".recipe-generation-manifest.json", packageRoot), await generationDigest(), expectedFiles)) {
    throw new Error("highlight recipe cache failed verification after generation");
  }

  await rm(dist, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: [new URL("./index.ts", import.meta.url).pathname, new URL("./worker.ts", import.meta.url).pathname, new URL("./runtime.ts", import.meta.url).pathname, new URL("./names.ts", import.meta.url).pathname],
    // Bun's debug identifiers include the outdir string; keep the proven direct-dist spelling stable.
    outdir: distPath,
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
    const sourceEntries = new URL(source, import.meta.url);
    const names = (await readdir(sourceEntries)).filter((name) => name.endsWith(".ts"));
    const built = await Bun.build({
      entrypoints: names.map((name) => new URL(name, sourceEntries).pathname),
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

  await buildAssets("../.grammar-entries/", "../dist/langs");
  await buildAssets("../.recipe-entries/", "../dist/recipes");
  await Bun.$`bunx tsc -p ${new URL("../tsconfig.types.json", import.meta.url).pathname}`;
  await verifyBuiltLanguages(dist, entries.map((entry) => entry.actual));
  await writeFile(pendingManifest, `${JSON.stringify(await createBuildManifest(dist), null, 2)}\n`);
  await rename(pendingManifest, manifest);
  if (!await verifyBuildManifest(dist)) throw new Error("highlight build manifest failed verification");
} finally {
  process.off("SIGINT", releaseOnSignal);
  process.off("SIGTERM", releaseOnSignal);
  await rm(pendingManifest, { force: true });
  releaseLock();
}
