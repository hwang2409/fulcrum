const external = ["@fulcrum/core", "@fulcrum/highlight", "@fulcrum/markdown", "@fulcrum/react", "@fulcrum/zeta", "@fulcrum/virtual", "react", "react-dom"];
const builds = [
  { name: "core", entry: "packages/core/dist/index.js", external, ceiling: 9_000 }, // 8,563 after deterministic cross-page entity and state composition
  { name: "react", entry: "packages/react/dist/index.js", external, ceiling: 33_000 }, // 32,273 with the Notification part (31,645 before it, +628); Timeline-owned scrolling plus RunStatus and RunEndMarker measure 31,559 with Bun 1.4.4; bundle size is not a product goal, and this ceiling only catches accidents. measured 26,983 after content blocks (reasoning, source, file, image, unsupported). measured 25,125 after strict UX round 6 (decision focus, viewer place and narrow head, notification text). measured 24,213 after strict UX round 5 (approval fold, skip link, cut fades, whole-block colors). measured 22,089 after composer. tool-card highlighting, ANSI, JSON, and the show-full-command control: ~15.5 kB; sub-agent row, run navigator, and history path: ~3.5 kB; composer: 0.8 kB
  { name: "zeta", entry: "packages/zeta/dist/index.js", external, ceiling: 13_500 }, // shared backward history paging plus typed session grants measure 13,218; bundle size is not a product goal, this ceiling only catches accidents
  { name: "virtual", entry: "packages/virtual/dist/index.js", external, ceiling: 11_000 },
  { name: "markdown", entry: "packages/markdown/dist/react.js", external, reportOnly: true },
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
  if ("reportOnly" in target) console.log(`${target.name}: ${bytes} bytes gzipped (reporting only)`);
  else {
    console.log(`${target.name}: ${bytes} bytes gzipped (hard ceiling ${target.ceiling} bytes; accident alarm, not a regression budget)`);
    if (bytes > target.ceiling) failed = true;
  }
}
const highlightBuild = Bun.spawnSync(["bun", "run", "--cwd", "packages/highlight", "build"], { stdout: "inherit", stderr: "inherit" });
if (highlightBuild.exitCode !== 0) process.exit(highlightBuild.exitCode);
const highlightFiles = [...new Bun.Glob("**/*.js").scanSync("packages/highlight/dist")].sort();
for (const file of highlightFiles) {
  const bytes = Bun.gzipSync(await Bun.file(`packages/highlight/dist/${file}`).arrayBuffer()).byteLength;
  console.log(`highlight/${file}: ${bytes} bytes gzipped (reporting only)`);
}
const styles = [
  { name: "react styles.css", file: "packages/react/styles.css", ceiling: 14_600 }, // 14,355 with the Notification part (13,978 before it, +377); 13,878 after approve-always (three-action grid, decision error); 13,524 after the unknown-outcome run status and end marker; 12,658 after content blocks: ~1.3 kB; 11,424 after strict UX round 6 (narrow viewer head, status word colors); sub-agent row and run bar: ~0.9 kB; composer: 1.1 kB; approval decisions, skip link, cut fades: 0.7 kB
  { name: "react themes.css", file: "packages/react/themes.css", ceiling: 8_000 },
];
for (const sheet of styles) {
  const bytes = Bun.gzipSync(await Bun.file(sheet.file).arrayBuffer()).byteLength;
  console.log(`${sheet.name}: ${bytes} bytes gzipped (hard ceiling ${sheet.ceiling} bytes; accident alarm, not a regression budget)`);
  if (bytes > sheet.ceiling) failed = true;
}
if (failed) process.exit(1);
