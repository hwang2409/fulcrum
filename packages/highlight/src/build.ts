import { readdir, rm } from "node:fs/promises";
await Bun.$`bun ${new URL("./generate.ts", import.meta.url).pathname}`;
await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [new URL("./index.ts", import.meta.url).pathname, new URL("./worker.ts", import.meta.url).pathname, new URL("./runtime.ts", import.meta.url).pathname, new URL("./names.ts", import.meta.url).pathname],
  outdir: new URL("../dist", import.meta.url).pathname,
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
  process.exit(1);
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
    process.exit(1);
  }
};
await buildAssets("../.grammar-entries/", "../dist/langs");
await buildAssets("../.recipe-entries/", "../dist/recipes");
