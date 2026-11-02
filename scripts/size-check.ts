const budget = Number(process.env.SIZE_BUDGET_BYTES ?? 5_000);
const builds = [
  { name: "core", entry: "packages/core/dist/index.js", external: [] },
  { name: "virtual", entry: "packages/virtual/dist/index.js", external: [] },
  { name: "react", entry: "packages/react/dist/index.js", external: ["@fulcrum/core", "react", "react-dom"] },
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
  console.log(`${target.name}: ${bytes} bytes gzipped (budget ${budget} bytes)`);
  if (bytes > budget) failed = true;
}
// Copy-in stylesheets, gzipped as shipped. Henry ranks polish over bytes, so these budgets catch runaway growth only.
const styles = [
  { name: "react styles.css", file: "packages/react/styles.css", budget: 8_000 },
  { name: "react themes.css", file: "packages/react/themes.css", budget: 6_000 },
];
for (const sheet of styles) {
  const bytes = Bun.gzipSync(await Bun.file(sheet.file).arrayBuffer()).byteLength;
  console.log(`${sheet.name}: ${bytes} bytes gzipped (budget ${sheet.budget} bytes)`);
  if (bytes > sheet.budget) failed = true;
}
if (failed) process.exit(1);
