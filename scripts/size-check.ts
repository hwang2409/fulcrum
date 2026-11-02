const builds = [
  { name: "core", entry: "packages/core/dist/index.js", external: [], budget: 1_700, ceiling: 3_000 },
  { name: "react", entry: "packages/react/dist/index.js", external: ["@fulcrum/core", "react", "react-dom"], budget: 1_600 },
  { name: "zeta", entry: "packages/zeta/dist/index.js", external: ["@fulcrum/core"], budget: 2_700, ceiling: 3_000 },
  { name: "virtual", entry: "packages/virtual/dist/index.js", external: [], budget: 3_300 },
];
let failed = false;
const dir = (await Bun.$`mktemp -d`).text().trim();
for (const target of builds) {
  const output = `${dir}/${target.name}.js`;
  const result = await Bun.build({ entrypoints: [target.entry], outdir: dir, naming: `${target.name}.js`, minify: true, external: target.external });
  if (!result.success) {
    console.error(`${target.name}: build failed`);
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  const bytes = Bun.gzipSync(await Bun.file(output).arrayBuffer()).byteLength;
  console.log(`${target.name}: ${bytes} bytes gzipped (regression budget ${target.budget} bytes${target.ceiling ? `; architectural ceiling ${target.ceiling} bytes` : ""})`);
  if (bytes > target.budget || (target.ceiling && bytes > target.ceiling)) failed = true;
}
const cssBudget = 1_400;
const cssCeiling = 2_000;
const css = await Bun.file("packages/react/styles.css").arrayBuffer();
const cssBytes = Bun.gzipSync(css).byteLength;
console.log(`css: ${cssBytes} bytes gzipped (regression budget ${cssBudget} bytes; architectural ceiling ${cssCeiling} bytes)`);
if (cssBytes > cssBudget || cssBytes > cssCeiling) failed = true;
if (failed) process.exit(1);
