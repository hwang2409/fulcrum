const builds = [
  { name: "core", entry: "packages/core/dist/index.js", external: [], budget: 3_000 },
  { name: "react", entry: "packages/react/dist/index.js", external: ["@fulcrum/core", "react", "react-dom"], budget: 3_000 },
  { name: "zeta", entry: "packages/zeta/dist/index.js", external: ["@fulcrum/core"], budget: 4_000 },
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
  console.log(`${target.name}: ${bytes} bytes gzipped (budget ${target.budget} bytes)`);
  if (bytes > target.budget) failed = true;
}
const cssBudget = 2_000;
const css = await Bun.file("packages/react/styles.css").arrayBuffer();
const cssBytes = Bun.gzipSync(css).byteLength;
console.log(`css: ${cssBytes} bytes gzipped (budget ${cssBudget} bytes)`);
if (cssBytes > cssBudget) failed = true;
const virtual = "packages/virtual/dist/index.js";
if (await Bun.file(virtual).exists()) {
  const result = await Bun.build({ entrypoints: [virtual], outdir: dir, naming: "virtual.js", minify: true });
  if (!result.success) process.exit(1);
  const bytes = Bun.gzipSync(await Bun.file(`${dir}/virtual.js`).arrayBuffer()).byteLength;
  console.log(`virtual: ${bytes} bytes gzipped (budget 6_000 bytes)`);
  if (bytes > 6_000) failed = true;
} else {
  console.log("virtual: not present on main (budget deferred until the virtual package lands)");
}
if (failed) process.exit(1);
