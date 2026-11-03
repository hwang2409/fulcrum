import { createStreamingDocument } from "../packages/markdown/src/index.js";

const targetBytes = 100_000;
const deltaSizes = [1, 20, 200];

type Measurement = { p95: number; max: number; workRatio: number; maxWork: number };

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
  console.log(`work gate sensitivity: bounded ${boundedRatio.toFixed(2)}x passes; deliberate whole-container parser ${wholeContainerRatio.toFixed(2)}x fails`);
}

function measure(source: string, deltaSize: number): Measurement {
  let work: number[] = [];
  const trials = Array.from({ length: 3 }, (_, trial) => {
    const document = createStreamingDocument();
    const durations: number[] = [];
    const trialWork: number[] = [];
    for (let index = 0; index < source.length; index += deltaSize) {
      const before = document.stats.scannedCharacters;
      const start = performance.now();
      document.append(source.slice(index, index + deltaSize));
      document.render();
      durations.push(performance.now() - start);
      trialWork.push(document.stats.scannedCharacters - before);
    }
    if (trial === 0) work = trialWork;
    const sorted = durations.sort((a, b) => a - b);
    return { p95: sorted[Math.floor(durations.length * 0.95)]!, max: sorted.at(-1)! };
  });
  const median = (key: "p95" | "max") => trials.map((trial) => trial[key]).sort((a, b) => a - b)[1]!;
  return {
    p95: median("p95"),
    max: median("max"),
    workRatio: quarterRatio(work),
    maxWork: Math.max(...work),
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
  console.log(`${String(deltaSize).padStart(3)} B  ${name.padEnd(22)} p95 ${result.p95.toFixed(3)} ms  max ${result.max.toFixed(3)} ms  work ${result.workRatio.toFixed(2)}x  max-work ${result.maxWork}`);
  if (result.workRatio > 1.2 || result.p95 > 2) failed = true;
}
if (failed) process.exit(1);
