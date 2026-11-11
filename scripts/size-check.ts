const external = ["@fulcrum/core", "@fulcrum/highlight", "@fulcrum/markdown", "@fulcrum/react", "@fulcrum/zeta", "@fulcrum/virtual", "react", "react-dom"];
const builds = [
  { name: "core", entry: "packages/core/dist/index.js", external, ceiling: 9_000 }, // 8,563 after deterministic cross-page entity and state composition
  { name: "core-search", entry: "packages/core/dist/search.js", external, ceiling: 2_500 }, // 2,033 for createRunSearch on its own subpath; accident alarm
  { name: "core-internal", entry: "packages/core/dist/internal.js", external, ceiling: 500 }, // 221 for streamTail, the internal entry @fulcrum/react uses (no API promise); accident alarm
  { name: "react", entry: "packages/react/dist/index.js", external, ceiling: 35_600 }, // 35,545 with one 64-read formatter for hostile tool-header summaries (34,944 before, +601); 34,789 with per-message and per-row render failure containment (34,360 before, +429); 33,583 with Bun 1.4.4 after stream tails (32,741 before, +842: tail-driven ANSI, metrics, segment texts, and the closed preview's head and tail windows, so an append costs the new text); 32,273 with the Notification part (31,645 before it, +628); Timeline-owned scrolling plus RunStatus and RunEndMarker measure 31,559 with Bun 1.4.4; bundle size is not a product goal, and this ceiling only catches accidents. measured 26,983 after content blocks (reasoning, source, file, image, unsupported). measured 25,125 after strict UX round 6 (decision focus, viewer place and narrow head, notification text). measured 24,213 after strict UX round 5 (approval fold, skip link, cut fades, whole-block colors). measured 22,089 after composer. tool-card highlighting, ANSI, JSON, and the show-full-command control: ~15.5 kB; sub-agent row, run navigator, and history path: ~3.5 kB; composer: 0.8 kB
  { name: "zeta", entry: "packages/zeta/dist/index.js", external, ceiling: 17_000 }, // 16,666 with shared child-history paging (+1,071 on 15,595); bundle size is not a product goal, this ceiling only catches accidents
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
  { name: "react styles.css", file: "packages/react/styles.css", ceiling: 17_200 }, // 16,953 with a text-omitted user's note as the whole row, with no empty message surface (+65 on 16,888); 16,888 after the merged wide viewer-head status colors and markdown/viewer follow-ups (+214 on 16,674); 16,674 with the narrow viewer head's new-output signal as a warn square before the jump button, its space kept in every state and CanvasText under forced colors, instead of warn text (status colors mark, never color text) (+114 on 16,560); 16,350 with a viewer head that never cuts its count (a compact "ln" unit, "at bottom" yields to "streaming" in narrow heads) and a static live rail that outranks the measure rule (+280 on 16,070); 16,070 with one live signal for every tail (the cursor ends a closed fence through md-code-end, a running rail on a block tail) and the text-only end gutter (+510 on 15,560); 15,560 with the cursor's end gutter (wide blocks take it back), the newest-row data-latest gate, a header cell cursor, and the viewer's "streaming" status word (+205 on 15,355); 14,885 with both the Notification part (+377) and the streaming cursor on real assistant markup plus reduced motion for every part (~0.35 kB); 13,878 after approve-always (three-action grid, decision error); 13,524 after the unknown-outcome run status and end marker; 12,658 after content blocks: ~1.3 kB; 11,424 after strict UX round 6 (narrow viewer head, status word colors); sub-agent row and run bar: ~0.9 kB; composer: 1.1 kB; approval decisions, skip link, cut fades: 0.7 kB
  { name: "react themes.css", file: "packages/react/themes.css", ceiling: 8_000 },
];
for (const sheet of styles) {
  const bytes = Bun.gzipSync(await Bun.file(sheet.file).arrayBuffer()).byteLength;
  console.log(`${sheet.name}: ${bytes} bytes gzipped (hard ceiling ${sheet.ceiling} bytes; accident alarm, not a regression budget)`);
  if (bytes > sheet.ceiling) failed = true;
}
if (failed) process.exit(1);
