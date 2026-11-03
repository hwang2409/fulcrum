import { readdir, rm } from "node:fs/promises";
await import("./generate.ts");
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

const grammarEntries = new URL("../.grammar-entries/", import.meta.url);
const grammarNames = (await readdir(grammarEntries)).filter((name) => name.endsWith(".ts")).map((name) => name.slice(0, -3));
const grammars = await Bun.build({
  entrypoints: grammarNames.map((name) => new URL(`${name}.ts`, grammarEntries).pathname),
  outdir: new URL("../dist/langs", import.meta.url).pathname,
  target: "browser",
  format: "esm",
  splitting: false,
  minify: true,
  sourcemap: "external",
  naming: { entry: "[name].js" },
});
await rm(grammarEntries, { recursive: true, force: true });
if (!grammars.success) {
  for (const log of grammars.logs) console.error(log);
  process.exit(1);
}
