import { afterAll, describe, expect, jest, test } from "bun:test";
import type { Token } from "../src/index.js";
import { semanticTheme } from "../src/scopes.js";

const build = Bun.spawnSync(["bun", "run", "build"], { cwd: new URL("..", import.meta.url).pathname });
if (build.exitCode !== 0) throw new Error(build.stderr.toString());
const { createHighlighter } = await import("../dist/index.js");
// Unit tests never depend on how fast this machine is: the clock stands still unless a test moves it, so no line is ever
// over the time limit by chance. Only a real worker (its own clock) runs on real time.
Object.defineProperty(performance, "now", { configurable: true, value: () => 0 });
const { TokenizerRuntime, MAX_RESIDENT_LANGUAGES } = await import("../dist/runtime.js");
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
    // Liveness for the controller's watchdog: the worker said it was compiling (null) and which block it tokenized.
    const progress = replies.filter((item) => "progress" in item).map((item) => (item as { progress: { id: string } | null }).progress?.id ?? null);
    expect([null, "cold-typescript", "cold-javascript"].every((id) => progress.includes(id))).toBe(true);
    highlighter.dispose();
  }, 60_000);

  test("a line that stays over the time limit without compiling is plain and exact", async () => {
    const runtime = await warmRuntime("typescript");
    await runtime.tokenize("const warm = 1;\n", "typescript", { id: "warm", version: 1, state: "done" });
    const nowDescriptor = Object.getOwnPropertyDescriptor(performance, "now");
    let clock = 0;
    Object.defineProperty(performance, "now", { configurable: true, value: () => (clock += 50) });
    try {
      const tokens = await runtime.tokenize("const slow = 1;\n", "typescript", { id: "slow", version: 1, state: "done" });
      expect(tokens).toEqual([{ text: "const slow = 1;\n" }]);
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
  test("a hostile markdown line gets at most two attempts and stays exact", async () => {
    const unit = "*a* _b_ ";
    const line = unit.repeat(Math.floor(1000 / unit.length)) + "\n";
    const counter = await countAttempts("markdown");
    const tokens = await counter.runtime.tokenize(line, "markdown", { id: "hostile", version: 1, state: "done" });
    expect(text(tokens)).toBe(line);
    expect(counter.attempts).toBeLessThanOrEqual(2);
    counter.runtime.dispose();
  });

  // A visible request arrives after background warming has started. Demand priority must survive grammar loading,
  // initialization, and tokenization; the old FIFO scheduler took more than 20 seconds on this shape.
  test("visible demand preempts 29 background languages", async () => {
    const background = ["csharp", "powershell", "dart", "scala", "clojure", "elixir", "haskell", "ocaml", "zig", "nix", "terraform", "vue", "svelte", "astro", "solidity", "graphql", "prisma", "sql", "toml", "dotenv", "dockerfile", "makefile", "cmake", "nginx", "csv", "latex", "log", "rust", "typescript"];
    const realNow = Object.getOwnPropertyDescriptor(performance, "now")!;
    Object.defineProperty(performance, "now", { configurable: true, value: () => Date.now() });
    let colored = false;
    const runtime = new TokenizerRuntime((context, language, tokens) => { if (context.id === "visible-julia" && language === "julia" && tokens.some((token) => token.type)) colored = true; });
    background.forEach((language, index) => { void runtime.tokenize("function greet() { return 1; }\n", language, { id: `background-${index}`, version: 1, state: "done" }); });
    const started = Date.now();
    void runtime.tokenize("function greet(name)\n  return \"hello $name\"\nend\n", "julia", { id: "visible-julia", version: 1, state: "done" });
    while (!colored && Date.now() - started < 1_500) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(colored).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_500);
    runtime.dispose();
    Object.defineProperty(performance, "now", realNow);
  }, 30_000);

  test("recycles before grammar residency exceeds its finite budget", async () => {
    const runtime = new TokenizerRuntime(() => {});
    const languages = ["abap", "ada", "angular-html", "apache", "apex", "apl", "applescript", "ara", "asciidoc", "asm", "astro", "awk", "ballerina", "bat", "beancount", "berry", "bibtex", "bicep", "bird2", "blade", "bsl", "c", "c3", "cadence", "cairo", "chapel", "clarity", "clojure", "cmake", "cobol", "codeowners", "codeql", "coffee"];
    expect(languages.length).toBeGreaterThan(MAX_RESIDENT_LANGUAGES);
    for (const [index, language] of languages.entries()) {
      await runtime.tokenize("x\n", language, { id: `budget-${index}`, version: 1, state: "done" });
      await runtime["warming"].get(language);
    }
    expect(runtime.consumeRecycle()).toBe(true);
    runtime.dispose();
  }, 60_000);

  test("after warm-up a document compiles no regex", async () => {
    const documents = [["cpp", "#include <vector>\nstd::vector<int> values;\nint main() { return values.size(); }\n"], ["typescript", viteConfig]] as const;
    for (const [language, source] of documents) {
      const runtime = new TokenizerRuntime(() => {});
      await runtime.tokenize("x\n", language, { id: "load", version: 1, state: "done" });
      await runtime["warming"].get(language);
      const before = runtime.cacheSize();
      const tokens = await runtime.tokenize(source, language, { id: "warm", version: 1, state: "done" });
      expect(text(tokens)).toBe(source);
      expect(runtime.cacheSize()).toEqual(before);
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
      expect(counter.attempts).toBe(3);
      expect(typedPerLine(tokens).slice(0, 2)).toEqual([true, true]);
    } finally {
      if (nowDescriptor) Object.defineProperty(performance, "now", nowDescriptor);
      counter.runtime.dispose();
    }
  });

  // Every line here is slow, as in a document that embeds many cold
  // grammars: each line is tried at most twice, and the retries stop when the document's budget is spent.
  test("cold compiles across a document stay inside the document budget", async () => {
    const nowDescriptor = Object.getOwnPropertyDescriptor(performance, "now");
    let clock = 0;
    let counter: Awaited<ReturnType<typeof countAttempts>> | undefined;
    counter = await countAttempts("typescript", () => { clock += 12; });
    Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
    try {
      const lines = 50;
      const source = "const a = 1;\n".repeat(lines);
      const tokens = await counter.runtime.tokenize(source, "typescript", { id: "budget", version: 1, state: "done" });
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
  type Request = { requestId: number; code: string; context: { id: string } };
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
  const answer = (worker: Scripted, index: number) => worker.send({ requestId: worker.posted[index].requestId, tokens: colored(worker.posted[index].code), provisional: false });
  const block = (id: string) => ({ id, version: 1, state: "done" as const });
  const ticks = async () => { for (let i = 0; i < 3; i++) await Promise.resolve(); };
  const withFakeTimers = (run: () => Promise<void>) => async () => { jest.useFakeTimers(); try { await run(); } finally { jest.useRealTimers(); } };

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
    jest.advanceTimersByTime(9_999);
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
    jest.advanceTimersByTime(10_000);
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
    jest.advanceTimersByTime(10_000 + 250);
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
    workers[0].send({ requestId: first.requestId, tokens: [{ text: "c", type: "string" }], provisional: false, of: 1 });
    workers[0].send({ requestId: second.requestId, tokens: [{ text: "d" }], provisional: false, of: 2 });
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
    workers[0].send({ requestId: second.requestId, tokens: [{ text: "yz", type: "string" }], provisional: false, of: 2 });
    workers[0].send({ requestId: first.requestId, tokens: [{ text: "c" }], provisional: false, of: 1 });
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
      worker.send({ requestId: worker.posted[0].requestId, tokens: [{ text: "c" }], provisional: false, of: 1 });
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
  worker.postMessage({ type: "highlight", requestId: 1, code, language: "json", context: { id: "paced", version: 1, state: "done" } });
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
  worker.postMessage({ type: "highlight", requestId: 1, code, language: "json", context: { id: "long", version: 1, state: "done" } });
  await until(() => messages.some((message) => "part" in message));
  const of = messages.at(-1)!.of;
  const seen = messages.length;
  worker.postMessage({ type: "highlight", requestId: 2, code: "[1]\n", language: "json", context: { id: "small", version: 1, state: "done" } });
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
  });

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
  await warmLanguage("typescript");
  const highlighter = directHighlighter;
  const context = { id: "same-surface", version: 7, state: "done" as const };
  const first = await highlighter("let a = 1;", "typescript", context);
  expect(first.map((token: Token) => token.text).join("")).toBe("let a = 1;");
  const second = await highlighter("var b = 2;", "typescript", context);
  expect(second.map((token: Token) => token.text).join("")).toBe("var b = 2;");
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

  test("a worker answers between warm-up slices, and re-sends each provisional block once when warm", async () => {
    const updates: Array<{ id: string; language: string; tokens: Token[] }> = [];
    const runtime = new TokenizerRuntime((context, language, tokens) => updates.push({ id: context.id, language, tokens }));
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

    // Once warm, a line over the limit is really slow: it stays plain, final, and is never re-sent.
    const slow = await withClock(50, () => runtime.tokenize("[2]\n", "typescript", { id: "slow", version: 1, state: "done" }));
    expect(slow).toEqual([{ text: "[2]\n" }]);
    expect(runtime.willUpdate({ id: "slow", version: 1, state: "done" })).toBe(false);
    expect(runtime["provisional"].size).toBe(0);
    runtime.dispose();
  }, 60_000);

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
