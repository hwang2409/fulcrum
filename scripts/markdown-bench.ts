import { createStreamingDocument } from "../packages/markdown/src/index.js";

const targetBytes = 100_000;
const deltaSizes = [1, 20, 200];

type Measurement = { p95: number; p99: number; p999: number; max: number; total: number; workRatio: number; maxWork: number; maxCopied: number };
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
  const base = { p95: 1, p99: 2, p999: 3, max: 8, total: 10, workRatio: 1, maxWork: 1, maxCopied: 1 };
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
    const total = durations.reduce((sum, duration) => sum + duration, 0);
    const sorted = durations.sort((a, b) => a - b);
    return { p95: sorted[Math.floor(durations.length * 0.95)]!, p99: sorted[Math.floor(durations.length * 0.99)]!, p999: sorted[Math.floor(durations.length * 0.999)]!, max: sorted.at(-1)!, total };
  });
  const median = (key: "p95" | "p99" | "p999" | "max" | "total") => trials.map((trial) => trial[key]).sort((a, b) => a - b)[3]!;
  return {
    p95: median("p95"),
    p99: median("p99"),
    p999: median("p999"),
    max: median("max"),
    total: median("total"),
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
  console.log(`${String(deltaSize).padStart(3)} B  ${name.padEnd(22)} p95 ${result.p95.toFixed(3)} ms  p99 ${result.p99.toFixed(3)} ms  p999 ${result.p999.toFixed(3)} ms  max ${result.max.toFixed(3)} ms  work ${result.workRatio.toFixed(2)}x  max-work ${result.maxWork}  max-copy ${result.maxCopied}`);
  if (failsGate(result)) failed = true;
}
const millionByteParagraph = measure("a".repeat(1_000_000), 1_024);
console.log(`1024 B  ${"1 MB soft-wrapped paragraph".padEnd(22)} p95 ${millionByteParagraph.p95.toFixed(3)} ms  p99 ${millionByteParagraph.p99.toFixed(3)} ms  max ${millionByteParagraph.max.toFixed(3)} ms  work ${millionByteParagraph.workRatio.toFixed(2)}x  max-work ${millionByteParagraph.maxWork}  max-copy ${millionByteParagraph.maxCopied}`);
// The growing line re-parses its fixed provisional suffix (128 plus at most 64 characters of cut slack).
if (failsGate(millionByteParagraph) || millionByteParagraph.maxCopied > 1_024 + 128 + 64) failed = true;

// The newline that commits a long rich line parses it once; quadratic scans took 6-8 s at 1 MB.
const richUnit = "plain **strong** and *emphasis* with `code`. ";

// A growing 1 MB rich line copies only the delta plus the fixed pending suffix, whatever its markers do.
const PENDING_SUFFIX = 128;
const adversarialRows = [
  ["300k openers underscore", `${"*a ".repeat(100_000)}${"_x".repeat(200)}`],
  ["300k openers brackets", `${"*a ".repeat(100_000)}${"]x".repeat(200)}`],
  ["bracket over 300k openers", `[${"*a ".repeat(100_000)}]x`],
  ["30k openers underscore", `${"*a ".repeat(10_000)}${"_x".repeat(200)}`],
] as const;
for (const [name, source] of adversarialRows) {
  const result = measure(source, 1_024);
  console.log(`1024 B  ${name.padEnd(26)} p95 ${result.p95.toFixed(3)} ms  p99 ${result.p99.toFixed(3)} ms  p999 ${result.p999.toFixed(3)} ms  max ${result.max.toFixed(3)} ms  work ${result.workRatio.toFixed(2)}x  max-copy ${result.maxCopied}`);
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
  console.log(`1024 B  ${name.padEnd(22)} p95 ${result.p95.toFixed(3)} ms  p99 ${result.p99.toFixed(3)} ms  p999 ${result.p999.toFixed(3)} ms  max ${result.max.toFixed(3)} ms  total ${result.total.toFixed(1)} ms  max-copy ${result.maxCopied}`);
  if (result.p99 > 5 || result.p999 > 50 || result.maxCopied > 1_024 + PENDING_SUFFIX + 64) failed = true;
}

const totalTime = (source: string) => {
  const document = createStreamingDocument();
  const start = performance.now();
  for (let offset = 0; offset < source.length; offset += 1_024) {
    document.append(source.slice(offset, offset + 1_024));
    document.render();
  }
  return performance.now() - start;
};
const richSource = richUnit.repeat(Math.ceil(1_000_000 / richUnit.length)).slice(0, 1_000_000);
const fenceSource = `\`\`\`txt\n${"plain output line\n".repeat(60_000)}`.slice(0, 1_000_000);
const factorSamples = Array.from({ length: 7 }, (_, index) => {
  const measureFence = () => Array.from({ length: 12 }, () => totalTime(fenceSource)).reduce((sum, time) => sum + time, 0);
  if (index % 2) {
    const fence = measureFence();
    return totalTime(richSource) / fence;
  }
  const rich = totalTime(richSource);
  return rich / measureFence();
});
const constantFactorRatio = factorSamples.sort((a, b) => a - b)[3]!;
console.log(`rich-line constant-factor ratio: ${constantFactorRatio.toFixed(2)}x against 12 open-fence streams (limit 0.80x, median of 7 pairs)`);
if (constantFactorRatio > 0.8) failed = true;

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
// Report only: the gate is the 32x-span test in packages/markdown/test/closed-paragraphs.test.tsx.
console.log(`rich line commit growth 100k -> 1 MB: ${commitRatio.toFixed(1)}x (linear is ~10x)`);

// A continuation preview must append its delta and bounded provisional suffix without copying or scanning the whole
// line. This only reports the doubling ratios (clean is about 2.0x); the gates are the copy-count and flat-delta tests
// in packages/markdown/test/preview-performance.test.tsx, because a 2.3x doubling limit flaked on shared runners.
const continuationTimes = () => {
  const line = "word **b** `c` and more ".repeat(16_000);
  const document = createStreamingDocument();
  document.append("first line\n");
  const start = performance.now();
  const times: number[] = [];
  for (let offset = 0; offset < line.length; offset += 64) {
    document.append(line.slice(offset, offset + 64));
    document.render();
    if (offset + 64 === 96_000 || offset + 64 === 192_000 || offset + 64 === 384_000)
      times.push(performance.now() - start);
  }
  return times as [number, number, number];
};
continuationTimes(); // discarded warm-up
const continuationSamples = Array.from({ length: 7 }, continuationTimes);
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const continuationMedians = [0, 1, 2].map((index) => median(continuationSamples.map((sample) => sample[index]!)));
const continuationRatios = [
  median(continuationSamples.map(([small, medium]) => medium / small)),
  median(continuationSamples.map(([, medium, large]) => large / medium)),
];
console.log(`64 B  continuation line 96k -> 192k -> 384k: ${continuationMedians.map((time) => time.toFixed(0)).join(" -> ")} ms; doubling ${continuationRatios.map((ratio) => `${ratio.toFixed(2)}x`).join(", ")} (median of 7 pairs)`);
if (failed) process.exit(1);
