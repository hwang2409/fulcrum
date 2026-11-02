const budget = Number(process.env.SIZE_BUDGET_BYTES ?? 5_000);
const builds = [
  { name: "core", entry: "packages/core/dist/index.js", external: [] },
  { name: "virtual", entry: "packages/virtual/dist/index.js", external: [] },
  { name: "react", entry: "packages/react/dist/index.js", external: ["@fulcrum/core", "react", "react-dom"] },
  { name: "markdown", entry: "packages/markdown/dist/react.js", external: ["react", "react-dom"], reportOnly: true },
];
let failed = false;
const dir = await Bun.$`mktemp -d`.text();
for (const target of builds) {
  const output = `${dir.trim()}/${target.name}.js`;
  const result = await Bun.build({ entrypoints: [target.entry], outdir: dir.trim(), naming: `${target.name}.js`, minify: true, external: target.external });
  if (!result.success) {
    console.error(`${target.name}: build failed`);
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  const bytes = Bun.gzipSync(await Bun.file(output).arrayBuffer()).byteLength;
  console.log(`${target.name}: ${bytes} bytes gzipped${"reportOnly" in target ? " (reported, no budget)" : ` (budget ${budget} bytes)`}`);
  if (!("reportOnly" in target) && bytes > budget) failed = true;
}
if (failed) process.exit(1);
