// The package's javascript, in two builds. index.js is the fence (a few kB; react and @fulcrum/* stay the app's), with
// `import("./render.js")` left as is. render.js bundles mermaid and dompurify and loads on a page's first diagram;
// mermaid's diagram types stay lazy chunks of it, so a page loads the code of the diagram types it draws.
// index is the module itself, not a re-export: bun 1.3.13 emits an empty entry for a re-export entry under `sideEffects`.
import { rm } from "node:fs/promises";
const dist = new URL("../dist", import.meta.url).pathname;
const src = (file: string) => new URL(file, import.meta.url).pathname;
await rm(dist, { recursive: true, force: true });
const common = { outdir: dist, target: "browser", format: "esm", minify: true, sourcemap: "external", naming: { entry: "[name].js", chunk: "chunks/[name]-[hash].js" } } as const;
for (const result of [
  await Bun.build({
    ...common,
    entrypoints: [src("index.tsx")],
    external: ["react", "react/jsx-runtime", "@fulcrum/*"],
    plugins: [{ name: "lazy render", setup: (build) => build.onResolve({ filter: /^\.\/render\.js$/ }, () => ({ path: "./render.js", external: true })) }],
  }),
  await Bun.build({ ...common, entrypoints: [src("render.ts")], splitting: true }),
]) {
  if (result.success) continue;
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
