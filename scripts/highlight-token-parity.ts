import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine, defaultJavaScriptRegexConstructor } from "@shikijs/engine-javascript";
import vue from "@shikijs/langs/vue";
import svelte from "@shikijs/langs/svelte";
import julia from "@shikijs/langs/julia";
import { grammarPatterns, REGEX_TARGET } from "../packages/highlight/src/regex.js";
import { semanticTheme } from "../packages/highlight/src/scopes.js";
import type { CompletionNotice, Highlight } from "../packages/highlight/src/types.js";

type Token = { text: string; type?: string };
type Sample = { source: string; lines: Token[][] };
type Fixture = { source: { ref: string; sha: string }; legacy: Record<string, Sample>; newReference: Record<string, Sample> };
type ResolverContract = { aliases: Record<string, string | null> };
const samples: Record<string, string> = {
  tsx: "type Props = { name: string };\nexport const View = ({ name }: Props) => <main className=\"card\">{name}</main>;\n",
  typescript: "type User = { id: number };\nconst greet = (user: User) => `hi ${user.id}`;\n",
  javascript: "function add(a, b) { return a + b; }\nconst answer = add(1, 2);\n",
  jsx: "export function View({ name }) {\n  return <main className=\"card\">{name}</main>;\n}\n",
  python: "def greet(name: str):\n    return f\"hello {name}\"\n",
  shell: "#!/bin/sh\nname=world\nprintf 'hello %s\\n' \"$name\"\n",
  json: '{\n  "ok": true,\n  "count": 2\n}\n',
  diff: "@@ -1,2 +1,2 @@\n-old value\n+new value\n",
  rust: "fn main() {\n    let value: u32 = 42;\n    println!(\"{value}\");\n}\n",
  go: "package main\n\nfunc main() {\n\tprintln(\"hello\")\n}\n",
  sql: "SELECT id, name\nFROM users\nWHERE active = TRUE;\n",
  yaml: "name: fulcrum\nitems:\n  - fast\n  - minimal\n",
  css: ".card {\n  color: red;\n  display: block;\n}\n",
  html: "<style>.card { color: red; }</style>\n<script>const answer = 42;</script>\n<article data-id=\"1\">hello</article>\n",
  markdown: "# title\n\n```typescript\nconst answer: number = 42;\n```\n",
  toml: "[package]\nname = \"fulcrum\"\nversion = \"1.0\"\n",
  dockerfile: "FROM oven/bun:1\nWORKDIR /app\nCOPY . .\nRUN bun test\n",
  c: "#include <stdio.h>\nint main(void) { printf(\"hi\\n\"); }\n",
  cpp: "#include <vector>\nint main() { std::vector<int> values{1, 2}; }\n",
  java: "class Main {\n  public static void main(String[] args) { System.out.println(\"hi\"); }\n}\n",
  kotlin: "fun main() {\n  val answer: Int = 42\n  println(answer)\n}\n",
  swift: "let answer: Int = 42\nprint(answer)\n",
  ruby: "def greet(name)\n  puts \"hello #{name}\"\nend\n",
  php: "<?php\n$name = \"fulcrum\";\necho $name;\n",
  lua: "local answer = 42\nprint(answer)\n",
  makefile: "build:## compile the project\n\tbun run build\n",
  ini: "[core]\nname=fulcrum\nenabled=true\n",
  xml: "<?xml version=\"1.0\"?>\n<root><item id=\"1\">hello</item></root>\n",
  graphql: "query User($id: ID!) {\n  user(id: $id) { name }\n}\n",
  protobuf: "syntax = \"proto3\";\nmessage User { string name = 1; }\n",
};
const regressionOrder = ["tsx", "jsx", "typescript", "javascript", "html", "vue", "svelte", "markdown", "julia", "python", "rust", "go", "c", "cpp", "shell", "json", "yaml", "toml", "sql", "diff"];
const newSamples: Record<string, string> = {
  vue: "<template><button @click=\"count++\">{{ count }}</button></template>\n<script setup lang=\"ts\">const count = ref(0);</script>\n",
  svelte: "<script lang=\"ts\">let count: number = 0;</script>\n<button on:click={() => count++}>{count}</button>\n",
  julia: "function greet(name)\n  println(\"hello $name\")\nend\n",
};
const fixturePath = resolve(import.meta.dir, "../packages/highlight/test/fixtures/token-parity.json");
const resolverPath = resolve(import.meta.dir, "../packages/highlight/test/fixtures/resolver-contract.json");
const tokenTypes: Record<string, string> = { "#000001": "keyword", "#000002": "string", "#000003": "number", "#000004": "comment", "#000005": "function", "#000006": "type", "#000007": "variable", "#000008": "constant", "#000009": "operator", "#00000a": "punctuation", "#00000b": "tag", "#00000c": "attribute", "#00000d": "regexp", "#00000e": "inserted", "#00000f": "deleted" };
function split(tokens: Token[]): Token[][] {
  const out: Token[][] = [[]];
  for (const token of tokens) {
    const parts = token.text.split("\n");
    for (const [index, text] of parts.entries()) {
      if (text) out.at(-1)!.push({ text, ...(token.type ? { type: token.type } : {}) });
      if (index < parts.length - 1) out.push([]);
    }
  }
  return out;
}
function typed(lines: Token[][]) { return lines.some((line) => line.some((token) => token.type)); }
function terminal(completion: CompletionNotice, language: string): void {
  if (completion.status === "complete") return;
  const reason = completion.reason ? ` (${completion.reason})` : "";
  throw new Error(`${language} version ${completion.version} completed ${completion.status}${reason}`);
}
async function within<T>(promise: Promise<T>, language: string, timeoutMs = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${language} completion exceeded ${timeoutMs / 1_000}s`)), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
async function finalTokens(highlight: Highlight, source: string, language: string, id: string, version: number) {
  const context = { id, version, state: "done" as const };
  const historical = process.env.HISTORICAL_COMPLETION === "1" && typeof highlight.awaitCompletion !== "function";
  let updated: Promise<void> | undefined;
  let unsubscribe: (() => void) | undefined;
  if (historical) updated = new Promise((resolve) => { unsubscribe = highlight.subscribe(id, () => resolve()); });
  const first = highlight(source, language, context);
  if (first === null) throw new Error(`main registry fixture is not supported by this build: ${language}`);
  const initial = await first;
  if (historical) {
    if (!typed(split(initial))) await within(updated!, language, 15_000).catch(() => undefined);
    unsubscribe!();
  } else {
    if (typeof highlight.awaitCompletion !== "function") throw new Error("highlight build does not expose awaitCompletion; HISTORICAL_COMPLETION=1 is only for the ffc3883 regression proof");
    terminal(await within(highlight.awaitCompletion(id, version), language), language);
  }
  const final = highlight(source, language, context);
  if (final === null) throw new Error(`completed fixture stopped resolving: ${language}`);
  return await final;
}
async function controllerSamples(highlight: Highlight, inputs: Record<string, string>, prefix: string) {
  const out: Record<string, Sample> = {};
  for (const [language, source] of Object.entries(inputs)) {
    const id = `${prefix}-${language}`;
    const historical = process.env.HISTORICAL_COMPLETION === "1" && typeof highlight.awaitCompletion !== "function";
    if (!historical) void highlight(source.slice(0, Math.max(1, Math.floor(source.length / 2))), language, { id, version: 1, state: "streaming" });
    if (process.env.HIGHLIGHT_PARITY_DIAGNOSTIC === "1") console.error(`parity block: ${id}`);
    out[language] = { source, lines: split(await finalTokens(highlight, source, language, id, historical ? 1 : 2)) };
  }
  return out;
}
async function legacyLanguages() {
  const contract = JSON.parse(await readFile(resolverPath, "utf8")) as ResolverContract;
  return [...new Set(Object.values(contract.aliases).filter((language): language is string => language !== null))].sort();
}
async function assertLegacyCoverage() {
  const expected = await legacyLanguages();
  const actual = Object.keys(samples).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`legacy samples do not match main's generated registry:\nexpected: ${expected.join(", ")}\nactual: ${actual.join(", ")}`);
}
async function reference() {
  const out: Fixture["newReference"] = {};
  for (const [language, source] of Object.entries(newSamples)) {
    const grammar = language === "vue" ? vue : language === "svelte" ? svelte : julia;
    const cache = new Map<string, RegExp | Error>();
    for (const pattern of grammarPatterns(grammar)) {
      try {
        const regex = defaultJavaScriptRegexConstructor(pattern, { target: REGEX_TARGET });
        regex.exec("");
        regex.lastIndex = 0;
        cache.set(pattern, regex);
      } catch (cause) { cache.set(pattern, cause instanceof Error ? cause : new Error(String(cause))); }
    }
    const engine = createJavaScriptRegexEngine({ target: REGEX_TARGET, cache });
    const highlighter = await createHighlighterCore({ engine, langs: [grammar], themes: [semanticTheme] });
    try {
      highlighter.codeToTokens(source, { lang: language, theme: semanticTheme });
      highlighter.codeToTokens(source, { lang: language, theme: semanticTheme });
      const lines = split(highlighter.codeToTokens(source, { lang: language, theme: semanticTheme }).tokens.flat().map((token) => ({ text: token.content, ...(tokenTypes[token.color?.toLowerCase() ?? ""] ? { type: tokenTypes[token.color!.toLowerCase()] } : {}) })));
      if (!typed(lines)) throw new Error(`direct reference has no typed token: ${language}`);
      out[language] = { source, lines };
    } finally { highlighter.dispose(); }
  }
  return out;
}
function differences(actual: Record<string, Sample>, expected: Record<string, Sample>) {
  return Object.keys(expected).filter((language) => JSON.stringify(actual[language]) !== JSON.stringify(expected[language]));
}
function firstDifference(actual: Sample, expected: Sample): string {
  const lines = Math.max(actual.lines.length, expected.lines.length);
  for (let line = 0; line < lines; line++) {
    const actualLine = actual.lines[line] ?? [];
    const expectedLine = expected.lines[line] ?? [];
    const tokens = Math.max(actualLine.length, expectedLine.length);
    for (let token = 0; token < tokens; token++) {
      if (JSON.stringify(actualLine[token]) !== JSON.stringify(expectedLine[token]))
        return `line ${line + 1}, token ${token + 1}: expected ${JSON.stringify(expectedLine[token] ?? null)}, actual ${JSON.stringify(actualLine[token] ?? null)}`;
    }
  }
  return "source metadata differs";
}
function shuffled<T>(values: T[], seed: number): T[] {
  const out = [...values];
  let state = seed >>> 0;
  for (let index = out.length - 1; index > 0; index--) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const swap = state % (index + 1);
    [out[index], out[swap]] = [out[swap]!, out[index]!];
  }
  return out;
}
async function capture(command: string[], cwd = import.meta.dir): Promise<string> {
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (status) throw new Error(`${command.join(" ")} failed: ${stderr.trim()}`);
  return stdout.trim();
}
async function run(command: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
  if (await proc.exited) throw new Error(`${command.join(" ")} failed`);
}
async function withBuiltRef<T>(ref: string, use: (root: string, sha: string) => Promise<T>): Promise<T> {
  const sha = await capture(["git", "rev-parse", "--verify", `${ref}^{commit}`]);
  const commonDir = resolve(await capture(["git", "rev-parse", "--git-common-dir"]));
  const worktrees = resolve(dirname(commonDir), ".worktrees");
  await mkdir(worktrees, { recursive: true });
  const path = await mkdtemp(resolve(worktrees, "token-parity-"));
  await rm(path, { recursive: true });
  await run(["git", "worktree", "add", "--detach", path, sha], dirname(commonDir));
  try {
    await run(["bun", "run", "--cwd", resolve(path, "packages/highlight"), "build"], path);
    return await use(resolve(path, "packages/highlight"), sha);
  } finally {
    await run(["git", "worktree", "remove", "--force", path], dirname(commonDir));
  }
}
await assertLegacyCoverage();
const mode = process.argv[2] ?? "check";
if (mode === "generate") {
  if (process.argv[3] !== "--from" || !process.argv[4]) throw new Error("usage: bun scripts/highlight-token-parity.ts generate --from <main-ref>");
  const ref = process.argv[4];
  const sha = await capture(["git", "rev-parse", "--verify", `${ref}^{commit}`]);
  const mainSha = await capture(["git", "rev-parse", "--verify", "origin/main^{commit}"]);
  const exactSha = /^[0-9a-f]{40}$/.test(ref) && ref === sha;
  if ((ref !== "origin/main" && !exactSha) || sha !== mainSha)
    throw new Error(`--from must be origin/main or its exact sha (${mainSha})`);
  await withBuiltRef(ref, async (packageRoot, sha) => {
    const { createHighlighter } = await import(`${packageRoot}/dist/index.js`) as { createHighlighter: () => Highlight };
    const newReference = await reference();
    const highlighter = createHighlighter();
    try {
      const fixture: Fixture = { source: { ref, sha }, legacy: await controllerSamples(highlighter, samples, "fixture"), newReference };
      await mkdir(resolve(fixturePath, ".."), { recursive: true });
      await writeFile(fixturePath, JSON.stringify(fixture, null, 2) + "\n");
    } finally { highlighter.dispose(); }
  });
  console.log(`wrote token parity fixture from ${ref}: ${Object.keys(samples).length} legacy languages, ${Object.keys(newSamples).length} direct references`);
} else {
  const packageRoot = resolve(process.env.HIGHLIGHT_ROOT ?? resolve(import.meta.dir, "../packages/highlight"));
  const { createHighlighter } = await import(`${packageRoot}/dist/index.js`) as { createHighlighter: () => Highlight };
  const expected = JSON.parse(await readFile(fixturePath, "utf8")) as Fixture;
  // the fixture must come from main's history, but it does not have to be main's tip:
  // final tokens are compared below, so a later main commit that keeps them passes
  // without regenerating, and only an intended token change needs a new fixture.
  const mainSha = await capture(["git", "merge-base", "HEAD", "origin/main"]);
  const source = expected.source?.sha ?? "missing";
  await capture(["git", "merge-base", "--is-ancestor", source, mainSha]).catch(() => {
    throw new Error(`token fixture source ${source} is not in main's history (main ${mainSha}); regenerate from origin/main`);
  });
  const probe = createHighlighter();
  const historical = process.env.HISTORICAL_COMPLETION === "1" && typeof probe.awaitCompletion !== "function";
  probe.dispose();
  const allInputs = { ...samples, ...newSamples };
  const historicalOrder = [...regressionOrder, ...Object.keys(allInputs).filter((language) => !regressionOrder.includes(language))];
  const inputs = historical ? Object.fromEntries(historicalOrder.map((language) => [language, allInputs[language]!])) : samples;
  const expectedTokens = historical ? { ...expected.legacy, ...expected.newReference } : expected.legacy;
  const seed = Number(process.env.HIGHLIGHT_PARITY_SEED ?? "51");
  if (!Number.isSafeInteger(seed)) throw new Error("HIGHLIGHT_PARITY_SEED must be an integer");
  const orders = [
    ["forward", Object.keys(inputs)],
    ["reverse", Object.keys(inputs).reverse()],
    ["shuffle", shuffled(Object.keys(inputs), seed)],
  ] as const;
  const wave = process.env.HIGHLIGHT_PARITY_WAVE ? JSON.parse(process.env.HIGHLIGHT_PARITY_WAVE) as string[] : undefined;
  if (wave) {
    const results: Record<string, Record<string, Sample>> = {};
    for (const name of wave) {
      const isolatedLanguage = name.startsWith("isolation-") ? name.slice("isolation-".length) : undefined;
      const order = isolatedLanguage ? [isolatedLanguage] : orders.find(([orderName]) => orderName === name)?.[1];
      if (!order?.length || order.some((language) => !inputs[language])) throw new Error(`unknown parity scenario: ${name}`);
      const orderedInputs = Object.fromEntries(order.map((language) => [language, inputs[language]!]));
      const highlighter = createHighlighter();
      try { results[name] = await controllerSamples(highlighter, orderedInputs, `parity-${name}`); }
      finally { highlighter.dispose(); }
    }
    console.log(JSON.stringify(results));
    process.exit(0);
  }
  const direct = await reference();
  const referenceDifferences = differences(direct, expected.newReference);
  if (referenceDifferences.length) throw new Error(`direct Shiki reference changed: ${referenceDifferences.join(", ")}`);
  const failures = new Set<string>();
  const failedScenarios: string[] = [];
  const runs: Record<string, Record<string, Sample>> = {};
  const compare = (name: string, actual: Record<string, Sample>, orderedInputs: Record<string, string>) => {
    runs[name] = actual;
    const scenarioExpected = Object.fromEntries(Object.keys(orderedInputs).map((language) => [language, expectedTokens[language]!]));
    const changed = differences(actual, scenarioExpected);
    for (const language of changed) {
      failures.add(language);
      failedScenarios.push(`${name}/${language} block parity-${name}-${language}, first differing token ${firstDifference(actual[language]!, scenarioExpected[language]!)}`);
    }
  };
  const scenarios: [string, readonly string[]][] = [
    ...Object.keys(inputs).map((language): [string, string[]] => [`isolation-${language}`, [language]]), ...orders,
  ];
  const runWave = async (wave: typeof scenarios) => {
    const proc = Bun.spawn([process.execPath, import.meta.path], {
      env: { ...process.env, HIGHLIGHT_PARITY_WAVE: JSON.stringify(wave.map(([name]) => name)) }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (status) {
      const child = proc as typeof proc & { exitCode: number | null; signalCode?: string | null };
      throw new Error(`parity wave failed (exit code ${child.exitCode ?? "unknown"}, signal ${child.signalCode ?? "none"})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    const actual = JSON.parse(stdout) as Record<string, Record<string, Sample>>;
    for (const [name, order] of wave)
      compare(name, actual[name]!, Object.fromEntries(order.map((language) => [language, inputs[language]!])));
  };
  // Reserve one CPU wave for load-order scenarios so only one full registry is resident at a time.
  const isolated = scenarios.slice(0, Object.keys(inputs).length);
  const processCount = Math.min(availableParallelism(), 4);
  const isolationCount = Math.max(1, processCount - 1);
  const waves = Array.from({ length: isolationCount }, () => [] as typeof scenarios);
  isolated.forEach((entry, index) => waves[index % isolationCount]!.push(entry));
  const ordered = scenarios.slice(isolated.length);
  if (processCount === 1) {
    await runWave(waves[0]!);
    await runWave(ordered);
  } else {
    await Promise.all([...waves.map(runWave), runWave(ordered)]);
  }
  if (failures.size) {
    await writeFile("/tmp/highlight-token-parity-actual.json", JSON.stringify(runs, null, 2) + "\n");
    throw new Error(`legacy token parity failed: ${[...failures].join(", ")} (shuffle seed ${seed}; ${failedScenarios.join("; ")}; actual: /tmp/highlight-token-parity-actual.json)`);
  }
  console.log(`token parity passed: ${Object.keys(expected.legacy).length} main-registry languages, ${Object.keys(expected.newReference).length} direct references, isolated plus forward/reverse/shuffle order (seed ${seed}), exact completed revisions`);
}
