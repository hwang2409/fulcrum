import { afterAll, describe, expect, test } from "bun:test";
import type { Token } from "../src/index.js";
import { semanticTheme } from "../src/scopes.js";

const build = Bun.spawnSync(["bun", "run", "build"], { cwd: new URL("..", import.meta.url).pathname });
if (build.exitCode !== 0) throw new Error(build.stderr.toString());
const { createHighlighter } = await import("../dist/index.js");
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

  test("completed cache is capped at 64 blocks", async () => {
    let calls = 0;
    const fake: { onmessage: ((event: MessageEvent<{ requestId: number; tokens: Token[] }>) => void) | null; onerror: ((event: ErrorEvent) => unknown) | null; postMessage(value: { requestId?: number; code?: string }): void; terminate(): void } = {
      onmessage: null, onerror: null, terminate() {}, postMessage(value) { if (value.requestId) { calls++; queueMicrotask(() => fake.onmessage!({ data: { requestId: value.requestId!, tokens: [{ text: value.code! }] } } as MessageEvent<{ requestId: number; tokens: Token[] }>)); } },
    };
    const highlighter = createHighlighter({ workerFactory: () => fake });
    for (let index = 0; index < 65; index++) await highlighter(`const n = ${index};\n`, "typescript", { id: `cap-${index}`, version: 1, state: "done" });
    await highlighter("const n = 0;\n", "typescript", { id: "cap-0", version: 1, state: "done" });
    expect(calls).toBe(66);
    highlighter.dispose();
  });
});
