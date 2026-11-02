import { createStreamingDocument } from "../packages/markdown/src/index.js";

const targetBytes = 100_000;
const deltaSize = 20;
const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

function measure(name: string, source: string, ratioBudget: number, maxBudget = 8) {
  const trials = Array.from({ length: 3 }, () => {
    const document = createStreamingDocument();
    const samples: number[] = [];
    for (let index = 0; index < source.length; index += deltaSize) {
      const start = performance.now();
      document.append(source.slice(index, index + deltaSize));
      document.render();
      samples.push(performance.now() - start);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const quarter = Math.floor(samples.length / 4);
    return {
      p95: sorted[Math.floor(samples.length * 0.95)]!,
      max: sorted.at(-1)!,
      ratio: average(samples.slice(-quarter)) / average(samples.slice(quarter, quarter * 2)),
    };
  });
  const median = (key: keyof (typeof trials)[number]) => trials.map((trial) => trial[key]).sort((a, b) => a - b)[1]!;
  const p95 = median("p95");
  const max = median("max");
  const ratio = median("ratio");
  const failed = ratio > ratioBudget || p95 > 2 || max > maxBudget;
  console.log(`${name.padEnd(18)} p95 ${p95.toFixed(3)} ms  max ${max.toFixed(3)} ms  late/early ${ratio.toFixed(2)}x`);
  return failed;
}

const paragraph = `${"streaming markdown stays bounded ".repeat(3)}\n\n`;
const paragraphs = paragraph.repeat(Math.ceil(targetBytes / paragraph.length)).slice(0, targetBytes);
const longParagraph = "streaming markdown stays bounded ".repeat(Math.ceil(targetBytes / 33)).slice(0, targetBytes);
const fenceLine = "const value = 1234567890;\n";
const openFence = `\`\`\`ts\n${fenceLine.repeat(Math.ceil(targetBytes / fenceLine.length))}`.slice(0, targetBytes);
const tableRow = "| package | passing | 1.2ms |\n";
const openTable = `| check | result | time |\n| --- | --- | ---: |\n${tableRow.repeat(Math.ceil(targetBytes / tableRow.length))}`.slice(0, targetBytes);
const listItem = "- completed agent step\n";
const longList = listItem.repeat(Math.ceil(targetBytes / listItem.length)).slice(0, targetBytes);

console.log(`markdown stream benchmark: ${targetBytes} bytes, ${deltaSize}-byte deltas`);
let failed = false;
failed = measure("normal paragraphs", paragraphs, 2, Number.POSITIVE_INFINITY) || failed;
failed = measure("long paragraph", longParagraph, 1.5) || failed;
failed = measure("open fence", openFence, 1.5) || failed;
failed = measure("open table", openTable, 1.5) || failed;
failed = measure("long list", longList, 1.5) || failed;
if (failed) process.exit(1);
