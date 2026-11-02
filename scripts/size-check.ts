const defaultBudget = Number(process.env.SIZE_BUDGET_BYTES ?? 5_000);
const builds = [
  { name: "core", entry: "packages/core/dist/index.js", external: [], budget: defaultBudget },
  { name: "virtual", entry: "packages/virtual/dist/index.js", external: [], budget: defaultBudget },
  { name: "react", entry: "packages/react/dist/index.js", external: ["@fulcrum/core", "@fulcrum/virtual", "react", "react-dom"], budget: 8_000 },
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
const highlightBuild = Bun.spawnSync(["bun", "run", "--cwd", "packages/highlight", "build"], { stdout: "inherit", stderr: "inherit" });
if (highlightBuild.exitCode !== 0) process.exit(highlightBuild.exitCode);
const highlightFiles = [...new Bun.Glob("**/*.js").scanSync("packages/highlight/dist")].sort();
for (const file of highlightFiles) {
  const bytes = Bun.gzipSync(await Bun.file(`packages/highlight/dist/${file}`).arrayBuffer()).byteLength;
  console.log(`highlight/${file}: ${bytes} bytes gzipped (reporting only)`);
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
