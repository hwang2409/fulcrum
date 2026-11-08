import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

// Keep this order aligned with CI: package declarations first, generated package entries next, then both app typechecks.
const root = join(import.meta.dir, "..");

async function latestMtime(path: string): Promise<number> {
  const info = await stat(path);
  if (!info.isDirectory()) return info.mtimeMs;
  const entries = await readdir(path);
  const times = await Promise.all(entries.map((entry) => latestMtime(join(path, entry))));
  return Math.max(info.mtimeMs, ...times);
}

async function needsBuild(inputs: string[], outputs: string[]): Promise<boolean> {
  try {
    const [inputMtimes, outputMtimes] = await Promise.all([
      Promise.all(inputs.map(latestMtime)),
      Promise.all(outputs.map(async (path) => (await stat(path)).mtimeMs)),
    ]);
    return Math.max(...inputMtimes) > Math.min(...outputMtimes);
  } catch {
    return true;
  }
}

await Bun.$`bunx tsc -b`;

const highlightNeedsBuild = await needsBuild(
  [join(root, "packages/highlight/src"), join(root, "packages/highlight/.grammar-entries"), join(root, "packages/highlight/.recipe-entries")],
  [join(root, "packages/highlight/dist/index.js"), join(root, "packages/highlight/dist/index.d.ts"), join(root, "packages/highlight/dist/.build-manifest.json")],
);
if (highlightNeedsBuild) await Bun.$`bun run --cwd packages/highlight build`;
else console.log("typecheck: packages/highlight build is fresh");

const mermaidNeedsBuild = await needsBuild(
  [join(root, "packages/mermaid/src")],
  [join(root, "packages/mermaid/dist/index.js"), join(root, "packages/mermaid/dist/index.d.ts")],
);
if (mermaidNeedsBuild) await Bun.$`bun run --cwd packages/mermaid build`;
else console.log("typecheck: packages/mermaid build is fresh");

await Bun.$`bunx tsc -p apps/web`;
await Bun.$`bunx tsc -p apps/playground`;
