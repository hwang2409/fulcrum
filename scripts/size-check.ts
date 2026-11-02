const defaultBudget = Number(process.env.SIZE_BUDGET_BYTES ?? 5_000);
const builds = [
  { name: "core", entry: "packages/core/dist/index.js", external: [], budget: defaultBudget },
  { name: "virtual", entry: "packages/virtual/dist/index.js", external: [], budget: defaultBudget },
  { name: "react", entry: "packages/react/dist/index.js", external: ["@fulcrum/core", "@fulcrum/virtual", "react", "react-dom"], budget: 4_000 },
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
  console.log(`${target.name}: ${bytes} bytes gzipped (budget ${target.budget} bytes)`);
  if (bytes > target.budget) failed = true;
}
if (failed) process.exit(1);
