import { createStreamingDocument } from "../packages/markdown/src/index.js";
import { PENDING_INLINE_SUFFIX_BUDGET } from "../packages/markdown/src/resolver.js";

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
  const trials = Array.from({ length: 5 }, (_, trial) => {
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
  const median = (key: "p95" | "p99" | "max") => trials.map((trial) => trial[key]).sort((a, b) => a - b)[2]!;
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
if (failsGate(millionByteParagraph) || millionByteParagraph.maxCopied > 1_024 + PENDING_INLINE_SUFFIX_BUDGET) failed = true;

const richPrefix = "**strong** *emphasis* `code` [link](https://example.com) [";
const richUnit = "plain **strong** and *emphasis* with `code`. ";
const millionByteRich = measure((richPrefix + richUnit.repeat(Math.ceil((1_000_000 - richPrefix.length) / richUnit.length))).slice(0, 1_000_000), 1_024);
console.log(`1024 B  ${"1 MB rich unresolved [".padEnd(22)} p95 ${millionByteRich.p95.toFixed(3)} ms  p99 ${millionByteRich.p99.toFixed(3)} ms  max ${millionByteRich.max.toFixed(3)} ms  work ${millionByteRich.workRatio.toFixed(2)}x  max-work ${millionByteRich.maxWork}  max-copy ${millionByteRich.maxCopied}`);
if (failsGate(millionByteRich) || millionByteRich.maxCopied > 1_024 + PENDING_INLINE_SUFFIX_BUDGET) failed = true;
if (failed) process.exit(1);
