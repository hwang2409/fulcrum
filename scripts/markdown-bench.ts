import { createStreamingDocument } from "../packages/markdown/src/index.js";

const targetBytes = 100_000;
const deltaSizes = [1, 20, 200];

type Measurement = { p95: number; p99: number; max: number; workRatio: number; maxWork: number; maxCopied: number };
const failsGate = ({ p95, p99, max, workRatio }: Measurement) => workRatio > 1.2 || p95 > 2 || p99 > 4 || max > 50;

const quarterRatio = (samples: number[]) => {
  const quarter = Math.max(1, Math.floor(samples.length / 4));
  const early = samples.slice(quarter, quarter * 2);
  const late = samples.slice(quarter * 3, quarter * 4);
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return average(late) / Math.max(average(early), 1);
};

function proveGateSensitivity() {
  const bounded = Array.from({ length: 1_000 }, () => 20);
  const wholeContainer = Array.from({ length: 1_000 }, (_, index) => (index + 1) * 20);
  const boundedRatio = quarterRatio(bounded);
  const wholeContainerRatio = quarterRatio(wholeContainer);
  if (boundedRatio > 1.2 || wholeContainerRatio <= 1.2)
    throw new Error(`markdown work gate is not sensitive: bounded ${boundedRatio.toFixed(2)}x, whole-container ${wholeContainerRatio.toFixed(2)}x`);
  const base = { p95: 1, p99: 2, max: 8, workRatio: 1, maxWork: 1, maxCopied: 1 };
  if (failsGate(base) || !failsGate({ ...base, p99: 4.01 }) || !failsGate({ ...base, max: 50.01 }))
    throw new Error("markdown latency gate does not catch p99 regressions and isolated pauses");
  console.log(`work gate sensitivity: bounded ${boundedRatio.toFixed(2)}x passes; deliberate whole-container parser ${wholeContainerRatio.toFixed(2)}x fails; p99 and isolated-pause probes fail`);
}

function measure(source: string, deltaSize: number): Measurement {
  let work: number[] = [];
  let maxCopied = 0;
  const trials = Array.from({ length: 7 }, (_, trial) => {
    const document = createStreamingDocument();
    const durations: number[] = [];
    const trialWork: number[] = [];
    for (let index = 0; index < source.length; index += deltaSize) {
      const before = document.stats.scannedCharacters;
      const copiedBefore = document.stats.copiedCharacters;
      const start = performance.now();
      document.append(source.slice(index, index + deltaSize));
      document.render();
      durations.push(performance.now() - start);
      trialWork.push(document.stats.scannedCharacters - before);
      maxCopied = Math.max(maxCopied, document.stats.copiedCharacters - copiedBefore);
    }
    if (trial === 0) work = trialWork;
    const sorted = durations.sort((a, b) => a - b);
    return { p95: sorted[Math.floor(durations.length * 0.95)]!, p99: sorted[Math.floor(durations.length * 0.99)]!, max: sorted.at(-1)! };
  });
  const median = (key: "p95" | "p99" | "max") => trials.map((trial) => trial[key]).sort((a, b) => a - b)[3]!;
  return {
    p95: median("p95"),
    p99: median("p99"),
    max: median("max"),
    workRatio: quarterRatio(work),
    maxWork: Math.max(...work),
    maxCopied,
  };
}

const shortParagraph = `${"streaming markdown stays bounded ".repeat(3)}\n\n`;
const quoteLine = `> ${"quoted agent output ".repeat(4)}\n`;
const mixedQuote = "> summary\n>\n> - completed step\n>\n> ```ts\n> const value = 1;\n> ```\n>\n";
const deepQuoteListQuote = "> - outer item\n>   > deepest leaf keeps streaming words and `code` safely.\n";
const nestedTable = "> - nested quote-list\n>   > | check | result |\n>   > | --- | ---: |\n>   > | package | passing |\n";
const cases = [
  ["many short paragraphs", shortParagraph.repeat(Math.ceil(targetBytes / shortParagraph.length)).slice(0, targetBytes)],
  ["long paragraph", "streaming markdown stays bounded ".repeat(Math.ceil(targetBytes / 33)).slice(0, targetBytes)],
  ["open fence", `\`\`\`ts\n${"const value = 1234567890;\n".repeat(Math.ceil(targetBytes / 26))}`.slice(0, targetBytes)],
  ["open table", `| check | result | time |\n| --- | --- | ---: |\n${"| package | passing | 1.2ms |\n".repeat(Math.ceil(targetBytes / 30))}`.slice(0, targetBytes)],
  ["long list", "- completed agent step\n".repeat(Math.ceil(targetBytes / 23)).slice(0, targetBytes)],
  ["open blockquote", quoteLine.repeat(Math.ceil(targetBytes / quoteLine.length)).slice(0, targetBytes)],
  ["mixed quote", mixedQuote.repeat(Math.ceil(targetBytes / mixedQuote.length)).slice(0, targetBytes)],
  ["quote list quote", deepQuoteListQuote.repeat(Math.ceil(targetBytes / deepQuoteListQuote.length)).slice(0, targetBytes)],
  ["nested table", nestedTable.repeat(Math.ceil(targetBytes / nestedTable.length)).slice(0, targetBytes)],
] as const;

proveGateSensitivity();
console.log(`markdown stream benchmark: ${targetBytes} bytes`);
let failed = false;
for (const deltaSize of deltaSizes) for (const [name, source] of cases) {
  const result = measure(source, deltaSize);
  console.log(`${String(deltaSize).padStart(3)} B  ${name.padEnd(22)} p95 ${result.p95.toFixed(3)} ms  p99 ${result.p99.toFixed(3)} ms  max ${result.max.toFixed(3)} ms  work ${result.workRatio.toFixed(2)}x  max-work ${result.maxWork}  max-copy ${result.maxCopied}`);
  if (failsGate(result)) failed = true;
}
const millionByteParagraph = measure("a".repeat(1_000_000), 1_024);
console.log(`1024 B  ${"1 MB soft-wrapped paragraph".padEnd(22)} p95 ${millionByteParagraph.p95.toFixed(3)} ms  p99 ${millionByteParagraph.p99.toFixed(3)} ms  max ${millionByteParagraph.max.toFixed(3)} ms  work ${millionByteParagraph.workRatio.toFixed(2)}x  max-work ${millionByteParagraph.maxWork}  max-copy ${millionByteParagraph.maxCopied}`);
// The growing line re-parses its fixed provisional suffix (256 plus at most 64 characters of cut slack).
if (failsGate(millionByteParagraph) || millionByteParagraph.maxCopied > 1_024 + 256 + 64) failed = true;

// The newline that commits a long rich line parses it once; quadratic scans took 6-8 s at 1 MB.
const richUnit = "plain **strong** and *emphasis* with `code`. ";

// A growing 1 MB rich line copies only the delta plus the fixed pending suffix, whatever its markers do.
const PENDING_SUFFIX = 256;
const adversarialRows = [
  ["300k openers underscore", `${"*a ".repeat(100_000)}${"_x".repeat(200)}`],
  ["300k openers brackets", `${"*a ".repeat(100_000)}${"]x".repeat(200)}`],
  ["bracket over 300k openers", `[${"*a ".repeat(100_000)}]x`],
  ["30k openers underscore", `${"*a ".repeat(10_000)}${"_x".repeat(200)}`],
] as const;
for (const [name, source] of adversarialRows) {
  const result = measure(source, 1_024);
  console.log(`1024 B  ${name.padEnd(26)} p95 ${result.p95.toFixed(3)} ms  p99 ${result.p99.toFixed(3)} ms  max ${result.max.toFixed(3)} ms  work ${result.workRatio.toFixed(2)}x  max-copy ${result.maxCopied}`);
  if (result.p99 > 10 || result.max > 100 || result.workRatio > 1.2) failed = true;
}

const richLines = [
  ["1 MB rich line", richUnit],
  ["1 MB must prose", "We **must** keep this fast. "],
  ["1 MB arithmetic", "x * y = z and a_b. "],
  ["1 MB code spans", "The function returns `null` when `value` is missing. "],
  ["1 MB rich unresolved [", `**strong** *emphasis* \`code\` [link](https://example.com) [${richUnit}`],
  // A stable opener that never closes: every delta looks for its closer in the suffix.
  ["1 MB open emphasis", `_${richUnit}`],
] as const;
for (const [name, unit] of richLines) {
  const result = measure(unit.repeat(Math.ceil(1_000_000 / unit.length)).slice(0, 1_000_000), 1_024);
  console.log(`1024 B  ${name.padEnd(22)} p95 ${result.p95.toFixed(3)} ms  p99 ${result.p99.toFixed(3)} ms  max ${result.max.toFixed(3)} ms  max-copy ${result.maxCopied}`);
  if (result.p99 > 5 || result.max > 16 || result.maxCopied > 1_024 + PENDING_SUFFIX + 64) failed = true;
}

const commitTime = (length: number) => {
  const samples = Array.from({ length: 3 }, () => {
    const document = createStreamingDocument();
    document.append(richUnit.repeat(Math.ceil(length / richUnit.length)).slice(0, length));
    document.render();
    const start = performance.now();
    document.append("\n");
    document.render();
    return performance.now() - start;
  });
  return samples.sort((a, b) => a - b)[1]!;
};
const commits = [100_000, 200_000, 1_000_000].map((length) => [length, commitTime(length)] as const);
for (const [length, time] of commits) console.log(`newline  ${`rich line commit ${length / 1000}k`.padEnd(22)} median ${time.toFixed(3)} ms`);
const commitRatio = commits[2]![1] / Math.max(commits[0]![1], 0.1);
console.log(`rich line commit growth 100k -> 1 MB: ${commitRatio.toFixed(1)}x (linear is ~10x)`);
if (commitRatio > 25 || commits[2]![1] > 500) failed = true;

// A paragraph's 2nd and later lines ask, on every delta, whether the growing line starts a block. That check
// (`startsLeafBlock`) must read the line's first characters only; a whole-line regex makes continuation lines
// quadratic. The gate is a size-scaling ratio: growing the line 4x (48k -> 192k) must not grow the time super-linearly.
//
// Robustness: the small (48k) and large (192k) runs are measured back-to-back as one pair, and the gate is the median
// of 7 per-pair ratios. Pairing cancels machine-wide slowdowns, because a slow moment on a shared CI runner hits both
// sizes in the same pair and leaves their ratio unchanged; the earlier version measured the two sizes in separate
// batches, so a slowdown during only the large batch inflated the ratio (CI 41985973904 attempt 1 read 8.1x against a
// clean baseline of ~6x, with almost no margin). One warm-up pair is discarded so JIT and GC warm-up do not land in a
// measured pair.
//
// Calibration: clean reads ~6.4x here (not the ideal 4x), because the inline/pending-paragraph path still grows mildly
// super-linearly with line length. A whole-line regex in `startsLeafBlock` (the mistake this guards) reads ~11.5x.
// The 7.5x threshold sits between them with margin on both sides; the paired median absorbs normal runner noise.
//
// Detection limit (honest): this gate catches super-linear growth (a whole-line scan per delta), not a constant-factor
// slowdown. A flat slowdown scales both sizes equally and leaves the ratio near its ~6x baseline, so a regression must
// add roughly 1.2x of extra scaling on top of that baseline to cross 7.5x; smaller constant-factor regressions are
// instead caught by the p95/p99/max latency gates above.
const continuationTime = (units: number) => {
  const source = `first line\n${"word **b** `c` and more ".repeat(units)}`;
  const document = createStreamingDocument();
  const start = performance.now();
  for (let offset = 0; offset < source.length; offset += 64) { document.append(source.slice(offset, offset + 64)); document.render(); }
  return performance.now() - start;
};
continuationTime(2_000); continuationTime(8_000); // warm-up pair, discarded
const continuationPairs = Array.from({ length: 7 }, () => {
  const small = continuationTime(2_000);
  const large = continuationTime(8_000);
  return { small, large, ratio: large / Math.max(small, 0.1) };
});
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const continuationSmall = median(continuationPairs.map((pair) => pair.small));
const continuationLarge = median(continuationPairs.map((pair) => pair.large));
const continuationRatio = median(continuationPairs.map((pair) => pair.ratio));
console.log(`64 B  continuation line 48k -> 192k: ${continuationSmall.toFixed(0)} -> ${continuationLarge.toFixed(0)} ms, ${continuationRatio.toFixed(1)}x median of 7 pairs (clean ~6.4x, whole-line regex ~11.5x)`);
if (continuationRatio > 7.5) failed = true;
if (failed) process.exit(1);
