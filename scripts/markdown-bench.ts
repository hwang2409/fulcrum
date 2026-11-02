import { createStreamingDocument } from "../packages/markdown/src/index.js";

const targetBytes = 100_000;
const deltaSizes = [1, 20, 200];
const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
// Ratios below the clock's useful resolution measure timer noise, while the separate max gate still catches stalls.
const ratioFloorMs = 0.002;

type Measurement = { p95: number; max: number; ratio: number };

function measure(source: string, deltaSize: number): Measurement {
  const warm = createStreamingDocument();
  for (let index = 0; index < source.length; index += deltaSize) {
    warm.append(source.slice(index, index + deltaSize));
    warm.render();
  }
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
    const quarter = Math.max(1, Math.floor(samples.length / 4));
    return {
      p95: sorted[Math.floor(samples.length * 0.95)]!,
      max: sorted.at(-1)!,
      ratio: Math.max(average(samples.slice(-quarter)), ratioFloorMs) / Math.max(average(samples.slice(quarter, quarter * 2)), ratioFloorMs),
    };
  });
  const median = (key: keyof Measurement) => trials.map((trial) => trial[key]).sort((a, b) => a - b)[1]!;
  return { p95: median("p95"), max: median("max"), ratio: median("ratio") };
}

const shortParagraph = `${"streaming markdown stays bounded ".repeat(3)}\n\n`;
const cases = [
  ["many short paragraphs", shortParagraph.repeat(Math.ceil(targetBytes / shortParagraph.length)).slice(0, targetBytes)],
  ["long paragraph", "streaming markdown stays bounded ".repeat(Math.ceil(targetBytes / 33)).slice(0, targetBytes)],
  ["open fence", `\`\`\`ts\n${"const value = 1234567890;\n".repeat(Math.ceil(targetBytes / 26))}`.slice(0, targetBytes)],
  ["open table", `| check | result | time |\n| --- | --- | ---: |\n${"| package | passing | 1.2ms |\n".repeat(Math.ceil(targetBytes / 30))}`.slice(0, targetBytes)],
  ["long list", "- completed agent step\n".repeat(Math.ceil(targetBytes / 23)).slice(0, targetBytes)],
] as const;

console.log(`markdown stream benchmark: ${targetBytes} bytes`);
let failed = false;
for (const deltaSize of deltaSizes) for (const [name, source] of cases) {
  const result = measure(source, deltaSize);
  console.log(`${String(deltaSize).padStart(3)} B  ${name.padEnd(22)} p95 ${result.p95.toFixed(3)} ms  max ${result.max.toFixed(3)} ms  late/early ${result.ratio.toFixed(2)}x`);
  if (result.ratio > 1.2 || result.p95 > 2 || result.max >= 16) failed = true;
}
if (failed) process.exit(1);
