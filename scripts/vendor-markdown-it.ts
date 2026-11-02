import { writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const result = await Bun.build({
  entrypoints: [new URL("node_modules/markdown-it/index.mjs", root).pathname],
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "none",
});
if (!result.success || result.outputs.length !== 1) throw new Error("markdown-it vendor build failed");
const bundle = await result.outputs[0]!.text();
await writeFile(new URL("packages/markdown/src/vendor/markdown-it.mjs", root), `// Vendored markdown-it 14.1.0 bundle. See ../../MARKDOWN_IT_LICENSE.md.\n${bundle}`);
