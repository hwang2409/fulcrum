import { performance } from "node:perf_hooks";
import process from "node:process";
import { TokenizerRuntime } from "../dist/runtime.js";

const languages = ["csharp", "powershell", "dart", "scala", "clojure", "elixir", "erlang", "haskell", "ocaml", "zig", "nix", "terraform", "vue", "svelte", "astro", "r", "julia", "solidity", "graphql", "prisma"];
const runtime = new TokenizerRuntime(() => {});
const cold: number[] = [], warm: number[] = [];
for (const [index, language] of languages.entries()) {
  const context = { id: `measure-${language}`, version: 1, state: "done" as const };
  const start = performance.now();
  await runtime.tokenize("const value = 42;\n", language, context);
  cold.push(performance.now() - start);
  await runtime["warming"].get(language);
  const warmStart = performance.now();
  await runtime.tokenize("const value = 42;\n", language, { ...context, version: 2 });
  warm.push(performance.now() - warmStart);
  if (index === languages.length - 1) console.log("loaded", languages.length, "languages");
}
if (globalThis.Bun) Bun.gc(true);
console.log(JSON.stringify({ languages: languages.length, coldMedianMs: median(cold), warmMedianMs: median(warm), heapMiB: process.memoryUsage().heapUsed / 1024 / 1024, coldMs: cold, warmMs: warm }, null, 2));
function median(values: number[]) { return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!; }
runtime.dispose();
