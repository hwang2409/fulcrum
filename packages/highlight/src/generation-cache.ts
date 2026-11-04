import { createHash } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, readFile, stat } from "node:fs/promises";

export type GenerationManifest = {
  generationDigest: string;
  files: Record<string, string>;
};

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

async function localImportGraph(entry: URL): Promise<URL[]> {
  const found = new Map<string, URL>();
  const visit = async (file: URL) => {
    if (found.has(file.href)) return;
    found.set(file.href, file);
    const source = await readFile(file, "utf8");
    const imports = source.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["'](\.[^"']+)["']/g);
    for (const match of imports) {
      const specifier = match[1]!;
      const imported = new URL(specifier.endsWith(".js") ? `${specifier.slice(0, -3)}.ts` : specifier, file);
      await visit(imported);
    }
  };
  await visit(entry);
  return [...found.values()].sort((a, b) => a.href.localeCompare(b.href));
}

async function installedVersion(specifier: string): Promise<string> {
  let directory = dirname(fileURLToPath(import.meta.resolve(specifier)));
  while (true) {
    const packageJson = resolve(directory, "package.json");
    try {
      const parsed = JSON.parse(await readFile(packageJson, "utf8")) as { name?: string; version?: string };
      if (parsed.name === specifier && parsed.version) return parsed.version;
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`cannot resolve installed version for ${specifier}`);
    directory = parent;
  }
}

export async function generationDigest(bunVersion = Bun.version): Promise<string> {
  const hash = createHash("sha256");
  const add = (name: string, value: string | Uint8Array) => hash.update(`${name.length}:${name}:`).update(value).update("\0");
  add("bun", bunVersion);
  add("bun.lock", await readFile(new URL("../../../bun.lock", import.meta.url)));
  for (const specifier of ["shiki", "@shikijs/langs", "@shikijs/engine-javascript", "oniguruma-to-es"]) {
    add(`package:${specifier}`, await installedVersion(specifier));
  }
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  for (const file of await localImportGraph(new URL("./generate.ts", import.meta.url))) {
    add(`local:${relative(sourceDirectory, fileURLToPath(file))}`, await readFile(file));
  }
  return hash.digest("hex");
}

async function generatedFiles(root: URL): Promise<string[]> {
  const files: string[] = [];
  for (const directory of [".grammar-entries", ".recipe-entries"]) {
    const names = await readdir(new URL(`${directory}/`, root)).catch(() => []);
    for (const name of names) {
      const path = `${directory}/${name}`;
      if ((await stat(new URL(path, root))).isFile()) files.push(path);
      else files.push(`${path}/`);
    }
  }
  return files.sort();
}

export async function createGenerationManifest(root: URL, digest: string, expectedFiles: readonly string[]): Promise<GenerationManifest> {
  const actualFiles = await generatedFiles(root);
  if (JSON.stringify(actualFiles) !== JSON.stringify([...expectedFiles].sort())) throw new Error("generated recipe file set is incomplete");
  const files: Record<string, string> = {};
  for (const path of actualFiles) files[path] = sha256(await readFile(new URL(path, root)));
  return { generationDigest: digest, files };
}

export async function verifyGenerationCache(root: URL, manifestUrl: URL, digest: string, expectedFiles: readonly string[]): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as GenerationManifest;
    const expected = [...expectedFiles].sort();
    if (manifest.generationDigest !== digest || JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(expected)) return false;
    if (JSON.stringify(await generatedFiles(root)) !== JSON.stringify(expected)) return false;
    for (const path of expected) {
      if (sha256(await readFile(new URL(path, root))) !== manifest.files[path]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function verifyBuiltLanguages(dist: URL, languageIds: readonly string[]): Promise<void> {
  for (const directory of ["langs", "recipes"]) {
    const actual = (await readdir(new URL(`${directory}/`, dist))).filter((name) => name.endsWith(".js")).sort();
    const expected = languageIds.map((id) => `${id}.js`).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`highlight build has incomplete ${directory}: expected ${expected.length} language assets, found ${actual.length}`);
    }
  }
}
