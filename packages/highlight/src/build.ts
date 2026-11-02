import { rm } from "node:fs/promises";
await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [new URL("./index.ts", import.meta.url).pathname, new URL("./worker.ts", import.meta.url).pathname],
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
