import { performance } from "node:perf_hooks";
import process from "node:process";
import { createHighlighter, type HighlightContext, type Token } from "../src/index.js";
import { TokenizerRuntime } from "../src/runtime.js";

const lines: Record<string, string> = {
  typescript: "export const value: number = items.map((item) => item.id).length;\n", tsx: "export const View = () => <section aria-label=\"result\">ready</section>;\n",
  javascript: "export function add(a, b) { return a + b; }\n", jsx: "export const App = () => <main className=\"app\">ready</main>;\n",
  python: "def greet(name: str): return f\"hello {name}\"\n", shell: "printf '%s\\n' \"$HOME\" # output\n",
  json: "{\"ok\":true,\"count\":42,\"items\":[1,2,3]}\n", diff: "+const ready = true;\n",
  rust: "fn value(input: &str) -> usize { input.len() }\n", go: "func value(input string) int { return len(input) }\n",
  sql: "SELECT id, name FROM users WHERE active = true;\n", yaml: "message: hello world\n",
  css: ".card { color: red; padding: 1rem; }\n", html: "<article data-id=\"1\">hello</article>\n",
  markdown: "- **ready**: `true`\n", toml: "name = \"fulcrum\"\n", dockerfile: "RUN bun install --frozen-lockfile\n",
  c: "int value(const char *input) { return input[0]; }\n", cpp: "auto value = std::vector<int>{1, 2, 3};\n",
  java: "public int value(String input) { return input.length(); }\n", kotlin: "fun value(input: String) = input.length\n",
  swift: "func value(_ input: String) -> Int { input.count }\n", ruby: "def value(input) = input.length\n",
  php: "<?php function value($input) { return strlen($input); } ?>\n", lua: "local function value(input) return #input end\n",
  makefile: "build:\n\t@bun run build\n", ini: "status=ready\n", xml: "<status ready=\"true\" />\n",
  graphql: "query User { user { id name } }\n", protobuf: "message User { string id = 1; }\n",
};
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))];
const text = (tokens: Token[]) => tokens.map((token) => token.text).join("");
Bun.gc(true);
const memoryBefore = process.memoryUsage().heapUsed;
// A runtime answers plain until its grammar is warm (warm-up runs in the background, as in the worker).
const warmRuntime = async (language: string) => {
  const runtime = new TokenizerRuntime(() => {});
  await runtime.tokenize("x\n", language, { id: "load", version: 0, state: "done" });
  await runtime["warming"].get(language);
  return runtime;
};
const memoryRuntime = await warmRuntime("typescript");
const memoryCode = lines.typescript.repeat(2000);
const memoryTokens = await memoryRuntime.tokenize(memoryCode, "typescript", { id: "memory", version: 1, state: "done" });
Bun.gc(true);
const memoryMiB = (process.memoryUsage().heapUsed - memoryBefore) / 1024 / 1024;
if (text(memoryTokens) !== memoryCode) throw new Error("memory sample changed source");
console.log(`typescript-2000-line-heap-mib\t${memoryMiB.toFixed(2)}`);
memoryRuntime.dispose();
console.log("language\tfull-1000-lines-ms\tincremental-p95-ms");
for (const [language, line] of Object.entries(lines)) {
  const code = line.repeat(language === "makefile" ? 500 : 1000);
  const highlighter = await warmRuntime(language);
  await highlighter.tokenize(line, language, { id: `warm-${language}`, version: 0, state: "done" });
  const fullStart = performance.now();
  const full = await highlighter.tokenize(code, language, { id: `full-${language}`, version: 1, state: "done" });
  const fullMs = performance.now() - fullStart;
  if (!full || text(full) !== code) throw new Error(`${language}: full tokenization changed source`);
  let streamed = "";
  const increments: number[] = [];
  const count = language === "makefile" ? 500 : 1000;
  for (let index = 0; index < count; index++) {
    streamed += line;
    const start = performance.now();
    const tokens = await highlighter.tokenize(streamed, language, { id: `stream-${language}`, version: index, state: index === count - 1 ? "done" : "streaming" });
    increments.push(performance.now() - start);
    if (index === count - 1 && (!tokens || text(tokens) !== streamed)) throw new Error(`${language}: incremental tokenization changed source`);
  }
  console.log(`${language}\t${fullMs.toFixed(2)}\t${percentile(increments, 0.95).toFixed(3)}`);
  highlighter.dispose();
}

let handler: ((event: MessageEvent<{ requestId: number; tokens: Token[] }>) => void) | null = null;
const dispatch = createHighlighter({ workerFactory: () => ({
  onerror: null,
  get onmessage() { return handler; }, set onmessage(value) { handler = value; },
  terminate() {},
  postMessage(request: { requestId?: number; code?: string }) {
    if (request.requestId !== undefined) queueMicrotask(() => handler?.({ data: { requestId: request.requestId!, tokens: request.code ? [{ text: request.code }] : [] } } as MessageEvent<{ requestId: number; tokens: Token[] }>));
  },
}) });
const dispatchTimes: number[] = [];
for (let version = 0; version < 1000; version++) {
  const context: HighlightContext = { id: "dispatch", version, state: "streaming" };
  const start = performance.now();
  const result = dispatch(`line ${version}\n`, "typescript", context);
  dispatchTimes.push(performance.now() - start);
  await result;
}
dispatch.dispose();
console.log(`main-thread-dispatch-p95-ms\t${percentile(dispatchTimes, 0.95).toFixed(4)}`);
