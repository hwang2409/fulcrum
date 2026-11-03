import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import vue from "@shikijs/langs/vue";
import svelte from "@shikijs/langs/svelte";
import julia from "@shikijs/langs/julia";
import { semanticTheme } from "../packages/highlight/src/scopes.js";
import { createHighlighter } from "../packages/highlight/dist/index.js";

type Token = { text: string; type?: string };
type Fixture = { legacy: Record<string, { source: string; lines: Token[][] }>; newReference: Record<string, { source: string; lines: Token[][] }> };
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
  markdown: "# title\n\n- **fast**\n- `minimal`\n",
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
  vue: "<template><button @click=\"count++\">{{ count }}</button></template>\n<script setup>const count = ref(0);</script>\n",
  svelte: "<script>let count = 0;</script>\n<button on:click={() => count++}>{count}</button>\n",
  julia: "function greet(name)\n  println(\"hello $name\")\nend\n",
};
const fixturePath = resolve(import.meta.dir, "../packages/highlight/test/fixtures/token-parity.json");
const tokenTypes: Record<string, string> = { "#000001": "keyword", "#000002": "string", "#000003": "number", "#000004": "comment", "#000005": "function", "#000006": "type", "#000007": "variable", "#000008": "constant", "#000009": "operator", "#00000a": "punctuation", "#00000b": "tag", "#00000c": "attribute", "#00000d": "regexp", "#00000e": "inserted", "#00000f": "deleted" };
function split(tokens: Token[]): Token[][] { const out: Token[][] = [[]]; for (const token of tokens) for (const [i, text] of token.text.split("\n").entries()) { if (text) out.at(-1)!.push({ text, ...(token.type ? { type: token.type } : {}) }); if (i < token.text.split("\n").length - 1) out.push([]); } return out; }
function typed(lines: Token[][]) { return lines.some((line) => line.some((token) => token.type)); }
async function finalTokens(highlight: ReturnType<typeof createHighlighter>, source: string, language: string, id: string) {
  const context = { id, version: 1, state: "done" as const };
  return await new Promise<Token[]>((resolveResult, reject) => {
    let settled = false;
    const timeout = setTimeout(() => { unsubscribe(); reject(new Error(`colored final state not observed for ${language} (${id})`)); }, 10_000);
    const unsubscribe = highlight.subscribe(id, () => {
      const next = highlight(source, language, context);
      if (next instanceof Promise) void next.then((tokens) => { if (!settled && typed(split(tokens))) { settled = true; clearTimeout(timeout); unsubscribe(); resolveResult(tokens); } });
      else if (next && typed(split(next))) { settled = true; clearTimeout(timeout); unsubscribe(); resolveResult(next); }
    });
    void highlight(source, language, context);
  });
}
async function controllerSamples(highlight: ReturnType<typeof createHighlighter>, inputs: Record<string, string>, prefix: string) {
  const out: Record<string, { source: string; lines: Token[][] }> = {};
  for (const [language, source] of Object.entries(inputs)) out[language] = { source, lines: split(await finalTokens(highlight, source, language, `${prefix}-${language}`)) };
  return out;
}
async function legacy(expected?: Fixture["legacy"]) {
  const highlighter = createHighlighter();
  try {
    const out = await controllerSamples(highlighter, samples, "parity");
    if (expected) {

    }
    return out;
  } finally { highlighter.dispose(); }
}
async function reference() {
  const out: Fixture["newReference"] = {};
  for (const [language, source] of Object.entries(newSamples)) {
    const engine = createJavaScriptRegexEngine();
    const grammar = language === "vue" ? vue : language === "svelte" ? svelte : julia;
    const highlighter = await createHighlighterCore({ engine, langs: [grammar], themes: [semanticTheme] });
    highlighter.codeToTokens(source, { lang: language, theme: semanticTheme });
    highlighter.codeToTokens(source, { lang: language, theme: semanticTheme });
    const lines = split(highlighter.codeToTokens(source, { lang: language, theme: semanticTheme }).tokens.flat().map((token) => ({ text: token.content, ...(tokenTypes[token.color?.toLowerCase() ?? ""] ? { type: tokenTypes[token.color!.toLowerCase()] } : {}) })));
    if (!typed(lines)) throw new Error(`direct reference has no typed token: ${language}`);
    out[language] = { source, lines };
  }
  return out;
}
const mode = process.argv[2] ?? "check";
if (mode === "generate") { await mkdir(resolve(fixturePath, ".."), { recursive: true }); const newReference = await reference(); const highlighter = createHighlighter(); try { const fixture: Fixture = { legacy: await controllerSamples(highlighter, samples, "fixture"), newReference }; await writeFile(fixturePath, JSON.stringify(fixture, null, 2) + "\n"); } finally { highlighter.dispose(); } console.log(`wrote token parity fixture: ${Object.keys(samples).length} legacy languages, ${Object.keys(newSamples).length} direct references`); }
else {
  const expected = JSON.parse(await readFile(fixturePath, "utf8")) as Fixture;
  const direct = await reference(); if (JSON.stringify(direct) !== JSON.stringify(expected.newReference)) { await writeFile("/tmp/direct-reference.json", JSON.stringify(direct, null, 2)); throw new Error("direct Shiki reference samples changed"); }
  const actual = await legacy(expected.legacy); if (JSON.stringify(actual) !== JSON.stringify(expected.legacy)) throw new Error("legacy token parity failed on real-clock run 1");
  console.log(`token parity passed: ${Object.keys(expected.legacy).length} legacy languages, ${Object.keys(expected.newReference).length} direct references, final colored updates`);
}
