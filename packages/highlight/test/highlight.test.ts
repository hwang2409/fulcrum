import { afterAll, describe, expect, test } from "bun:test";
import type { Token } from "../src/index.js";
import { semanticTheme } from "../src/scopes.js";

const build = Bun.spawnSync(["bun", "run", "build"], { cwd: new URL("..", import.meta.url).pathname });
if (build.exitCode !== 0) throw new Error(build.stderr.toString());
const { createHighlighter } = await import("../dist/index.js");
// Unit tests never depend on how fast this machine is: the clock stands still unless a test moves it, so no line is ever
// over the time limit by chance. Only a real worker (its own clock) runs on real time.
Object.defineProperty(performance, "now", { configurable: true, value: () => 0 });
const directHighlighter = createHighlighter({ worker: false });
afterAll(() => directHighlighter.dispose());

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
const fallbackSource = (label: string, lines = 120) => Array.from({ length: lines }, (_, index) => `const ${label}_${index} = ${index}; // ${"x".repeat(32)}\n`).join("");
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

async function controlledFallback(
  requests: Array<{ code: string; language: string; context: { id: string; version: number; state: "streaming" | "done" } }>,
  options: { first?: "oldest" | "newest"; afterFirstYield?: (runtime: { dispose(): void }) => void; prime?: { code: string; language: string; context: { id: string; version: number; state: "streaming" | "done" } } } = {},
) {
  const { TokenizerRuntime } = await import("../dist/runtime.js");
  const runtime = new TokenizerRuntime();
  for (const language of new Set(requests.map(({ language }) => language)))
    await runtime.tokenize("const warm = 1;\n", language, { id: `warm-${language}`, version: 1, state: "done" }, false);
  if (options.prime) await runtime.tokenize(options.prime.code, options.prime.language, options.prime.context, false);
  const schedulerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "scheduler");
  const nowDescriptor = Object.getOwnPropertyDescriptor(performance, "now");
  const yields: Array<() => void> = [];
  let clock = 0;
  Object.defineProperty(globalThis, "scheduler", { configurable: true, value: { yield: () => new Promise<void>((resolve) => yields.push(resolve)) } });
  Object.defineProperty(performance, "now", { configurable: true, value: () => (clock += 5) });
  let settled = 0;
  const jobs = requests.map(({ code, language, context }) => runtime.tokenize(code, language, context).finally(() => settled++));
  try {
    while (!yields.length) await Bun.sleep(0);
    options.afterFirstYield?.(runtime);
    let first = true;
    while (settled < jobs.length) {
      if (!yields.length) { await Bun.sleep(0); continue; }
      const index = first && options.first === "newest" ? yields.length - 1 : 0;
      yields.splice(index, 1)[0]!();
      first = false;
      await Bun.sleep(0);
    }
    return await Promise.all(jobs);
  } finally {
    runtime.dispose();
    if (schedulerDescriptor) Object.defineProperty(globalThis, "scheduler", schedulerDescriptor);
    else delete (globalThis as { scheduler?: unknown }).scheduler;
    if (nowDescriptor) Object.defineProperty(performance, "now", nowDescriptor);
  }
}

async function full(language: string, code: string) {
  return (await directHighlighter(code, language, { id: `full-${language}-${code}`, version: 1, state: "done" }))!;
}

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
      const highlighter = createHighlighter({ worker: false });
      let streamed: Token[] | null = null;
      const lines = code.match(/.*(?:\n|$)/g)!.filter(Boolean);
      let input = "";
      for (let version = 0; version < lines.length; version++) {
        input += lines[version];
        streamed = await highlighter(input, language, { id: language, version, state: version === lines.length - 1 ? "done" : "streaming" });
      }
      expect(text(streamed!)).toBe(code);
      highlighter.dispose();
    });
  }

  test("reuses the completed token prefix when a line is appended", async () => {
    const highlighter = createHighlighter({ worker: false });
    const first = await highlighter("const first = 1;\n", "typescript", { id: "prefix", version: 1, state: "streaming" });
    const firstToken = first![0];
    const second = await highlighter("const first = 1;\nconst second = 2;\n", "typescript", { id: "prefix", version: 2, state: "streaming" });
    expect(second![0]).toBe(firstToken);
    highlighter.dispose();
  });

  test("returns exactly the streamed text when an incomplete line follows complete ones", async () => {
    const highlighter = createHighlighter({ worker: false });
    const source = "--- a/run.ts\n+++ b/run.ts\n-const delay = 100;\n+const delay = 16;\n";
    for (let length = 1; length <= source.length; length++) {
      const code = source.slice(0, length);
      expect(text((await highlighter(code, "diff", { id: "tail", version: length, state: length === source.length ? "done" : "streaming" }))!)).toBe(code);
    }
    highlighter.dispose();
  });

  // Regression: a cold grammar compiles its patterns while it tokenizes; that time made short lines look like runaway
  // lines, so they were cached as plain text (the gallery's vite.config.ts read lost the colors of line 1). In the worker
  // such a line is provisional: once the grammar is warm, the worker sends the block again, colored.
  test("a cold grammar colors every line once the worker's warm-up lands", async () => {
    const replies: Array<{ requestId?: number; provisional?: boolean; update?: unknown }> = [];
    const highlighter = createHighlighter({ workerFactory: () => recordingWorker(replies) });
    const source = viteConfig;
    for (const language of ["typescript", "javascript"]) {
      const context = { id: `cold-${language}`, version: 1, state: "done" as const };
      const updated = new Promise<void>((resolve) => { const stop = highlighter.subscribe(context.id, () => { stop(); resolve(); }); });
      const first = (await highlighter(source, language, context))!;
      expect(text(first)).toBe(source);
      // The handshake: a provisional reply is followed by one update for its block, which the cache then serves.
      const reply = replies.findLast((item) => item.requestId !== undefined)!;
      if (reply.provisional) await updated;
      const tokens = highlighter(source, language, context) as Token[];
      expect(Array.isArray(tokens)).toBe(true);
      expect(text(tokens)).toBe(source);
      if (reply.provisional) expect(tokens).toEqual((replies.findLast((item) => item.update !== undefined) as { tokens: Token[] }).tokens);
      // Every line colored is shown deterministically below ("re-sends each provisional block once"); here, on real
      // time, the colors only have to arrive.
      expect(tokens.some((token) => token.type)).toBe(true);
    }
    highlighter.dispose();
  }, 60_000);

  test("a line that stays over the time limit without compiling is plain and exact", async () => {
    const { TokenizerRuntime } = await import("../dist/runtime.js");
    const runtime = new TokenizerRuntime();
    await runtime.tokenize("const warm = 1;\n", "typescript", { id: "warm", version: 1, state: "done" }, false);
    const nowDescriptor = Object.getOwnPropertyDescriptor(performance, "now");
    let clock = 0;
    Object.defineProperty(performance, "now", { configurable: true, value: () => (clock += 50) });
    try {
      const tokens = await runtime.tokenize("const slow = 1;\n", "typescript", { id: "slow", version: 1, state: "done" }, false);
      expect(tokens).toEqual([{ text: "const slow = 1;\n" }]);
    } finally {
      if (nowDescriptor) Object.defineProperty(performance, "now", nowDescriptor);
      runtime.dispose();
    }
  });

  // Counts every tokenize attempt of a runtime; `extra` runs after each one.
  const countAttempts = async (language: string, extra?: () => void) => {
    const { TokenizerRuntime } = await import("../dist/runtime.js");
    const runtime = new TokenizerRuntime();
    const highlighter = await runtime["ensureLanguage"](language);
    const attempt = highlighter.codeToTokensBase.bind(highlighter);
    const counter = { attempts: 0, runtime };
    highlighter.codeToTokensBase = (...args: Parameters<typeof attempt>) => { counter.attempts++; const result = attempt(...args); extra?.(); return result; };
    return counter;
  };

  // Regression: the retry after a slow attempt that built scanners had no bound, and markdown builds a scanner per
  // resolved dynamic end, so one such line ran up to seconds (and again on the main thread after the worker watchdog).
  test("a hostile markdown line gets at most two attempts and stays exact", async () => {
    const unit = "*a* _b_ ";
    const line = unit.repeat(Math.floor(1000 / unit.length)) + "\n";
    const counter = await countAttempts("markdown");
    const tokens = await counter.runtime.tokenize(line, "markdown", { id: "hostile", version: 1, state: "done" }, false);
    expect(text(tokens)).toBe(line);
    expect(counter.attempts).toBeLessThanOrEqual(2);
    counter.runtime.dispose();
  });

  // In the worker a grammar is warmed in the background; once warm, a document compiles no regex: warm-up compiled each
  // pattern in every form textmate compiles it (anchor variants, `\z` rewritten). Regression: cpp's anchor variants were
  // missed, and its first line then compiled 51 patterns in one scanner build that cannot yield (272 ms in Chromium).
  test("after warm-up a document compiles no regex", async () => {
    const { TokenizerRuntime } = await import("../dist/runtime.js");
    const documents = [["cpp", "#include <vector>\nstd::vector<int> values;\nint main() { return values.size(); }\n"], ["typescript", viteConfig]] as const;
    for (const [language, source] of documents) {
      const runtime = new TokenizerRuntime(() => {});
      await runtime.tokenize("x\n", language, { id: "load", version: 1, state: "done" }, false);
      await runtime["warming"].get(language);
      const before = runtime.cacheSize();
      const tokens = await runtime.tokenize(source, language, { id: "warm", version: 1, state: "done" }, false);
      expect(text(tokens)).toBe(source);
      expect({ language, ...runtime.cacheSize() }).toEqual({ language, ...before });
      runtime.dispose();
    }
  }, 60_000);

  // Every line here looks like a cold one (slow, and it built a scanner), as in a document that embeds many cold
  // grammars: each line is tried at most twice, and the retries stop when the document's budget is spent.
  test("cold compiles across a document stay inside the document budget", async () => {
    const nowDescriptor = Object.getOwnPropertyDescriptor(performance, "now");
    let clock = 0;
    let counter: Awaited<ReturnType<typeof countAttempts>> | undefined;
    counter = await countAttempts("typescript", () => { clock += 12; counter!.runtime["scanners"]++; });
    Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
    try {
      const lines = 50;
      const source = "const a = 1;\n".repeat(lines);
      const tokens = await counter.runtime.tokenize(source, "typescript", { id: "budget", version: 1, state: "done" }, false);
      expect(tokens).toEqual([{ text: source }]);
      // 100 ms of retries at 12 ms each: at most 9 retries in the document.
      expect(counter.attempts).toBeGreaterThan(lines);
      expect(counter.attempts).toBeLessThanOrEqual(lines + 9);
    } finally {
      if (nowDescriptor) Object.defineProperty(performance, "now", nowDescriptor);
      counter.runtime.dispose();
    }
  });

  test("keeps an incomplete line plain until it is complete", async () => {
    const highlighter = createHighlighter({ worker: false });
    const partial = await highlighter("const value", "typescript", { id: "partial", version: 1, state: "streaming" });
    expect(partial).toEqual([{ text: "const value" }]);
    const complete = await highlighter("const value = 1;\n", "typescript", { id: "partial", version: 2, state: "streaming" });
    expect(text(complete!)).toBe("const value = 1;\n");
    highlighter.dispose();
  });
});

describe("cooperative fallback concurrency", () => {
  test("concurrent versions return only their requested source", async () => {
    const base = fallbackSource("base", 20);
    const older = `${base}${fallbackSource("older")}`;
    const newer = `${older}${fallbackSource("newer")}`;
    const [olderTokens, newerTokens] = await controlledFallback([
      { code: older, language: "typescript", context: { id: "concurrent", version: 2, state: "streaming" } },
      { code: newer, language: "typescript", context: { id: "concurrent", version: 3, state: "streaming" } },
    ], { prime: { code: base, language: "typescript", context: { id: "concurrent", version: 1, state: "streaming" } } });
    expect(text(olderTokens)).toBe(older);
    expect(text(newerTokens)).toBe(newer);
  });

  test("an older job finishing last cannot overwrite a newer version", async () => {
    const older = fallbackSource("old");
    const newer = fallbackSource("new");
    const [olderTokens, newerTokens] = await controlledFallback([
      { code: older, language: "typescript", context: { id: "out-of-order", version: 1, state: "done" } },
      { code: newer, language: "typescript", context: { id: "out-of-order", version: 2, state: "done" } },
    ], { first: "newest" });
    expect(text(olderTokens)).toBe(older);
    expect(text(newerTokens)).toBe(newer);
  });

  test("a version bump started mid-slice keeps both requests exact", async () => {
    const first = fallbackSource("mid");
    const second = `${first}${fallbackSource("bump", 20)}`;
    const [firstTokens, secondTokens] = await controlledFallback([
      { code: first, language: "typescript", context: { id: "mid-slice", version: 1, state: "streaming" } },
      { code: second, language: "typescript", context: { id: "mid-slice", version: 2, state: "streaming" } },
    ], { first: "oldest" });
    expect(text(firstTokens)).toBe(first);
    expect(text(secondTokens)).toBe(second);
  });

  test("a language change mid-stream isolates grammar state and tokens", async () => {
    const typescript = fallbackSource("language");
    const python = Array.from({ length: 120 }, (_, index) => `value_${index}: int = ${index}\n`).join("");
    const [typescriptTokens, pythonTokens] = await controlledFallback([
      { code: typescript, language: "typescript", context: { id: "language-change", version: 1, state: "streaming" } },
      { code: python, language: "python", context: { id: "language-change", version: 2, state: "streaming" } },
    ], { first: "newest" });
    expect(text(typescriptTokens)).toBe(typescript);
    expect(text(pythonTokens)).toBe(python);
  });

  test("done after streaming does not share a mutable prefix", async () => {
    const streaming = fallbackSource("done");
    const done = `${streaming}const final = true;`;
    const [streamingTokens, doneTokens] = await controlledFallback([
      { code: streaming, language: "typescript", context: { id: "done", version: 1, state: "streaming" } },
      { code: done, language: "typescript", context: { id: "done", version: 2, state: "done" } },
    ]);
    expect(text(streamingTokens)).toBe(streaming);
    expect(text(doneTokens)).toBe(done);
  });

  test("dispose while fallback work is pending still returns exact text", async () => {
    const source = fallbackSource("dispose");
    const [tokens] = await controlledFallback([
      { code: source, language: "typescript", context: { id: "dispose", version: 1, state: "done" } },
    ], { afterFirstYield: (runtime) => runtime.dispose() });
    expect(text(tokens)).toBe(source);
  });

  test("concatenated token text equals source over random interleavings", async () => {
    let seed = 0x5eed;
    for (let run = 0; run < 12; run++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const base = fallbackSource(`property_${run}`, 20 + seed % 20);
      const sources = [base, `${base}// ${seed}\n`, fallbackSource(`replacement_${run}`, 20 + (seed >>> 8) % 20)];
      const requests = sources.map((code, index) => ({ code, language: index === 2 && seed % 2 ? "javascript" : "typescript", context: { id: `property-${run}`, version: index + 1, state: index === 2 ? "done" as const : "streaming" as const } }));
      const results = await controlledFallback(requests, { first: seed % 2 ? "newest" : "oldest" });
      expect(results.map(text)).toEqual(sources);
    }
  });
});

describe("identity, failure, and caps", () => {
  test("never confuses same-length blocks", async () => {
    const highlighter = createHighlighter({ worker: false });
    const left = await highlighter("const a = 1;\n", "typescript", { id: "left", version: 1, state: "done" });
    const right = await highlighter("const b = 2;\n", "typescript", { id: "right", version: 1, state: "done" });
    expect(text(left!)).not.toBe(text(right!));
    highlighter.dispose();
  });

  test("unknown and oversized input use exact plain fallback", async () => {
    const highlighter = createHighlighter({ worker: false });
    expect(highlighter("hello", "unknown")).toBeNull();
    const huge = "x".repeat(512 * 1024 + 1);
    expect(await highlighter(huge, "typescript", { id: "huge", version: 1, state: "done" })).toEqual([{ text: huge }]);
    const long = `${"x".repeat(20_001)}\nconst ok = 1;\n`;
    expect(text((await highlighter(long, "typescript", { id: "long", version: 1, state: "done" }))!)).toBe(long);
    highlighter.dispose();
  });

  test("worker construction and runtime failure use the cooperative fallback", async () => {
    const blocked = createHighlighter({ workerFactory: () => { throw new Error("blocked by csp"); } });
    const code = samples.python;
    expect(text((await blocked(code, "python", { id: "worker-construction", version: 1, state: "done" }))!)).toBe(code);
    blocked.dispose();

    const failedWorker: { onmessage: ((event: MessageEvent<never>) => void) | null; onerror: ((event: ErrorEvent) => unknown) | null; postMessage(): void; terminate(): void } = {
      onmessage: null, onerror: null, terminate() {}, postMessage() { queueMicrotask(() => failedWorker.onerror?.(new ErrorEvent("error"))); },
    };
    const crashed = createHighlighter({ workerFactory: () => failedWorker });
    const tokens = await crashed(code, "python", { id: "worker-crash", version: 1, state: "done" });
    expect(text(tokens!)).toBe(code);
    expect(tokens!.some((token) => token.type)).toBe(true);
    crashed.dispose();
  });

  test("an older equal-length reply delivers the newest requested revision", async () => {
    const requests: Array<{ requestId: number; code: string }> = [];
    const fake: { onmessage: ((event: MessageEvent<{ requestId: number; tokens: Token[] }>) => void) | null; onerror: ((event: ErrorEvent) => unknown) | null; postMessage(value: { requestId?: number; code?: string }): void; terminate(): void } = {
      onmessage: null, onerror: null, terminate() {}, postMessage(value) { if (value.requestId) requests.push({ requestId: value.requestId, code: value.code! }); },
    };
    const highlighter = createHighlighter({ workerFactory: () => fake });
    const older = highlighter("const old = 1;\n", "typescript", { id: "equal-stale", version: 1, state: "done" }) as Promise<Token[]>;
    const newer = highlighter("const new = 2;\n", "typescript", { id: "equal-stale", version: 2, state: "done" }) as Promise<Token[]>;
    fake.onmessage!({ data: { requestId: requests[1].requestId, tokens: [{ text: requests[1].code }] } } as MessageEvent<{ requestId: number; tokens: Token[] }>);
    fake.onmessage!({ data: { requestId: requests[0].requestId, tokens: [{ text: requests[0].code }] } } as MessageEvent<{ requestId: number; tokens: Token[] }>);
    expect(text(await newer)).toBe("const new = 2;\n");
    expect(text(await older)).toBe("const new = 2;\n");
    highlighter.dispose();
  });

  test("an older reply cannot populate the visible cache", async () => {
    const requests: Array<{ requestId: number; code: string }> = [];
    const fake: { onmessage: ((event: MessageEvent<{ requestId: number; tokens: Token[] }>) => void) | null; onerror: ((event: ErrorEvent) => unknown) | null; postMessage(value: { requestId?: number; code?: string }): void; terminate(): void } = {
      onmessage: null, onerror: null, terminate() {}, postMessage(value) { if (value.requestId) requests.push({ requestId: value.requestId, code: value.code! }); },
    };
    const highlighter = createHighlighter({ workerFactory: () => fake });
    const older = highlighter("const old = 1;\n", "typescript", { id: "stale", version: 1, state: "done" }) as Promise<Token[]>;
    const newer = highlighter("const current = 2;\n", "typescript", { id: "stale", version: 2, state: "done" }) as Promise<Token[]>;
    fake.onmessage!({ data: { requestId: requests[1].requestId, tokens: [{ text: requests[1].code }] } } as MessageEvent<{ requestId: number; tokens: Token[] }>);
    fake.onmessage!({ data: { requestId: requests[0].requestId, tokens: [{ text: requests[0].code }] } } as MessageEvent<{ requestId: number; tokens: Token[] }>);
    await Promise.all([older, newer]);
    const retried = highlighter("const old = 1;\n", "typescript", { id: "stale", version: 1, state: "done" });
    expect(requests).toHaveLength(3);
    fake.onmessage!({ data: { requestId: requests[2].requestId, tokens: [{ text: requests[2].code }] } } as MessageEvent<{ requestId: number; tokens: Token[] }>);
    await retried;
    highlighter.dispose();
  });

  test("concurrent first requests share one engine and one grammar load", async () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      const highlighter = createHighlighter({ worker: false });
      const results = await Promise.all(Array.from({ length: 24 }, (_, index) => highlighter(`const n${index} = ${index};\n`, index % 2 ? "typescript" : "json", { id: `concurrent-${index}`, version: 1, state: "done" })));
      expect(results.map((tokens) => tokens!.map((token) => token.text).join(""))).toEqual(Array.from({ length: 24 }, (_, index) => `const n${index} = ${index};\n`));
      expect(results.every((tokens) => tokens!.some((token) => token.type))).toBe(true);
      highlighter.dispose();
    } finally {
      console.warn = warn;
    }
    expect(warnings.filter((warning) => warning.includes("instances have been created"))).toEqual([]);
  });

  test("a busy worker that keeps answering is not treated as hung", async () => {
    // A backlog posted at once takes longer than one request's patience, but the worker answers steadily.
    let terminated = false;
    const queue: Array<{ requestId: number; code: string }> = [];
    const fake: { onmessage: ((event: MessageEvent<{ requestId: number; tokens: Token[] }>) => void) | null; onerror: ((event: ErrorEvent) => unknown) | null; postMessage(value: { requestId?: number; code?: string }): void; terminate(): void } = {
      onmessage: null, onerror: null, terminate() { terminated = true; }, postMessage(value) { if (value.requestId) queue.push({ requestId: value.requestId, code: value.code! }); },
    };
    const pump = setInterval(() => {
      const next = queue.shift();
      if (next) fake.onmessage!({ data: { requestId: next.requestId, tokens: [{ text: next.code, type: "keyword" }] } } as MessageEvent<{ requestId: number; tokens: Token[] }>);
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
    const fake: { onmessage: ((event: MessageEvent<{ requestId: number; tokens: Token[] }>) => void) | null; onerror: ((event: ErrorEvent) => unknown) | null; postMessage(value: { requestId?: number; code?: string }): void; terminate(): void } = {
      onmessage: null, onerror: null, terminate() {}, postMessage(value) { if (value.requestId) { calls++; queueMicrotask(() => fake.onmessage!({ data: { requestId: value.requestId!, tokens: [{ text: value.code! }] } } as MessageEvent<{ requestId: number; tokens: Token[] }>)); } },
    };
    const highlighter = createHighlighter({ workerFactory: () => fake });
    for (let index = 0; index < 513; index++) await highlighter(`const n = ${index};\n`, "typescript", { id: `cap-${index}`, version: 1, state: "done" });
    await highlighter("const n = 0;\n", "typescript", { id: "cap-0", version: 1, state: "done" });
    expect(calls).toBe(514);
    highlighter.dispose();
  });
});

test("a cache hit never returns tokens for different code under the same id and version", async () => {
  const highlighter = createHighlighter({ worker: false });
  const context = { id: "same-surface", version: 7, state: "done" as const };
  const first = await highlighter("let a = 1;", "typescript", context);
  expect(first.map((token: Token) => token.text).join("")).toBe("let a = 1;");
  const second = await highlighter("var b = 2;", "typescript", context);
  expect(second.map((token: Token) => token.text).join("")).toBe("var b = 2;");
  highlighter.dispose();
});

test("an older same-key request that lands last does not replace the newer cached result", async () => {
  const posted: Array<{ requestId: number; code: string }> = [];
  let onmessage: ((event: { data: unknown }) => void) | undefined;
  const fakeWorker = {
    postMessage(message: { type: string; requestId: number; code: string }) { if (message.type === "highlight") posted.push(message); },
    terminate() {},
    set onmessage(handler: (event: { data: unknown }) => void) { onmessage = handler; },
    set onerror(_handler: unknown) {},
  };
  const highlighter = createHighlighter({ workerFactory: () => fakeWorker });
  const context = { id: "race", version: 3, state: "done" as const };
  const older = highlighter("aaa", "typescript", context) as Promise<Token[]>;
  const newer = highlighter("bbb", "typescript", context) as Promise<Token[]>;
  onmessage!({ data: { requestId: posted[1]!.requestId, tokens: [{ text: "bbb", type: "keyword" }] } });
  await newer;
  onmessage!({ data: { requestId: posted[0]!.requestId, tokens: [{ text: "aaa", type: "keyword" }] } });
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

  test("the main thread never warms a grammar: it compiles only the patterns its lines meet", async () => {
    const { TokenizerRuntime } = await import("../dist/runtime.js");
    const page = new TokenizerRuntime();
    await page.tokenize("x = 1\n", "ruby", { id: "page", version: 1, state: "done" }, true);
    expect(page["warming"].size).toBe(0);
    const worker = new TokenizerRuntime(() => {});
    await worker.tokenize("x = 1\n", "ruby", { id: "worker", version: 1, state: "done" }, false);
    await worker["warming"].get("ruby");
    expect(page.cacheSize().static).toBeLessThan(worker.cacheSize().static / 4);
    page.dispose();
    worker.dispose();
  }, 60_000);

  test("a worker answers between warm-up slices, and re-sends each provisional block once when warm", async () => {
    const { TokenizerRuntime } = await import("../dist/runtime.js");
    const updates: Array<{ id: string; language: string; tokens: Token[] }> = [];
    const runtime = new TokenizerRuntime((context, language, tokens) => updates.push({ id: context.id, language, tokens }));
    const cold = viteConfig;
    let scanners = -1;
    const [first, second, warming] = await withClock(10, async () => {
      const first = await runtime.tokenize(cold, "typescript", { id: "cold", version: 1, state: "done" }, false);
      scanners = runtime["scanners"];
      const second = await runtime.tokenize("[1]\n", "typescript", { id: "other", version: 1, state: "done" }, false);
      return [first, second, runtime["warming"].get("typescript")!] as const;
    });
    // Both requests were answered while warm-up was still running, with exact plain text, marked provisional, and
    // without tokenizing: a cold rule's scanner compiles all its patterns in one call that cannot yield.
    expect(Bun.peek.status(warming)).toBe("pending");
    expect([scanners, runtime["scanners"]]).toEqual([0, 0]);
    expect([first, second]).toEqual([[{ text: cold }], [{ text: "[1]\n" }]]);
    expect(runtime.willUpdate({ id: "cold", version: 1, state: "done" })).toBe(true);
    await warming;
    expect(updates.map(({ id, language }) => [id, language])).toEqual([["cold", "typescript"], ["other", "typescript"]]);
    expect(text(updates[0]!.tokens)).toBe(cold);
    // The vite config read whose first line a cold grammar once left plain: every line with text is colored.
    expect(typedPerLine(updates[0]!.tokens).slice(0, 6)).toEqual([true, true, false, true, true, true]);
    expect(runtime.willUpdate({ id: "cold", version: 1, state: "done" })).toBe(false);

    // Once warm, a line over the limit is really slow: it stays plain, final, and is never re-sent.
    const slow = await withClock(50, () => runtime.tokenize("[2]\n", "typescript", { id: "slow", version: 1, state: "done" }, false));
    expect(slow).toEqual([{ text: "[2]\n" }]);
    expect(runtime.willUpdate({ id: "slow", version: 1, state: "done" })).toBe(false);
    expect(runtime["provisional"].size).toBe(0);
    runtime.dispose();
  }, 60_000);

  test("the dynamic regex cache stays at its cap over 200 documents, and dispose frees every regex", async () => {
    const { TokenizerRuntime, MAX_DYNAMIC_REGEXES } = await import("../dist/runtime.js");
    for (const runtime of [new TokenizerRuntime(), new TokenizerRuntime(() => {})]) {
      // A fence of N backticks ends at N backticks: textmate builds a new end pattern per fence length.
      for (let index = 0; index < 200; index++) {
        const fence = "`".repeat(3 + index);
        const tildes = "~".repeat(3 + index);
        await runtime.tokenize(`${fence}\nplain ${index}\n${fence}\n${tildes}\nplain\n${tildes}\n`, "markdown", { id: `fence-${index}`, version: 1, state: "done" }, false);
      }
      await runtime["warming"].get("markdown");
      const size = runtime.cacheSize();
      expect(size.dynamic).toBe(MAX_DYNAMIC_REGEXES);
      expect(size.static).toBeGreaterThan(0);
      runtime.dispose();
      expect(runtime.cacheSize()).toEqual({ static: 0, dynamic: 0 });
    }
  }, 60_000);

  test("a worker update replaces the cached tokens of its exact block and tells that block's subscribers", async () => {
    const requests: Array<{ requestId: number; code: string }> = [];
    const fake: { onmessage: ((event: MessageEvent<unknown>) => void) | null; onerror: ((event: ErrorEvent) => unknown) | null; postMessage(value: { requestId?: number; code?: string }): void; terminate(): void } = {
      onmessage: null, onerror: null, terminate() {}, postMessage(value) { if (value.requestId) requests.push({ requestId: value.requestId, code: value.code! }); },
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
    send({ requestId: requests[0]!.requestId, tokens: [{ text: code }], provisional: true });
    expect(await pending).toEqual([{ text: code }]);
    send({ update: context, language: "typescript", tokens: [{ text: "other text\n", type: "keyword" }] }); // not this block's text
    send({ update: { ...context, version: 2 }, language: "typescript", tokens: colored }); // not a cached revision
    expect(told).toBe(0);
    send({ update: context, language: "typescript", tokens: colored });
    expect([told, other]).toEqual([1, 0]);
    expect(highlighter(code, "typescript", context)).toEqual(colored);
    stop();
    send({ update: context, language: "typescript", tokens: [{ text: code, type: "string" }] });
    expect(told).toBe(1);
    expect(requests).toHaveLength(1);
    highlighter.dispose();
  });
});
