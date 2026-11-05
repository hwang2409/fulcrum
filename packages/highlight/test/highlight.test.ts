import { afterAll, describe, expect, jest, test } from "bun:test";
import type { Token } from "../src/index.js";
import type { RegexRecipeOptions } from "../src/regex.js";
import { semanticTheme } from "../src/scopes.js";

const { createHighlighter } = await import("../dist/index.js");
// Unit tests never depend on how fast this machine is: the clock stands still unless a test moves it, so no line is ever
// over the time limit by chance. Only a real worker (its own clock) runs on real time.
Object.defineProperty(performance, "now", { configurable: true, value: () => 0 });
const { TokenizerRuntime, regexFromRecipe } = await import("../dist/runtime.js");
// Every tokenize call on this (the main) thread. The page's thread must never tokenize: a test asserts this stays 0.
let mainThreadTokenizes = 0;
const tokenizeOnMainThread = TokenizerRuntime.prototype.tokenize;
TokenizerRuntime.prototype.tokenize = function (...args: Parameters<typeof tokenizeOnMainThread>) { mainThreadTokenizes++; return tokenizeOnMainThread.apply(this, args); };
// Tests that drive a runtime directly count their own calls; the shared highlighter runs a real worker.
const directHighlighter = createHighlighter();
afterAll(() => directHighlighter.dispose());

// A shared-worker grammar, warm: its first block is answered plain (cold, provisional), then once more, colored.
const warmed = new Map<string, Promise<void>>();
const warmLanguage = (language: string) => {
  if (!warmed.has(language)) warmed.set(language, (async () => {
    const context = { id: `warm-${language}`, version: 1, state: "done" as const };
    const updated = new Promise<void>((resolve) => { const stop = directHighlighter.subscribe(context.id, () => { stop(); resolve(); }); });
    await directHighlighter("x\n", language, context);
    await updated;
  })());
  return warmed.get(language)!;
};
// A runtime with `languages` warm, so a tokenize call tokenizes (a cold grammar answers plain).
async function warmRuntime(...languages: string[]) {
  const runtime = new TokenizerRuntime(() => {});
  for (const language of languages) {
    await runtime.tokenize("x\n", language, { id: `load-${language}`, version: 1, state: "done" });
    await runtime["warming"].get(language);
  }
  return runtime;
}

const samples: Record<string, string> = {
  typescript: "type User = { id: number };\nconst greet = (user: User) => `hi ${user.id}`;\n",
  tsx: "const View = () => <section aria-label=\"demo\">hello</section>;\n",
  javascript: "function add(a, b) { return a + b; }\n",
  jsx: "export const App = () => <main className=\"app\">ok</main>;\n",
  python: "def greet(name: str):\n    return f\"hello {name}\"\n",
  shell: "cat <<'EOF'\nhello $USER\nEOF\n",
  json: "{\"ok\": true, \"count\": 2}\n",
  diff: "--- a/file.ts\n+++ b/file.ts\n-old\n+new\n",
  rust: "/* outer\n * comment */\nfn main() { let n: u8 = 1; }\n",
  go: "package main\nfunc main() { println(\"hi\") }\n",
  sql: "SELECT id FROM users WHERE active = true;\n",
  yaml: "message: |\n  hello\n  world\n",
  css: ".card { color: red; }\n",
  html: "<article data-id=\"1\">hello</article>\n",
  markdown: "# title\n\n**bold** and `code`\n",
  toml: "[package]\nname = \"fulcrum\"\n",
  dockerfile: "FROM oven/bun:1\nRUN bun install\n",
  c: "#include <stdio.h>\nint main(void) { return 0; }\n",
  cpp: "#include <vector>\nstd::vector<int> values;\n",
  java: "class Main { public static void main(String[] args) {} }\n",
  kotlin: "fun main() = println(\"hello\")\n",
  swift: "let greeting: String = \"hello\"\n",
  ruby: "def greet(name)\n  puts \"hi #{name}\"\nend\n",
  php: "<?php echo \"hello\"; ?>\n",
  lua: "local value = 42\nprint(value)\n",
  makefile: "build:\n\tbun run build\n",
  ini: "[server]\nport=8080\n",
  xml: "<note id=\"1\">hello</note>\n",
  graphql: "query User { user { id name } }\n",
  protobuf: "message User { string id = 1; }\n",
};

const text = (tokens: Token[]) => tokens.map((token) => token.text).join("");
const embeddedSamples = {
  markdown: "```ts\nconst answer: number = 42;\n```\n\n```python\nvalue: int = 42\n```\n\n```not-a-language\nplain <text>\n```\n",
  html: "<script>const answer = 42;</script><style>.answer { color: red; }</style>\n",
  tsx: "const View = () => <section>{42}</section>;\n",
} as const;

let isolatedRuntimeId = 0;
async function finalRuntimeTokens(language: string, code: string, preload: string[] = []): Promise<Token[]> {
  let resolve!: (tokens: Token[]) => void;
  const final = new Promise<Token[]>((done) => { resolve = done; });
  const context = { id: `${language}-${++isolatedRuntimeId}`, version: 1, state: "done" as const };
  const runtime = new TokenizerRuntime((update, provenance, tokens) => {
    if (update.id === context.id && update.version === context.version && provenance.fullyLoaded) resolve(tokens);
  });
  for (const dependency of preload) {
    await runtime.tokenize("x\n", dependency, { id: `preload-${dependency}`, version: 1, state: "done" });
    await runtime["warming"].get(dependency);
  }
  const first = await runtime.tokenizeWithProvenance(code, context, language, 1);
  const tokens = first.provenance.fullyLoaded ? first.tokens : await final;
  runtime.dispose();
  return tokens;
}
type RecordedRequest = { requestId: number; code: string; grammar: { language: string; generation: number } };
const completeReply = (request: RecordedRequest, tokens: Token[]) => ({ requestId: request.requestId, tokens, provenance: { ...request.grammar, fullyLoaded: true }, completion: { status: "complete" as const } });
const viteConfig = 'import { defineConfig } from "vite";\nimport { resolve } from "node:path";\n\nexport default defineConfig({\n  build: { outDir: resolve("dist") },\n});\n';
const typedPerLine = (tokens: Token[]) => {
  const lines: boolean[] = [false];
  for (const token of tokens) token.text.split("\n").forEach((part, index) => {
    if (index) lines.push(false);
    if (part.trim() && token.type) lines[lines.length - 1] = true;
  });
  return lines;
};
// A real worker on the built worker.js whose replies are also recorded, so a test can wait for the reply it needs.
function recordingWorker(replies: unknown[]) {
  const worker = new Worker(new URL("../dist/worker.js", import.meta.url), { type: "module" });
  return {
    postMessage: (value: unknown) => worker.postMessage(value),
    terminate: () => worker.terminate(),
    onerror: null as ((event: ErrorEvent) => unknown) | null,
    set onmessage(handler: ((event: MessageEvent) => void) | null) { worker.onmessage = (event) => { replies.push(event.data); handler?.(event); }; },
    get onmessage() { return worker.onmessage; },
  };
}

async function full(language: string, code: string) {
  await warmLanguage(language);
  const context = { id: `full-${language}-${code}`, version: 1, state: "done" as const };
  await directHighlighter(code, language, context);
  await directHighlighter.awaitCompletion(context.id, context.version);
  return directHighlighter(code, language, context)! as Token[];
}

test("a cold reply records the language grammar that actually produced it", async () => {
  const runtime = new TokenizerRuntime(() => {});
  let resolveTypescript!: (value: unknown) => void;
  let resolveJavascript!: (value: unknown) => void;
  const loads = {
    typescript: new Promise((resolve) => { resolveTypescript = resolve; }),
    javascript: new Promise((resolve) => { resolveJavascript = resolve; }),
  };
  runtime["ensureLanguage"] = (language: keyof typeof loads) => loads[language] as never;
  const older = runtime.tokenizeWithProvenance("const older: number = 1;\n", { id: "provenance", version: 1, state: "streaming" }, "typescript", 1);
  const newer = runtime.tokenizeWithProvenance("const newer = 2;\n", { id: "provenance", version: 2, state: "streaming" }, "javascript", 1);
  resolveJavascript({});
  const newerReply = await newer as unknown as { provenance: { language: string; fullyLoaded: boolean } };
  resolveTypescript({});
  const olderReply = await older as unknown as { provenance: { language: string; fullyLoaded: boolean } };
  expect(newerReply.provenance).toMatchObject({ language: "javascript", fullyLoaded: false });
  expect(olderReply.provenance).toMatchObject({ language: "typescript", fullyLoaded: false });
  runtime.dispose();
});

describe("language and scope mapping", () => {
  for (const [language, code] of Object.entries(samples)) {
    test(`${language} reconstructs the exact source`, async () => {
      const tokens = await full(language, code);
      expect(text(tokens)).toBe(code);
    });
  }

  test("defines the representative textmate scope mappings", () => {
    const scopes = semanticTheme.settings.flatMap((rule) => typeof rule.scope === "string" ? [rule.scope] : rule.scope ?? []);
    for (const scope of ["comment", "keyword", "entity.name.type", "string.regexp", "string", "constant.numeric", "entity.name.function", "keyword.operator"])
      expect(scopes).toContain(scope);
  });

  test("diff additions and removals take precedence", async () => {
    const tokens = await full("diff", "+added\n-deleted\n");
    expect(tokens.find((token) => token.text.includes("added"))?.type).toBe("inserted");
    expect(tokens.find((token) => token.text.includes("deleted"))?.type).toBe("deleted");
  });
});

describe("incremental tokenization", () => {
  for (const [language, code] of Object.entries(samples)) {
    test(`${language} incremental output equals full output`, async () => {
      await warmLanguage(language);
      let streamed: Token[] | null = null;
      const lines = code.match(/.*(?:\n|$)/g)!.filter(Boolean);
      let input = "";
      for (let version = 0; version < lines.length; version++) {
        input += lines[version];
        streamed = await directHighlighter(input, language, { id: `incremental-${language}`, version, state: version === lines.length - 1 ? "done" : "streaming" });
      }
      expect(text(streamed!)).toBe(code);
    });
  }

  test("reuses the completed token prefix when a line is appended", async () => {
    const runtime = await warmRuntime("typescript");
    const first = await runtime.tokenize("const first = 1;\n", "typescript", { id: "prefix", version: 1, state: "streaming" });
    const second = await runtime.tokenize("const first = 1;\nconst second = 2;\n", "typescript", { id: "prefix", version: 2, state: "streaming" });
    expect(second[0]).toBe(first[0]);
    runtime.dispose();
  });

  test("returns exactly the streamed text when an incomplete line follows complete ones", async () => {
    await warmLanguage("diff");
    const highlighter = directHighlighter;
    const source = "--- a/run.ts\n+++ b/run.ts\n-const delay = 100;\n+const delay = 16;\n";
    for (let length = 1; length <= source.length; length++) {
      const code = source.slice(0, length);
      expect(text((await highlighter(code, "diff", { id: "tail", version: length, state: length === source.length ? "done" : "streaming" }))!)).toBe(code);
    }
  });

  // Regression: a cold grammar compiles its patterns while it tokenizes; that time made short lines look like runaway
  // lines, so they were cached as plain text (the gallery's vite.config.ts read lost the colors of line 1). In the worker
  // such a line is provisional: once the grammar is warm, the worker sends the block again, colored.
  test("a cold grammar colors every line once the worker's warm-up lands", async () => {
    const replies: Array<{ requestId?: number; provenance?: { fullyLoaded: boolean }; update?: unknown }> = [];
    const highlighter = createHighlighter({ workerFactory: () => recordingWorker(replies) });
    const source = viteConfig;
    for (const language of ["typescript", "javascript"]) {
      const context = { id: `cold-${language}`, version: 1, state: "done" as const };
      const updated = new Promise<void>((resolve) => { const stop = highlighter.subscribe(context.id, () => { stop(); resolve(); }); });
      const first = (await highlighter(source, language, context))!;
      expect(text(first)).toBe(source);
      // The handshake: a provisional reply is followed by one update for its block, which the cache then serves.
      const reply = replies.findLast((item) => item.requestId !== undefined)!;
      if (!reply.provenance?.fullyLoaded) await updated;
      if (!reply.provenance?.fullyLoaded) {
        await highlighter.awaitCompletion(context.id, context.version);
        const update = replies.findLast((item) => item.update && (item.update as { id: string }).id === context.id) as { tokens: Token[] };
        expect(highlighter(source, language, context)).toEqual(update.tokens);
      }
      const tokens = highlighter(source, language, context) as Token[];
      expect(Array.isArray(tokens)).toBe(true);
      expect(text(tokens)).toBe(source);
      // Every line colored is shown deterministically below ("re-sends each provisional block once"); here, on real
      // time, the colors only have to arrive.
      expect(tokens.some((token) => token.type)).toBe(true);
    }
    // Liveness for the controller's watchdog: the worker said it was compiling (null) and which block it tokenized.
    const progress = replies.filter((item) => "progress" in item).map((item) => (item as { progress: { id: string } | null }).progress?.id ?? null);
    expect([null, "cold-typescript", "cold-javascript"].every((id) => progress.includes(id))).toBe(true);
    highlighter.dispose();
  }, 60_000);

  test("a slow line still returns complete grammar tokens", async () => {
    const runtime = await warmRuntime("typescript");
    await runtime.tokenize("const warm = 1;\n", "typescript", { id: "warm", version: 1, state: "done" });
    const nowDescriptor = Object.getOwnPropertyDescriptor(performance, "now");
    let clock = 0;
    Object.defineProperty(performance, "now", { configurable: true, value: () => (clock += 50) });
    try {
      const tokens = await runtime.tokenize("const slow = 1;\n", "typescript", { id: "slow", version: 1, state: "done" });
      expect(tokens.some((token) => token.type)).toBe(true);
    } finally {
      if (nowDescriptor) Object.defineProperty(performance, "now", nowDescriptor);
      runtime.dispose();
    }
  });

  // Counts every tokenize attempt of a runtime; `extra` runs after each one.
  const countAttempts = async (language: string, extra?: () => void) => {
    const runtime = await warmRuntime(language);
    const highlighter = await runtime["ensureLanguage"](language);
    const attempt = highlighter.codeToTokensBase.bind(highlighter);
    const counter = { attempts: 0, runtime };
    highlighter.codeToTokensBase = (...args: Parameters<typeof attempt>) => { counter.attempts++; const result = attempt(...args); extra?.(); return result; };
    return counter;
  };

  // Regression: the retry after a slow attempt that built scanners had no bound, and markdown builds a scanner per
  // resolved dynamic end, so one such line ran up to seconds (and again on the main thread after the worker watchdog).
  test("a hostile markdown line stays exact", async () => {
    const unit = "*a* _b_ ";
    const line = unit.repeat(Math.floor(1000 / unit.length)) + "\n";
    const counter = await countAttempts("markdown");
    const tokens = await counter.runtime.tokenize(line, "markdown", { id: "hostile", version: 1, state: "done" });
    expect(text(tokens)).toBe(line);
    counter.runtime.dispose();
  });

  test("a recipe preserves converter emulation metadata", async () => {
    const { defaultJavaScriptRegexConstructor } = await import("@shikijs/engine-javascript");
    const converted = defaultJavaScriptRegexConstructor("(a)(?>b)", { target: "ES2024" }) as RegExp & { rawOptions?: RegexRecipeOptions };
    const restored = regexFromRecipe([converted.source, converted.flags, converted.rawOptions]);
    expect(restored.exec("ab")).toEqual(converted.exec("ab"));
  });

  // Root cause (PR #57): under CPU load, a plain `v`-flag recipe RegExp whose first exec reached Shiki's scanner cold
  // produced a missed match. Shiki's scanner reuses each regex's first search on a line (vscode-oniguruma behaviour), so
  // that first "no match" is cached and never retried: e.g. the TypeScript `(:)(?=\s*\S)` rule missed at `id:`, and
  // `id: number };` merged into one token. (No standalone wrong exec reproduced; the miss appears only through the full
  // scanner harness under load.) The fix warms every grammar regex with `exec("")` during warm-up, before any
  // real block reaches a scanner, so the scanner never sees a cold first exec. This guards that warming: every plain
  // grammar RegExp in the cache must have been exec'd during warm-up. It fails on the lazy path, where the
  // type-annotation recipes are never exec'd before the first real document.
  test("warm-up exec-warms every grammar regex so no scanner does a cold first exec", async () => {
    const execd = new Set<string>();
    const originalExec = RegExp.prototype.exec;
    RegExp.prototype.exec = function (this: RegExp, input: string) { execd.add(this.source); return originalExec.call(this, input); };
    try {
      for (const language of ["typescript", "cpp"]) {
        execd.clear();
        const runtime = new TokenizerRuntime(() => {});
        await runtime.tokenize("x\n", language, { id: "load", version: 1, state: "done" });
        await runtime["warming"].get(language);
        const cache = runtime["cache"] as Map<string, RegExp | Error> & { static: Map<string, RegExp | Error>; grammar: Set<string> };
        expect(cache.static.size).toBe(cache.grammar.size); // every grammar pattern compiled before any real block
        const coldPlain = [...cache.static.values()].filter((r): r is RegExp => r instanceof RegExp && r.constructor === RegExp && !execd.has(r.source));
        expect(coldPlain.map((r) => r.source)).toEqual([]); // none would be a cold first exec inside a scanner
        runtime.dispose();
      }
    } finally { RegExp.prototype.exec = originalExec; }
  }, 60_000);

  test("a warmed grammar tokenizes a document the same way twice", async () => {
    const documents = [["cpp", "#include <vector>\nstd::vector<int> values;\nint main() { return values.size(); }\n"], ["typescript", viteConfig]] as const;
    for (const [language, source] of documents) {
      const runtime = new TokenizerRuntime(() => {});
      await runtime.tokenize("x\n", language, { id: "load", version: 1, state: "done" });
      await runtime["warming"].get(language);
      const first = await runtime.tokenize(source, language, { id: "first", version: 1, state: "done" });
      const afterFirst = runtime.cacheSize();
      const second = await runtime.tokenize(source, language, { id: "second", version: 1, state: "done" });
      expect(text(first)).toBe(source);
      expect(second).toEqual(first);
      expect(runtime.cacheSize()).toEqual(afterFirst);
      runtime.dispose();
    }
  }, 60_000);

  // Regression: with a warm grammar, a slow attempt that built no scanner was final, so one pause of the thread (a
  // garbage collection, a busy CI runner) left a line plain for good (a write card's line 7 in CI, 5 of 48 loads).
  test("a line slowed once by a pause gets its retry and is colored", async () => {
    const nowDescriptor = Object.getOwnPropertyDescriptor(performance, "now");
    let clock = 0;
    // The pause hits the second line's first attempt (a first line always builds a scanner, so it always got a retry).
    const counter = await countAttempts("typescript", () => { if (counter.attempts === 2) clock += 30; });
    const source = "const a = 1;\nconst MAX_PENDING = 10_000;\n";
    // The same document once before, so the slow attempt below builds no scanner: only the pause made it slow.
    await counter.runtime.tokenize(source, "typescript", { id: "warm", version: 1, state: "done" });
    counter.attempts = 0;
    Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
    try {
      const tokens = await counter.runtime.tokenize(source, "typescript", { id: "paused", version: 1, state: "done" });
      expect(counter.attempts).toBe(2);
      expect(typedPerLine(tokens).slice(0, 2)).toEqual([true, true]);
    } finally {
      if (nowDescriptor) Object.defineProperty(performance, "now", nowDescriptor);
      counter.runtime.dispose();
    }
  });

  test("slow documents complete every line", async () => {
    const nowDescriptor = Object.getOwnPropertyDescriptor(performance, "now");
    let clock = 0;
    let counter: Awaited<ReturnType<typeof countAttempts>> | undefined;
    counter = await countAttempts("typescript", () => { clock += 12; });
    Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
    try {
      const lines = 50;
      const source = "const a = 1;\n".repeat(lines);
      const tokens = await counter.runtime.tokenize(source, "typescript", { id: "budget", version: 1, state: "done" });
      expect(typedPerLine(tokens).every((typed, index) => index >= lines || typed)).toBe(true);
      expect(counter.attempts).toBe(lines);
    } finally {
      if (nowDescriptor) Object.defineProperty(performance, "now", nowDescriptor);
      counter.runtime.dispose();
    }
  });

  test("keeps an incomplete line plain until it is complete", async () => {
    await warmLanguage("typescript");
    const highlighter = directHighlighter;
    const partial = await highlighter("const value", "typescript", { id: "partial", version: 1, state: "streaming" });
    expect(partial).toEqual([{ text: "const value" }]);
    const complete = await highlighter("const value = 1;\n", "typescript", { id: "partial", version: 2, state: "streaming" });
    expect(text(complete!)).toBe("const value = 1;\n");
  });
});

// Worker liveness and restarts, on fake timers and a scripted worker: no test here waits on the wall clock.
describe("worker liveness and restarts", () => {
  type Request = { requestId: number; code: string; context: { id: string }; grammar: { language: string; generation: number } };
  type Scripted = {
    posted: Request[]; terminated: boolean; send(data: unknown): void; crash(kind?: "error" | "messageerror"): void;
    onmessage: ((event: MessageEvent<never>) => void) | null; onerror: ((event: ErrorEvent) => unknown) | null; onmessageerror: ((event: MessageEvent) => unknown) | null;
    postMessage(value: Request): void; terminate(): void;
  };
  const scripted = (into: Scripted[]) => {
    const worker: Scripted = {
      posted: [], terminated: false, onmessage: null, onerror: null, onmessageerror: null,
      postMessage(value) { worker.posted.push(value); }, terminate() { worker.terminated = true; },
      send(data) { worker.onmessage?.({ data } as MessageEvent<never>); },
      crash(kind = "error") { if (kind === "error") worker.onerror?.(new ErrorEvent("error")); else worker.onmessageerror?.(new MessageEvent("messageerror")); },
    };
    into.push(worker);
    return worker;
  };
  const colored = (code: string): Token[] => [{ text: code, type: "keyword" }];
  const provenance = (worker: Scripted, index: number, fullyLoaded: boolean) => ({ ...worker.posted[index].grammar, fullyLoaded });
  const answer = (worker: Scripted, index: number) => worker.send({ requestId: worker.posted[index].requestId, tokens: colored(worker.posted[index].code), provenance: provenance(worker, index, true), completion: { status: "complete" } });
  const block = (id: string) => ({ id, version: 1, state: "done" as const });
  const ticks = async () => { for (let i = 0; i < 3; i++) await Promise.resolve(); };
  const withFakeTimers = (run: () => Promise<void>) => async () => { jest.useFakeTimers(); try { await run(); } finally { jest.useRealTimers(); } };

  test("a streaming revision completes when its non-provisional worker result arrives", async () => {
    const workers: Scripted[] = [];
    const highlighter = createHighlighter({ workerFactory: () => scripted(workers) });
    const result = highlighter("const one = 1;\n", "typescript", { id: "stream", version: 1, state: "streaming" });
    answer(workers[0], 0);
    expect(await highlighter.awaitCompletion("stream", 1)).toEqual({ version: 1, status: "complete" });
    expect(await result).toEqual(colored("const one = 1;\n"));
    highlighter.dispose();
  });

  test("a superseded streaming revision keeps its exact completion", async () => {
    const workers: Scripted[] = [];
    const highlighter = createHighlighter({ workerFactory: () => scripted(workers) });
    const first = highlighter("const one = 1;\n", "typescript", { id: "stream", version: 1, state: "streaming" });
    answer(workers[0], 0);
    const second = highlighter("const two = 2;\n", "typescript", { id: "stream", version: 2, state: "streaming" });
    answer(workers[0], 1);
    expect(await highlighter.awaitCompletion("stream", 1)).toEqual({ version: 1, status: "complete" });
    // The visible promise follows the newest revision; the exact v1 result is retained by its completion record above.
    expect(await first).toEqual(colored("const two = 2;\n"));
    expect(await second).toEqual(colored("const two = 2;\n"));
    highlighter.dispose();
  });

  test("a provisional streaming revision completes on its cold update", async () => {
    const workers: Scripted[] = [];
    const highlighter = createHighlighter({ workerFactory: () => scripted(workers) });
    const result = highlighter("const cold = 1;\n", "typescript", { id: "cold-stream", version: 1, state: "streaming" });
    workers[0].send({ requestId: workers[0].posted[0].requestId, tokens: [{ text: "const cold = 1;\n" }], provenance: provenance(workers[0], 0, false), completion: { status: "pending" }, of: 1 });
    const completion = highlighter.awaitCompletion("cold-stream", 1);
    let settled = false;
    completion.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    workers[0].send({ update: { id: "cold-stream", version: 1, state: "streaming" }, provenance: provenance(workers[0], 0, true), tokens: colored("const cold = 1;\n"), of: 2 });
    expect(await completion).toEqual({ version: 1, status: "complete" });
    expect(await result).toEqual([{ text: "const cold = 1;\n" }]);
    highlighter.dispose();
  });

  test("back-to-back cold revisions supersede the older revision and complete the latest", async () => {
    const workers: Scripted[] = [];
    const highlighter = createHighlighter({ workerFactory: () => scripted(workers) });
    const firstCode = "const first: number = 1;\n";
    const secondCode = "const second: number = 2;\n";
    highlighter(firstCode, "typescript", { id: "cold-pair", version: 1, state: "streaming" });
    workers[0].send({ requestId: workers[0].posted[0].requestId, tokens: [{ text: firstCode }], provenance: provenance(workers[0], 0, false), completion: { status: "pending" }, of: 1 });
    highlighter(secondCode, "typescript", { id: "cold-pair", version: 2, state: "streaming" });
    workers[0].send({ requestId: workers[0].posted[1].requestId, tokens: [{ text: secondCode }], provenance: provenance(workers[0], 1, false), completion: { status: "pending" }, of: 2 });
    workers[0].send({ update: { id: "cold-pair", version: 2, state: "streaming" }, provenance: provenance(workers[0], 1, true), tokens: colored(secondCode), of: 3 });
    expect(await highlighter.awaitCompletion("cold-pair", 1)).toEqual({ version: 1, status: "superseded" });
    expect(await highlighter.awaitCompletion("cold-pair", 2)).toEqual({ version: 2, status: "complete" });
    expect(highlighter(secondCode, "typescript", { id: "cold-pair", version: 2, state: "streaming" })).toEqual(colored(secondCode));
    highlighter.dispose();
  });

  test("a language change supersedes the cold old language without calling its plain reply complete", async () => {
    const workers: Scripted[] = [];
    const highlighter = createHighlighter({ workerFactory: () => scripted(workers) });
    const oldCode = "const value: number = 1;\n";
    const newCode = "const value = 2;\n";
    const expected = await full("javascript", newCode);
    highlighter(oldCode, "typescript", { id: "language-change", version: 1, state: "streaming" });
    highlighter(newCode, "javascript", { id: "language-change", version: 2, state: "streaming" });
    workers[0].send({ requestId: workers[0].posted[1].requestId, tokens: expected, provenance: provenance(workers[0], 1, true), completion: { status: "complete" }, of: 1 });
    workers[0].send({ requestId: workers[0].posted[0].requestId, tokens: [{ text: oldCode }], provenance: provenance(workers[0], 0, false), completion: { status: "pending" }, of: 2 });
    expect(await highlighter.awaitCompletion("language-change", 1)).toEqual({ version: 1, status: "superseded" });
    expect(await highlighter.awaitCompletion("language-change", 2)).toEqual({ version: 2, status: "complete" });
    expect(highlighter(newCode, "javascript", { id: "language-change", version: 2, state: "streaming" })).toEqual(expected);
    highlighter.dispose();
  });

  test("a revision completed before a newer version stays complete", async () => {
    const workers: Scripted[] = [];
    const highlighter = createHighlighter({ workerFactory: () => scripted(workers) });
    highlighter("one\n", "typescript", { id: "already-complete", version: 1, state: "streaming" });
    answer(workers[0], 0);
    expect(await highlighter.awaitCompletion("already-complete", 1)).toEqual({ version: 1, status: "complete" });
    highlighter("two\n", "typescript", { id: "already-complete", version: 2, state: "streaming" });
    expect(await highlighter.awaitCompletion("already-complete", 1)).toEqual({ version: 1, status: "complete" });
    answer(workers[0], 1);
    highlighter.dispose();
  });

  test("a superseded notice cannot duplicate the current streaming request", async () => {
    const workers: Scripted[] = [];
    const highlighter = createHighlighter({ workerFactory: () => scripted(workers) });
    let code = "one\n";
    let context = { id: "no-waste", version: 1, state: "streaming" as const };
    highlighter.subscribe(context.id, () => { highlighter(code, "typescript", context); });
    highlighter(code, "typescript", context);
    workers[0].send({ requestId: workers[0].posted[0].requestId, tokens: [{ text: code }], provenance: provenance(workers[0], 0, false), completion: { status: "pending" }, of: 1 });
    code = "one\ntwo\n";
    context = { id: "no-waste", version: 2, state: "streaming" };
    highlighter(code, "typescript", context);
    await Promise.resolve();
    expect(workers[0].posted).toHaveLength(2);
    highlighter.dispose();
  });

  test("disposing after a cold reply settles its revision", async () => {
    const workers: Scripted[] = [];
    const highlighter = createHighlighter({ workerFactory: () => scripted(workers) });
    const code = "const pending = 1;\n";
    const result = highlighter(code, "typescript", { id: "dispose-cold", version: 1, state: "streaming" });
    workers[0].send({ requestId: workers[0].posted[0].requestId, tokens: [{ text: code }], provenance: provenance(workers[0], 0, false), completion: { status: "pending" }, of: 1 });
    await result;
    const completion = highlighter.awaitCompletion("dispose-cold", 1);
    highlighter.dispose();
    expect(await completion).toEqual({ version: 1, status: "unavailable", reason: "worker" });
  });

  test("random version, language, cold-load, and restart interleavings settle every revision", withFakeTimers(async () => {
    const workers: Scripted[] = [];
    const highlighter = createHighlighter({ workerFactory: () => scripted(workers) });
    const completions: Array<Promise<{ version: number; status: string }>> = [];
    let random = 0x53;
    const next = () => (random = (random * 1664525 + 1013904223) >>> 0);
    for (let version = 1; version <= 32; version++) {
      const language = next() & 1 ? "typescript" : "javascript";
      const code = `${language} value${version} = ${version};\n`;
      highlighter(code, language, { id: "property", version, state: "streaming" });
      completions.push(highlighter.awaitCompletion("property", version));
      const active = workers.at(-1)!;
      const index = active.posted.length - 1;
      if (version < 32 && (version === 16 || next() & 1)) active.send({ requestId: active.posted[index].requestId, tokens: [{ text: code }], provenance: provenance(active, index, false), completion: { status: "pending" }, of: version });
      else answer(active, index);
      if (version === 16) { active.crash(); jest.advanceTimersByTime(250); }
    }
    await ticks();
    const settled = await Promise.all(completions);
    expect(settled.slice(0, -1).every((item) => item.status !== "pending")).toBe(true);
    expect(settled.at(-1)).toEqual({ version: 32, status: "complete" });
    highlighter.dispose();
  }));

  test("steady progress for 30 s of long work never restarts the worker", withFakeTimers(async () => {
    const workers: Scripted[] = [];
    const highlighter = createHighlighter({ workerFactory: () => scripted(workers) });
    const result = highlighter("int main() {}\n", "cpp", block("long"));
    for (let elapsed = 0; elapsed < 30_000; elapsed += 100) {
      jest.advanceTimersByTime(100);
      workers[0].send({ progress: workers[0].posted[0].context });
    }
    expect(workers.map((worker) => worker.terminated)).toEqual([false]);
    answer(workers[0], 0);
    expect(await result).toEqual(colored("int main() {}\n"));
    highlighter.dispose();
  }));

  test("a silent request is blamed: it stays plain, the others and new requests still color", withFakeTimers(async () => {
    const workers: Scripted[] = [];
    let told = 0;
    const highlighter = createHighlighter({ workerFactory: () => scripted(workers), onHighlightUnavailable: () => told++ });
    const stuck = highlighter("a\n", "cpp", block("stuck"));
    const waiting = highlighter("b\n", "cpp", block("waiting"));
    workers[0].send({ progress: workers[0].posted[0].context });
    jest.advanceTimersByTime(4_999);
    expect(workers.length).toBe(1);
    jest.advanceTimersByTime(1);
    expect(workers[0].terminated).toBe(true);
    jest.advanceTimersByTime(0);
    expect(workers.length).toBe(2);
    expect(workers[1].posted.map((request) => request.context.id)).toEqual(["waiting"]); // the blamed one is never retried
    expect(await stuck).toEqual([{ text: "a\n" }]);
    answer(workers[1], 0);
    expect(await waiting).toEqual(colored("b\n"));
    const next = highlighter("c\n", "cpp", block("next"));
    answer(workers[1], 1);
    expect(await next).toEqual(colored("c\n"));
    // Only the blamed revision stays plain in this controller: a newer revision of the same block is tried again.
    expect(highlighter("a\n", "cpp", block("stuck"))).toEqual([{ text: "a\n" }]);
    expect(workers[1].posted.length).toBe(2);
    const revised = highlighter("a\nmore\n", "cpp", { id: "stuck", version: 2, state: "done" });
    answer(workers[1], 2);
    expect(await revised).toEqual(colored("a\nmore\n"));
    await ticks();
    expect(told).toBe(0);
    highlighter.dispose();
  }));

  test("silence poisons only the blamed revision: another pending revision of the same block is retried and colored", withFakeTimers(async () => {
    const workers: Scripted[] = [];
    const highlighter = createHighlighter({ workerFactory: () => scripted(workers) });
    const stale = highlighter("a\n", "cpp", { id: "surface", version: 1, state: "streaming" });
    const newer = highlighter("a\nb\n", "cpp", { id: "surface", version: 2, state: "done" });
    workers[0].send({ progress: workers[0].posted[0].context });
    jest.advanceTimersByTime(5_000);
    jest.advanceTimersByTime(0);
    expect(workers.length).toBe(2);
    expect(workers[1].posted.map((request) => request.code)).toEqual(["a\nb\n"]);
    answer(workers[1], 0);
    expect(await newer).toEqual(colored("a\nb\n"));
    expect(await stale).toEqual(colored("a\nb\n")); // an older revision resolves to the newest one, as without a hang
    highlighter.dispose();
  }));

  test("silence with no block to blame is a crash: the worker restarts and gets the request again", withFakeTimers(async () => {
    const workers: Scripted[] = [];
    const highlighter = createHighlighter({ workerFactory: () => scripted(workers) });
    const result = highlighter("x\n", "cpp", block("quiet"));
    jest.advanceTimersByTime(5_000 + 250);
    expect(workers.length).toBe(2);
    answer(workers[1], 0);
    expect(await result).toEqual(colored("x\n"));
    highlighter.dispose();
  }));

  test("3 crashes in 60 s recover with backoff; a 4th leaves plain text for good and tells the app once", withFakeTimers(async () => {
    const before = mainThreadTokenizes;
    const workers: Scripted[] = [];
    let told = 0;
    const highlighter = createHighlighter({ workerFactory: () => scripted(workers), onHighlightUnavailable: () => told++ });
    const result = highlighter("one\n", "python", block("one"));
    for (const [index, backoff] of [250, 1_000, 4_000].entries()) {
      workers.at(-1)!.crash(index === 1 ? "messageerror" : "error");
      jest.advanceTimersByTime(backoff - 1);
      expect(workers.length).toBe(index + 1);
      jest.advanceTimersByTime(1);
      expect(workers.length).toBe(index + 2);
      expect(workers.at(-1)!.posted.map((request) => request.context.id)).toEqual(["one"]);
    }
    answer(workers[3], 0);
    expect(await result).toEqual(colored("one\n"));
    const last = highlighter("two\n", "python", block("two"));
    workers[3].crash();
    expect(await last).toEqual([{ text: "two\n" }]);
    expect(highlighter("three\n", "python", block("three"))).toEqual([{ text: "three\n" }]);
    jest.advanceTimersByTime(60_000);
    await ticks();
    expect({ built: workers.length, told, tokenized: mainThreadTokenizes - before }).toEqual({ built: 4, told: 1, tokenized: 0 });
    highlighter.dispose();
  }));

  test("a long reply arrives in parts and is joined in order, without leaking into the next reply", withFakeTimers(async () => {
    const workers: Scripted[] = [];
    const highlighter = createHighlighter({ workerFactory: () => scripted(workers) });
    const long = highlighter("abc", "cpp", block("parts"));
    const short = highlighter("d", "cpp", block("short"));
    const [first, second] = workers[0].posted;
    workers[0].send({ part: [{ text: "a", type: "keyword" }], of: 1 });
    workers[0].send({ part: [{ text: "b" }], of: 1 });
    workers[0].send({ requestId: first.requestId, tokens: [{ text: "c", type: "string" }], provenance: provenance(workers[0], 0, true), completion: { status: "complete" }, of: 1 });
    workers[0].send({ requestId: second.requestId, tokens: [{ text: "d" }], provenance: provenance(workers[0], 1, true), completion: { status: "complete" }, of: 2 });
    expect(await long).toEqual([{ text: "a", type: "keyword" }, { text: "b" }, { text: "c", type: "string" }]);
    expect(await short).toEqual([{ text: "d" }]);
    highlighter.dispose();
  }));

  test("parts of two results may interleave: each joins only its own parts", withFakeTimers(async () => {
    const workers: Scripted[] = [];
    const highlighter = createHighlighter({ workerFactory: () => scripted(workers) });
    const one = highlighter("abc", "cpp", block("one"));
    const two = highlighter("xyz", "cpp", block("two"));
    const [first, second] = workers[0].posted;
    workers[0].send({ part: [{ text: "a", type: "keyword" }], of: 1 });
    workers[0].send({ part: [{ text: "x" }], of: 2 });
    workers[0].send({ part: [{ text: "b" }], of: 1 });
    workers[0].send({ requestId: second.requestId, tokens: [{ text: "yz", type: "string" }], provenance: provenance(workers[0], 1, true), completion: { status: "complete" }, of: 2 });
    workers[0].send({ requestId: first.requestId, tokens: [{ text: "c" }], provenance: provenance(workers[0], 0, true), completion: { status: "complete" }, of: 1 });
    expect(await two).toEqual([{ text: "x" }, { text: "yz", type: "string" }]);
    expect(await one).toEqual([{ text: "a", type: "keyword" }, { text: "b" }, { text: "c" }]);
    highlighter.dispose();
  }));

  test("a long reply's parts are paced: the page acks one part per animation frame, and owing an ack is not silence", withFakeTimers(async () => {
    const frames: Array<() => void> = [];
    const native = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((run: () => void) => frames.push(run)) as typeof requestAnimationFrame;
    try {
      const workers: Scripted[] = [];
      const highlighter = createHighlighter({ workerFactory: () => scripted(workers) });
      const long = highlighter("abc", "cpp", block("paced"));
      const worker = workers[0];
      const acks = () => (worker.posted as unknown[]).filter((value) => (value as { type?: string }).type === "ack").length;
      worker.send({ progress: worker.posted[0].context });
      worker.send({ part: [{ text: "a", type: "keyword" }], of: 1 });
      expect(acks()).toBe(0); // not in the message's own task
      jest.advanceTimersByTime(30_000); // a hidden tab runs no frames: the worker waits on the page, it is not hung
      expect(workers.length).toBe(1);
      const run = () => frames.splice(0).forEach((frame) => frame());
      run();
      expect(acks()).toBe(1);
      run();
      expect(acks()).toBe(1); // one ack per part, never more
      worker.send({ part: [{ text: "b" }], of: 1 });
      run();
      expect(acks()).toBe(2);
      worker.send({ requestId: worker.posted[0].requestId, tokens: [{ text: "c" }], provenance: provenance(worker, 0, true), completion: { status: "complete" }, of: 1 });
      expect(await long).toEqual([{ text: "a", type: "keyword" }, { text: "b" }, { text: "c" }]);
      expect(frames.length).toBe(0);
      highlighter.dispose();
    } finally { globalThis.requestAnimationFrame = native; }
  }));

  test("crashes spread out over time keep recovering", withFakeTimers(async () => {
    const workers: Scripted[] = [];
    let told = 0;
    const highlighter = createHighlighter({ workerFactory: () => scripted(workers), onHighlightUnavailable: () => told++ });
    for (let crash = 0; crash < 6; crash++) {
      const code = `round${crash}\n`;
      const result = highlighter(code, "python", block(`spread-${crash}`));
      workers.at(-1)!.crash();
      jest.advanceTimersByTime(250);
      expect(workers.length).toBe(crash + 2);
      const worker = workers.at(-1)!;
      for (let index = 0; index < worker.posted.length; index++) answer(worker, index);
      expect(await result).toEqual(colored(code));
      jest.advanceTimersByTime(61_000); // nothing pending: no watchdog runs
    }
    await ticks();
    expect(told).toBe(0);
    highlighter.dispose();
  }));
});

test("the worker sends the next part of a long result only after the page acks the one before", async () => {
  const worker = new Worker(new URL("../dist/worker.js", import.meta.url), { type: "module" });
  const messages: Array<Record<string, unknown>> = [];
  worker.onmessage = (event) => { if (!("progress" in event.data)) messages.push(event.data); };
  const until = async (done: () => boolean) => { for (let wait = 0; !done(); wait++) { if (wait > 3_000) throw new Error("timed out"); await Bun.sleep(10); } };
  const parts = () => messages.filter((message) => "part" in message).length;
  const code = "[1, 2, 3, 4, 5, 6],\n".repeat(5_000); // over 16,384 tokens: more than one part
  worker.postMessage({ type: "highlight", requestId: 1, code, grammar: { language: "json", generation: 1 }, context: { id: "paced", version: 1, state: "done" } });
  await until(() => parts() === 1);
  await Bun.sleep(200);
  expect(parts()).toBe(1);
  let acked = 0;
  while ("part" in messages.at(-1)!) {
    const seen = messages.length;
    worker.postMessage({ type: "ack" });
    acked++;
    await until(() => messages.length > seen);
    expect(messages.length).toBe(seen + 1); // one message per ack
  }
  expect(acked).toBe(parts());
  expect(acked).toBeGreaterThan(1);
  const final = messages.at(-1)!;
  expect(text([...messages.flatMap((message) => (message.part ?? []) as Token[]), ...(final.tokens as Token[])])).toBe(code);
  worker.terminate();
}, 30_000);

test("a small reply waits behind at most one part of a long result", async () => {
  const worker = new Worker(new URL("../dist/worker.js", import.meta.url), { type: "module" });
  const messages: Array<Record<string, unknown>> = [];
  worker.onmessage = (event) => { if (!("progress" in event.data)) messages.push(event.data); };
  const until = async (done: () => boolean) => { for (let wait = 0; !done(); wait++) { if (wait > 3_000) throw new Error("timed out"); await Bun.sleep(10); } };
  const code = "[1, 2, 3, 4, 5, 6],\n".repeat(10_000); // several parts
  // In a fresh worker json is cold: the reply is plain at once, and the colors come as an update, in parts.
  worker.postMessage({ type: "highlight", requestId: 1, code, grammar: { language: "json", generation: 1 }, context: { id: "long", version: 1, state: "done" } });
  await until(() => messages.some((message) => "part" in message));
  const of = messages.at(-1)!.of;
  const seen = messages.length;
  worker.postMessage({ type: "highlight", requestId: 2, code: "[1]\n", grammar: { language: "json", generation: 1 }, context: { id: "small", version: 1, state: "done" } });
  await Bun.sleep(200);
  expect(messages.length).toBe(seen); // the page has not acked the part: nothing else is sent, the small reply included
  worker.postMessage({ type: "ack" });
  await until(() => messages.length > seen);
  expect(messages[seen]).toMatchObject({ requestId: 2 }); // the small reply goes before the long result's next part
  expect(messages[seen]!.of).not.toBe(of);
  while (!("update" in messages.at(-1)!)) {
    const count = messages.length;
    worker.postMessage({ type: "ack" });
    await until(() => messages.length > count);
  }
  const long = messages.filter((message) => message.of === of);
  expect(text(long.flatMap((message) => (message.part ?? message.tokens) as Token[]))).toBe(code);
  worker.terminate();
}, 30_000);

describe("identity, failure, and caps", () => {
  test("never confuses same-length blocks", async () => {
    await warmLanguage("typescript");
    const highlighter = directHighlighter;
    const left = await highlighter("const a = 1;\n", "typescript", { id: "left", version: 1, state: "done" });
    const right = await highlighter("const b = 2;\n", "typescript", { id: "right", version: 1, state: "done" });
    expect(text(left!)).not.toBe(text(right!));
  });

  test("unknown and oversized input use exact plain fallback", async () => {
    await warmLanguage("typescript");
    const highlighter = directHighlighter;
    expect(highlighter("hello", "unknown")).toBeNull();
    const huge = "x".repeat(512 * 1024 + 1);
    expect(await highlighter(huge, "typescript", { id: "huge", version: 1, state: "done" })).toEqual([{ text: huge }]);
    const long = `${"x".repeat(20_001)}\nconst ok = 1;\n`;
    expect(text((await highlighter(long, "typescript", { id: "long", version: 1, state: "done" }))!)).toBe(long);
  }, 10_000);

  // A worker that fails at its first request, as a crash does.
  const crashingWorker = () => {
    const worker: { onmessage: ((event: MessageEvent<never>) => void) | null; onerror: ((event: ErrorEvent) => unknown) | null; postMessage(): void; terminate(): void } = {
      onmessage: null, onerror: null, terminate() {}, postMessage() { queueMicrotask(() => worker.onerror?.(new ErrorEvent("error"))); },
    };
    return worker;
  };
  const updateOf = (highlighter: { subscribe(id: string, listener: () => void): () => void }, id: string) =>
    new Promise<void>((resolve) => { const stop = highlighter.subscribe(id, () => { stop(); resolve(); }); });

  test("a crashed worker is restarted once, gets the pending request again, and the colors still arrive", async () => {
    const before = mainThreadTokenizes;
    let built = 0;
    const highlighter = createHighlighter({ workerFactory: () => ++built === 1 ? crashingWorker() : recordingWorker([]) });
    const context = { id: "restarted", version: 1, state: "done" as const };
    const updated = updateOf(highlighter, context.id);
    expect(text((await highlighter(samples.python, "python", context))!)).toBe(samples.python);
    await updated; // the new worker answered the replayed request plain (cold), then colored once warm
    const tokens = highlighter(samples.python, "python", context) as Token[];
    expect(text(tokens)).toBe(samples.python);
    expect(tokens.some((token) => token.type)).toBe(true);
    expect(built).toBe(2);
    expect(mainThreadTokenizes).toBe(before);
    highlighter.dispose();
  }, 30_000);

  test("without a Worker (ssr, tests) or when one cannot be built (a strict csp), blocks are exact plain text", async () => {
    const before = mainThreadTokenizes;
    const code = samples.typescript;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker")!;
    delete (globalThis as { Worker?: unknown }).Worker;
    let told = 0;
    try {
      const highlighter = createHighlighter({ onHighlightUnavailable: () => told++ });
      expect(highlighter(code, "typescript", { id: "no-worker", version: 1, state: "done" })).toEqual([{ text: code }]);
      highlighter.dispose();
    } finally { Object.defineProperty(globalThis, "Worker", descriptor); }
    await Promise.resolve();
    expect(told).toBe(1);
    // A worker that cannot be built is a crash: it is tried again with backoff (250 ms, 1 s, 4 s), then plain for good.
    jest.useFakeTimers();
    try {
      let built = 0;
      const blocked = createHighlighter({ workerFactory: () => { built++; throw new Error("blocked by csp"); }, onHighlightUnavailable: () => told++ });
      const result = blocked(code, "typescript", { id: "csp", version: 1, state: "done" });
      jest.advanceTimersByTime(250 + 1_000 + 4_000);
      expect(await result).toEqual([{ text: code }]);
      expect(blocked(code, "typescript", { id: "csp-after", version: 1, state: "done" })).toEqual([{ text: code }]);
      await Promise.resolve();
      expect({ built, told, tokenized: mainThreadTokenizes - before }).toEqual({ built: 4, told: 2, tokenized: 0 });
      blocked.dispose();
    } finally { jest.useRealTimers(); }
  });

  // The page's thread must never tokenize: one cold regex or scanner compile cannot be split. Only the worker may reach
  // the tokenizer runtime or shiki; nothing the package entry imports, statically or lazily, may.
  test("the package entry never imports the tokenizer runtime", async () => {
    const src = new URL("../src/", import.meta.url);
    const seen = new Set<string>();
    const external = new Set<string>();
    const queue = ["index.ts"];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const [, spec] of (await Bun.file(new URL(file, src)).text()).matchAll(/(?:from|import\(?)\s*["']([^"']+)["']/g)) {
        if (spec!.startsWith("./")) queue.push(spec!.slice(2).replace(/\.js$/, ".ts"));
        else external.add(spec!);
      }
    }
    expect(seen.has("controller.ts")).toBe(true);
    expect([...seen].filter((file) => file === "runtime.ts" || file === "worker.ts" || file === "languages.ts")).toEqual([]);
    expect([...external].filter((spec) => spec.includes("shiki"))).toEqual([]);
  });

  test("an older equal-length reply delivers the newest requested revision", async () => {
    const requests: RecordedRequest[] = [];
    const fake: { onmessage: ((event: MessageEvent<{ requestId: number; tokens: Token[] }>) => void) | null; onerror: ((event: ErrorEvent) => unknown) | null; postMessage(value: { requestId?: number; code?: string; grammar?: { language: string; generation: number } }): void; terminate(): void } = {
      onmessage: null, onerror: null, terminate() {}, postMessage(value) { if (value.requestId) requests.push({ requestId: value.requestId, code: value.code!, grammar: value.grammar! }); },
    };
    const highlighter = createHighlighter({ workerFactory: () => fake });
    const older = highlighter("const old = 1;\n", "typescript", { id: "equal-stale", version: 1, state: "done" }) as Promise<Token[]>;
    const newer = highlighter("const new = 2;\n", "typescript", { id: "equal-stale", version: 2, state: "done" }) as Promise<Token[]>;
    fake.onmessage!({ data: completeReply(requests[1], [{ text: requests[1].code }]) } as MessageEvent<{ requestId: number; tokens: Token[] }>);
    fake.onmessage!({ data: completeReply(requests[0], [{ text: requests[0].code }]) } as MessageEvent<{ requestId: number; tokens: Token[] }>);
    expect(text(await newer)).toBe("const new = 2;\n");
    expect(text(await older)).toBe("const new = 2;\n");
    highlighter.dispose();
  });

  test("an older reply cannot populate the visible cache", async () => {
    const requests: RecordedRequest[] = [];
    const fake: { onmessage: ((event: MessageEvent<{ requestId: number; tokens: Token[] }>) => void) | null; onerror: ((event: ErrorEvent) => unknown) | null; postMessage(value: { requestId?: number; code?: string; grammar?: { language: string; generation: number } }): void; terminate(): void } = {
      onmessage: null, onerror: null, terminate() {}, postMessage(value) { if (value.requestId) requests.push({ requestId: value.requestId, code: value.code!, grammar: value.grammar! }); },
    };
    const highlighter = createHighlighter({ workerFactory: () => fake });
    const older = highlighter("const old = 1;\n", "typescript", { id: "stale", version: 1, state: "done" }) as Promise<Token[]>;
    const newer = highlighter("const current = 2;\n", "typescript", { id: "stale", version: 2, state: "done" }) as Promise<Token[]>;
    fake.onmessage!({ data: completeReply(requests[1], [{ text: requests[1].code }]) } as MessageEvent<{ requestId: number; tokens: Token[] }>);
    fake.onmessage!({ data: completeReply(requests[0], [{ text: requests[0].code }]) } as MessageEvent<{ requestId: number; tokens: Token[] }>);
    await Promise.all([older, newer]);
    const retried = highlighter("const old = 1;\n", "typescript", { id: "stale", version: 1, state: "done" });
    expect(requests).toHaveLength(3);
    fake.onmessage!({ data: completeReply(requests[2], [{ text: requests[2].code }]) } as MessageEvent<{ requestId: number; tokens: Token[] }>);
    await retried;
    highlighter.dispose();
  });

  test("concurrent first requests share one engine and one grammar load", async () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      const runtime = new TokenizerRuntime(() => {});
      const sources = Array.from({ length: 24 }, (_, index) => `const n${index} = ${index};\n`);
      const language = (index: number) => index % 2 ? "typescript" : "json";
      const results = await Promise.all(sources.map((code, index) => runtime.tokenize(code, language(index), { id: `concurrent-${index}`, version: 1, state: "done" })));
      expect(results.map(text)).toEqual(sources);
      expect([...runtime["languages"].keys()].sort()).toEqual(["json", "typescript"]);
      await Promise.all([runtime["warming"].get("json"), runtime["warming"].get("typescript")]);
      const colored = await Promise.all(sources.map((code, index) => runtime.tokenize(code, language(index), { id: `colored-${index}`, version: 1, state: "done" })));
      expect(colored.every((tokens) => tokens.some((token) => token.type))).toBe(true);
      runtime.dispose();
    } finally {
      console.warn = warn;
    }
    expect(warnings.filter((warning) => warning.includes("instances have been created"))).toEqual([]);
  });

  test("a busy worker that keeps answering is not treated as hung", async () => {
    // A backlog posted at once takes longer than one request's patience, but the worker answers steadily.
    let terminated = false;
    const queue: RecordedRequest[] = [];
    const fake: { onmessage: ((event: MessageEvent<{ requestId: number; tokens: Token[] }>) => void) | null; onerror: ((event: ErrorEvent) => unknown) | null; postMessage(value: { requestId?: number; code?: string; grammar?: { language: string; generation: number } }): void; terminate(): void } = {
      onmessage: null, onerror: null, terminate() { terminated = true; }, postMessage(value) { if (value.requestId) queue.push({ requestId: value.requestId, code: value.code!, grammar: value.grammar! }); },
    };
    const pump = setInterval(() => {
      const next = queue.shift();
      if (next) fake.onmessage!({ data: completeReply(next, [{ text: next.code, type: "keyword" }]) } as MessageEvent<{ requestId: number; tokens: Token[] }>);
    }, 150);
    const highlighter = createHighlighter({ workerFactory: () => fake });
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => highlighter(`const n = ${index};\n`, "typescript", { id: `busy-${index}`, version: 1, state: "done" })));
    clearInterval(pump);
    expect(terminated).toBe(false);
    expect(results.every((tokens) => tokens![0]!.type === "keyword")).toBe(true);
    highlighter.dispose();
  });

  test("completed cache is capped at 512 blocks", async () => {
    let calls = 0;
    const fake: { onmessage: ((event: MessageEvent<{ requestId: number; tokens: Token[] }>) => void) | null; onerror: ((event: ErrorEvent) => unknown) | null; postMessage(value: { requestId?: number; code?: string; grammar?: { language: string; generation: number } }): void; terminate(): void } = {
      onmessage: null, onerror: null, terminate() {}, postMessage(value) { if (value.requestId) { calls++; queueMicrotask(() => fake.onmessage!({ data: completeReply({ requestId: value.requestId!, code: value.code!, grammar: value.grammar! }, [{ text: value.code! }]) } as MessageEvent<{ requestId: number; tokens: Token[] }>)); } },
    };
    const highlighter = createHighlighter({ workerFactory: () => fake });
    for (let index = 0; index < 513; index++) await highlighter(`const n = ${index};\n`, "typescript", { id: `cap-${index}`, version: 1, state: "done" });
    await highlighter("const n = 0;\n", "typescript", { id: "cap-0", version: 1, state: "done" });
    expect(calls).toBe(514);
    highlighter.dispose();
  });
});

test("a cache hit never returns tokens for different code under the same id and version", async () => {
  await warmLanguage("typescript");
  const highlighter = directHighlighter;
  const context = { id: "same-surface", version: 7, state: "done" as const };
  const first = await highlighter("let a = 1;", "typescript", context);
  expect(first.map((token: Token) => token.text).join("")).toBe("let a = 1;");
  const second = await highlighter("var b = 2;", "typescript", context);
  expect(second.map((token: Token) => token.text).join("")).toBe("var b = 2;");
});

test("an older same-key request that lands last does not replace the newer cached result", async () => {
  const posted: RecordedRequest[] = [];
  let onmessage: ((event: { data: unknown }) => void) | undefined;
  const fakeWorker = {
    postMessage(message: { type: string; requestId: number; code: string; grammar: { language: string; generation: number } }) { if (message.type === "highlight") posted.push(message); },
    terminate() {},
    set onmessage(handler: (event: { data: unknown }) => void) { onmessage = handler; },
    set onerror(_handler: unknown) {},
  };
  const highlighter = createHighlighter({ workerFactory: () => fakeWorker });
  const context = { id: "race", version: 3, state: "done" as const };
  const older = highlighter("aaa", "typescript", context) as Promise<Token[]>;
  const newer = highlighter("bbb", "typescript", context) as Promise<Token[]>;
  onmessage!({ data: completeReply(posted[1]!, [{ text: "bbb", type: "keyword" }]) });
  await newer;
  onmessage!({ data: completeReply(posted[0]!, [{ text: "aaa", type: "keyword" }]) });
  await older;
  const again = highlighter("bbb", "typescript", context);
  expect(Array.isArray(again)).toBe(true);
  expect(posted.length).toBe(2);
  highlighter.dispose();
});

describe("grammar warm-up and regex caches", () => {
  // Every reading of the clock moves `step` ms, so every attempt is over the line limit and warm-up yields after each pattern.
  const withClock = async <T>(step: number, run: () => Promise<T>) => {
    const nowDescriptor = Object.getOwnPropertyDescriptor(performance, "now");
    let clock = 0;
    Object.defineProperty(performance, "now", { configurable: true, value: () => (clock += step) });
    try { return await run(); } finally { if (nowDescriptor) Object.defineProperty(performance, "now", nowDescriptor); }
  };

  test("a worker answers between warm-up slices, and re-sends each provisional block once when warm", async () => {
    const updates: Array<{ id: string; language: string; tokens: Token[] }> = [];
    const runtime = new TokenizerRuntime((context, provenance, tokens) => updates.push({ id: context.id, language: provenance.language, tokens }));
    const cold = viteConfig;
    let tokenized = 0;
    const highlighter = await runtime["engine"]();
    const tokenize = highlighter.codeToTokensBase.bind(highlighter);
    highlighter.codeToTokensBase = (...args: Parameters<typeof tokenize>) => { tokenized++; return tokenize(...args); };
    const [first, second, warming] = await withClock(10, async () => {
      const first = await runtime.tokenize(cold, "typescript", { id: "cold", version: 1, state: "done" });
      const second = await runtime.tokenize("[1]\n", "typescript", { id: "other", version: 1, state: "done" });
      return [first, second, runtime["warming"].get("typescript")!] as const;
    });
    // Both requests were answered while warm-up was still running, with exact plain text, marked provisional, and
    // without tokenizing: a cold rule's scanner compiles all its patterns in one call that cannot yield.
    expect(Bun.peek.status(warming)).toBe("pending");
    expect(tokenized).toBe(0);
    expect([first, second]).toEqual([[{ text: cold }], [{ text: "[1]\n" }]]);
    expect(runtime.willUpdate({ id: "cold", version: 1, state: "done" })).toBe(true);
    await warming;
    expect(updates.map(({ id, language }) => [id, language])).toEqual([["cold", "typescript"], ["other", "typescript"]]);
    expect(text(updates[0]!.tokens)).toBe(cold);
    // The vite config read whose first line a cold grammar once left plain: every line with text is colored.
    expect(typedPerLine(updates[0]!.tokens).slice(0, 6)).toEqual([true, true, false, true, true, true]);
    expect(runtime.willUpdate({ id: "cold", version: 1, state: "done" })).toBe(false);

    // A slow clock may delay tokenization, but it must never change the final grammar result.
    const slow = await withClock(50, () => runtime.tokenize("[2]\n", "typescript", { id: "slow", version: 1, state: "done" }));
    expect(slow.some((token) => token.type)).toBe(true);
    expect(text(slow)).toBe("[2]\n");
    expect(runtime.willUpdate({ id: "slow", version: 1, state: "done" })).toBe(false);
    expect(runtime["provisional"].size).toBe(0);
    runtime.dispose();
  }, 60_000);

  type RevisionWorker = {
    posted: Array<{ requestId: number; code: string; context: unknown; grammar: { language: string; generation: number } }>;
    terminated: boolean;
    onmessage: ((event: MessageEvent<unknown>) => void) | null;
    onerror: ((event: ErrorEvent) => unknown) | null;
    postMessage(value: { type?: string; requestId?: number; code?: string; context?: unknown; grammar?: { language: string; generation: number } }): void;
    terminate(): void;
    send(data: unknown): void;
    crash(): void;
  };
  const revisionWorker = (workers: RevisionWorker[]) => {
    const worker: RevisionWorker = {
      posted: [], terminated: false, onmessage: null, onerror: null,
      postMessage(value) { if (value.type === "highlight") worker.posted.push({ requestId: value.requestId!, code: value.code!, context: value.context, grammar: value.grammar! }); },
      terminate() { worker.terminated = true; },
      send(data) { worker.onmessage?.({ data } as MessageEvent<unknown>); },
      crash() { worker.onerror?.(new ErrorEvent("error")); },
    };
    workers.push(worker);
    return worker;
  };
  const revisionProvenance = (worker: RevisionWorker, index: number, fullyLoaded: boolean) => ({ ...worker.posted[index]!.grammar, fullyLoaded });
  const revisionAnswer = (worker: RevisionWorker, index: number) => worker.send({ requestId: worker.posted[index]!.requestId, tokens: [{ text: worker.posted[index]!.code, type: "keyword" }], provenance: revisionProvenance(worker, index, true), completion: { status: "complete" } });

  test("superseded provisional revisions settle when their final update arrives", async () => {
    const workers: RevisionWorker[] = [];
    const highlighter = createHighlighter({ workerFactory: () => revisionWorker(workers) });
    const firstContext = { id: "superseded", version: 1, state: "done" as const };
    const secondContext = { id: "superseded", version: 2, state: "done" as const };
    const first = highlighter("first\n", "typescript", firstContext);
    const firstRequest = workers[0]!.posted[0]!;
    workers[0]!.send({ requestId: firstRequest.requestId, tokens: [{ text: "first\n" }], provenance: revisionProvenance(workers[0]!, 0, false), completion: { status: "pending" } });
    await first;
    highlighter("second\n", "typescript", secondContext);
    const secondRequest = workers[0]!.posted[1]!;
    revisionAnswer(workers[0]!, 1);
    await highlighter.awaitCompletion(secondContext.id, secondContext.version);
    const waiting = highlighter.awaitCompletion(firstContext.id, firstContext.version);
    workers[0]!.send({ update: firstContext, provenance: revisionProvenance(workers[0]!, 0, true), tokens: [{ text: "first", type: "keyword" }, { text: "\n" }] });
    await expect(waiting).resolves.toEqual({ version: 1, status: "superseded" });
    expect(highlighter("first\n", "typescript", firstContext)).toEqual([{ text: "first", type: "keyword" }, { text: "\n" }]);
    highlighter.dispose();
  });

  test("a cold update notifies subscribers before completion is awaited", async () => {
    const workers: RevisionWorker[] = [];
    const highlighter = createHighlighter({ workerFactory: () => revisionWorker(workers) });
    const context = { id: "cold-subscribe", version: 1, state: "streaming" as const };
    const notices: string[] = [];
    highlighter.subscribe(context.id, (notice) => notices.push(notice.status));
    const result = highlighter("const value = 1;\n", "typescript", context);
    const request = workers[0]!.posted[0]!;
    workers[0]!.send({ requestId: request.requestId, tokens: [{ text: request.code }], provenance: revisionProvenance(workers[0]!, 0, false), completion: { status: "pending" } });
    await result;
    workers[0]!.send({ update: context, provenance: revisionProvenance(workers[0]!, 0, true), tokens: [{ text: "const", type: "keyword" }, { text: " value = 1;\n" }] });
    expect(notices).toContain("complete");
    expect(highlighter("const value = 1;\n", "typescript", context)).toEqual([{ text: "const", type: "keyword" }, { text: " value = 1;\n" }]);
    highlighter.dispose();
  });

  test("completion waiters survive cache eviction and worker restart", async () => {
    jest.useFakeTimers();
    try {
    const workers: RevisionWorker[] = [];
    const highlighter = createHighlighter({ workerFactory: () => revisionWorker(workers) });
    const context = { id: "evicted", version: 1, state: "done" as const };
    const pending = highlighter("evicted\n", "typescript", context);
    const request = workers[0]!.posted[0]!;
    const waiting = highlighter.awaitCompletion(context.id, context.version);
    workers[0]!.crash();
    jest.advanceTimersByTime(250);
    revisionAnswer(workers[1]!, 0);
    await pending;
    await expect(waiting).resolves.toEqual({ version: 1, status: "complete" });
    highlighter.dispose();
    } finally { jest.useRealTimers(); }
  });

  test("completion is observable for the exact block revision", async () => {
    const notices: Array<{ version: number; status: string }> = [];
    const highlighter = createHighlighter();
    const stop = highlighter.subscribe("completion", (notice) => notices.push(notice));
    const context = { id: "completion", version: 1, state: "done" as const };
    await highlighter("const value = 1;\n", "typescript", context);
    const completion = await highlighter.awaitCompletion(context.id, context.version);
    expect(completion).toEqual({ version: 1, status: "complete" });
    expect(notices).toContainEqual({ version: 1, status: "complete" });
    stop();
    highlighter.dispose();
  });

  test("the dynamic regex cache stays at its cap over 200 documents, and dispose frees every regex", async () => {
    const { MAX_DYNAMIC_REGEXES } = await import("../dist/runtime.js");
    const runtime = new TokenizerRuntime(() => {});
    // A fence of N backticks ends at N backticks: textmate builds a new end pattern per fence length.
    for (let index = 0; index < 200; index++) {
      const fence = "`".repeat(3 + index);
      const tildes = "~".repeat(3 + index);
      await runtime.tokenize(`${fence}\nplain ${index}\n${fence}\n${tildes}\nplain\n${tildes}\n`, "markdown", { id: `fence-${index}`, version: 1, state: "done" });
    }
    await runtime["warming"].get("markdown");
    const size = runtime.cacheSize();
    expect(size.dynamic).toBe(MAX_DYNAMIC_REGEXES);
    expect(size.static).toBeGreaterThan(0);
    runtime.dispose();
    expect(runtime.cacheSize()).toEqual({ static: 0, dynamic: 0 });
  }, 60_000);

  test("a worker update replaces the cached tokens of its exact block and tells that block's subscribers", async () => {
    const requests: Array<{ requestId: number; code: string; grammar: { language: string; generation: number } }> = [];
    const fake: { onmessage: ((event: MessageEvent<unknown>) => void) | null; onerror: ((event: ErrorEvent) => unknown) | null; postMessage(value: { requestId?: number; code?: string; grammar?: { language: string; generation: number } }): void; terminate(): void } = {
      onmessage: null, onerror: null, terminate() {}, postMessage(value) { if (value.requestId) requests.push({ requestId: value.requestId, code: value.code!, grammar: value.grammar! }); },
    };
    const send = (data: unknown) => fake.onmessage!({ data } as MessageEvent<unknown>);
    const highlighter = createHighlighter({ workerFactory: () => fake });
    const code = "const a = 1;\n";
    const context = { id: "provisional", version: 1, state: "done" as const };
    const colored: Token[] = [{ text: "const", type: "keyword" }, { text: " a = 1;\n" }];
    let told = 0;
    let other = 0;
    const stop = highlighter.subscribe(context.id, () => told++);
    highlighter.subscribe("another", () => other++);
    const pending = highlighter(code, "typescript", context);
    send({ requestId: requests[0]!.requestId, tokens: [{ text: code }], provenance: { ...requests[0]!.grammar, fullyLoaded: false }, completion: { status: "pending" } });
    expect(await pending).toEqual([{ text: code }]);
    send({ update: context, provenance: { ...requests[0]!.grammar, fullyLoaded: true }, tokens: [{ text: "other text\n", type: "keyword" }] }); // not this block's text
    send({ update: { ...context, version: 2 }, provenance: { ...requests[0]!.grammar, fullyLoaded: true }, tokens: colored }); // not a cached revision
    expect(told).toBe(0);
    send({ update: context, provenance: { ...requests[0]!.grammar, fullyLoaded: true }, tokens: colored });
    expect([told, other]).toEqual([1, 0]);
    expect(highlighter(code, "typescript", context)).toEqual(colored);
    stop();
    send({ update: context, provenance: { ...requests[0]!.grammar, fullyLoaded: true }, tokens: [{ text: code, type: "string" }] });
    expect(told).toBe(1);
    expect(requests).toHaveLength(1);
    highlighter.dispose();
  });
});

describe("embedded grammar completion", () => {
  test.each(Object.entries(embeddedSamples))("%s is order-independent in an isolated runtime", async (language, code) => {
    const isolated = await finalRuntimeTokens(language, code);
    const fullyPreloaded = await finalRuntimeTokens(language, code, ["typescript", "python", "javascript", "css", "html", "tsx", "markdown"]);
    expect(isolated).toEqual(fullyPreloaded);
  });

  test("unknown markdown fences are final as plain fenced content", async () => {
    const code = "```not-a-language\nconst answer = 42;\n```\n";
    const isolated = await finalRuntimeTokens("markdown", code);
    const preloaded = await finalRuntimeTokens("markdown", code, ["typescript", "python", "javascript", "css"]);
    expect(isolated).toEqual(preloaded);
  });

  test("random grammar load orders produce the same embedded tokens", async () => {
    const languages = ["typescript", "python", "javascript", "css", "html", "tsx", "markdown"];
    const expected = await finalRuntimeTokens("markdown", embeddedSamples.markdown, languages);
    let seed = 0x51f15e;
    for (let run = 0; run < 8; run++) {
      const order = [...languages];
      for (let index = order.length - 1; index > 0; index--) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const swap = seed % (index + 1);
        [order[index], order[swap]] = [order[swap]!, order[index]!];
      }
      expect(await finalRuntimeTokens("markdown", embeddedSamples.markdown, order.slice(0, run % order.length))).toEqual(expected);
    }
  });

  test.each(Object.entries(embeddedSamples))("%s awaitCompletion resolves only after isolated tokens are final", async (language, code) => {
    const highlighter = createHighlighter();
    const context = { id: `isolated-${language}-completion`, version: 1, state: "done" as const };
    const first = await highlighter(code, language, context);
    expect(first).not.toBeNull();
    expect(await highlighter.awaitCompletion(context.id, context.version)).toEqual({ version: 1, status: "complete" });
    const final = await highlighter(code, language, context);
    const expected = await finalRuntimeTokens(language, code, ["typescript", "python", "javascript", "css", "html", "tsx", "markdown"]);
    expect(final).toEqual(expected);
    highlighter.dispose();
  });

  test("a streaming markdown fence re-tokenizes at most once per embedded grammar load", async () => {
    const counts = new Map<number, number>();
    let resolve!: (tokens: Token[]) => void;
    const complete = new Promise<Token[]>((done) => { resolve = done; });
    const runtime = new TokenizerRuntime((context, provenance, tokens) => {
      if (context.id === "stream-embedded" && context.version === 1 && provenance.fullyLoaded) resolve(tokens);
    });
    const tokenizeLoaded = runtime["tokenizeLoaded"].bind(runtime);
    runtime["tokenizeLoaded"] = ((code, language, context, highlighter, epoch) => {
      counts.set(context.version, (counts.get(context.version) ?? 0) + 1);
      return tokenizeLoaded(code, language, context, highlighter, epoch);
    }) as typeof runtime["tokenizeLoaded"];
    const open = "```ts\nconst answer: number = 42;\n";
    const first = await runtime.tokenizeWithProvenance(open, { id: "stream-embedded", version: 1, state: "streaming" }, "markdown", 1);
    const colored = first.provenance.fullyLoaded ? first.tokens : await complete;
    expect(colored.some((token) => token.type === "keyword" && token.text === "const")).toBeTrue();
    const closed = await runtime.tokenizeWithProvenance(`${open}\`\`\`\n`, { id: "stream-embedded", version: 2, state: "done" }, "markdown", 1);
    expect(closed.provenance.fullyLoaded).toBeTrue();
    expect(counts.get(1) ?? 0).toBeLessThanOrEqual(2);
    expect(counts.get(2)).toBe(1);
    runtime.dispose();
  });
});
