// A page that registers MermaidFence but shows no diagram must not load mermaid: in the playground's production build
// (run `bun run --cwd apps/playground build` first), the static import graph of every page entry holds no mermaid
// code, and mermaid sits behind a dynamic import. "suppressErrorRendering" marks the code: only @fulcrum/mermaid's
// render module (the lazy half) and mermaid itself contain it, and the check fails if no lazy chunk does.
import { readFile } from "node:fs/promises";

const dist = new URL("../apps/playground/dist/", import.meta.url);
type Chunk = { file: string; src?: string; isEntry?: boolean; imports?: string[]; dynamicImports?: string[] };
const manifest = JSON.parse(await readFile(new URL(".vite/manifest.json", dist), "utf8")) as Record<string, Chunk>;
const marked = async (key: string) => (await readFile(new URL(manifest[key]!.file, dist), "utf8")).includes("suppressErrorRendering");
const failures: string[] = [];
let lazy = 0;
for (const [key, chunk] of Object.entries(manifest)) {
  if (!chunk.isEntry) continue;
  const closure = new Set<string>();
  const visit = (name: string) => { if (closure.has(name)) return; closure.add(name); manifest[name]!.imports?.forEach(visit); };
  visit(key);
  const loaded = [...closure].filter((name) => manifest[name]!.file.endsWith(".js"));
  for (const name of loaded) if (await marked(name)) failures.push(`${key}: its static imports include mermaid (${manifest[name]!.file})`);
  const dynamic = new Set(loaded.flatMap((name) => manifest[name]!.dynamicImports ?? []));
  for (const name of dynamic) if (await marked(name)) lazy++;
  const bytes = (await Promise.all(loaded.map((name) => readFile(new URL(manifest[name]!.file, dist))))).reduce((sum, data) => sum + Bun.gzipSync(data).byteLength, 0);
  console.log(`${key}: ${loaded.length} static chunks, ${bytes} bytes gzipped, no mermaid`);
}
if (!lazy) failures.push("no entry reaches mermaid through a dynamic import: the marker or the build changed");
if (failures.length) throw new Error(failures.join("\n"));
console.log(`mermaid stays behind a dynamic import (${lazy} entry links)`);
