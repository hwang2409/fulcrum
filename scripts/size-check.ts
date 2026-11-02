const external = ["@fulcrum/core", "@fulcrum/react", "@fulcrum/zeta", "@fulcrum/virtual", "react", "react-dom"];
const builds = [
  { name: "core", entry: "packages/core/dist/index.js", external, ceiling: 8_500 },
  { name: "react", entry: "packages/react/dist/index.js", external, ceiling: 6_000 },
  { name: "zeta", entry: "packages/zeta/dist/index.js", external, ceiling: 8_500 },
  { name: "virtual", entry: "packages/virtual/dist/index.js", external, ceiling: 11_000 },
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
  console.log(`${target.name}: ${bytes} bytes gzipped (hard ceiling ${target.ceiling} bytes; accident alarm, not a regression budget)`);
  if (bytes > target.ceiling) failed = true;
}
const cssCeiling = 5_000;
const css = await Bun.file("packages/react/styles.css").arrayBuffer();
const cssBytes = Bun.gzipSync(css).byteLength;
console.log(`css: ${cssBytes} bytes gzipped (hard ceiling ${cssCeiling} bytes; accident alarm, not a regression budget)`);
if (cssBytes > cssCeiling) failed = true;
if (failed) process.exit(1);
