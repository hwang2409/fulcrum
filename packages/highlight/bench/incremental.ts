import { performance } from "node:perf_hooks";
const build = Bun.spawnSync(["bun", "src/build.ts"], { cwd: new URL("..", import.meta.url).pathname });
if (build.exitCode !== 0) throw new Error(build.stderr.toString());
const { TokenizerRuntime } = await import("../dist/runtime.js");

const line = "export const value: number = items.map((item) => item.id).length;\n";
const targets = new Set([100, 1_000, 5_000]);
const samples: number[] = [];
const runtime = new TokenizerRuntime();
let code = "";
await runtime.tokenize(line, "typescript", { id: "warm", version: 0, state: "done" }, false);
console.log("lines\tp50-ms\tp95-ms\tmax-ms");
for (let count = 1; count <= 5_000; count++) {
  code += line;
  const started = performance.now();
  await runtime.tokenize(code, "typescript", { id: "scaling", version: count, state: "streaming" }, false);
  samples.push(performance.now() - started);
  if (samples.length > 100) samples.shift();
  if (targets.has(count)) {
    const sorted = [...samples].sort((a, b) => a - b);
    const percentile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
    console.log(`${count}\t${percentile(0.5).toFixed(3)}\t${percentile(0.95).toFixed(3)}\t${sorted.at(-1)!.toFixed(3)}`);
  }
}
runtime.dispose();
