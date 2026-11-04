import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import vue from "@shikijs/langs/vue";
import svelte from "@shikijs/langs/svelte";
import julia from "@shikijs/langs/julia";
import { semanticTheme } from "../packages/highlight/src/scopes.js";
import type { CompletionNotice, Highlight } from "../packages/highlight/src/types.js";

type Token = { text: string; type?: string };
type Sample = { source: string; lines: Token[][] };
type Fixture = { legacy: Record<string, Sample>; newReference: Record<string, Sample> };
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
async function within<T>(promise: Promise<T>, language: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${language} completion exceeded 30s`)), 30_000); })]);
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
    if (!typed(split(initial))) await within(updated!, language);
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
    const engine = createJavaScriptRegexEngine();
    const grammar = language === "vue" ? vue : language === "svelte" ? svelte : julia;
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
await assertLegacyCoverage();
const mode = process.argv[2] ?? "check";
const packageRoot = resolve(process.env.HIGHLIGHT_ROOT ?? resolve(import.meta.dir, "../packages/highlight"));
const { createHighlighter } = await import(`${packageRoot}/dist/index.js`) as { createHighlighter: () => Highlight };
if (mode === "generate") {
  const newReference = await reference();
  const highlighter = createHighlighter();
  try {
    const fixture: Fixture = { legacy: await controllerSamples(highlighter, samples, "fixture"), newReference };
    await mkdir(resolve(fixturePath, ".."), { recursive: true });
    await writeFile(fixturePath, JSON.stringify(fixture, null, 2) + "\n");
  } finally { highlighter.dispose(); }
  console.log(`wrote token parity fixture: ${Object.keys(samples).length} legacy languages, ${Object.keys(newSamples).length} direct references`);
} else {
  const expected = JSON.parse(await readFile(fixturePath, "utf8")) as Fixture;
  const direct = await reference();
  const referenceDifferences = differences(direct, expected.newReference);
  if (referenceDifferences.length) throw new Error(`direct Shiki reference changed: ${referenceDifferences.join(", ")}`);
  const highlighter = createHighlighter();
  try {
    const historical = process.env.HISTORICAL_COMPLETION === "1" && typeof highlighter.awaitCompletion !== "function";
    const inputs = historical ? { ...samples, ...newSamples } : samples;
    const expectedTokens = historical ? { ...expected.legacy, ...expected.newReference } : expected.legacy;
    const actual = await controllerSamples(highlighter, inputs, "parity");
    const changed = differences(actual, expectedTokens);
    if (changed.length) {
      await writeFile("/tmp/highlight-token-parity-actual.json", JSON.stringify(actual, null, 2) + "\n");
      throw new Error(`legacy token parity failed: ${changed.join(", ")} (actual: /tmp/highlight-token-parity-actual.json)`);
    }
  } finally { highlighter.dispose(); }
  console.log(`token parity passed: ${Object.keys(expected.legacy).length} main-registry languages, ${Object.keys(expected.newReference).length} direct references, exact completed revisions`);
}
