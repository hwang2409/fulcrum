import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import vue from "@shikijs/langs/vue";
import svelte from "@shikijs/langs/svelte";
import julia from "@shikijs/langs/julia";
import { semanticTheme } from "../packages/highlight/src/scopes.js";
import { createHighlighter } from "../packages/highlight/src/index.js";

type Token = { text: string; type?: string };
type Fixture = { legacy: Record<string, { source: string; lines: Token[][] }>; newReference: Record<string, { source: string; lines: Token[][] }> };
export const paritySnippets: Record<string, string> = {
  tsx: "type Props = { name: string };\nexport const View = ({ name }: Props) => <main className=\"card\">{name}</main>;\n",
  typescript: "type User = { id: number };\nconst greet = (user: User) => `hi ${user.id}`;\n",
  html: "<style>.card { color: red; }</style>\n<script>const answer = 42;</script>\n<article data-id=\"1\">hello</article>\n",
  javascript: "function add(a, b) { return a + b; }\n", python: "def greet(name: str):\n    return f\"hello {name}\"\n", rust: "fn main() { let value: u32 = 42; }\n", json: '{\n  "ok": true\n}\n',
};
export const newSnippets: Record<string, string> = {
  vue: "<template><button @click=\"count++\">{{ count }}</button></template>\n<script setup>const count = ref(0);</script>\n",
  svelte: "<script>let count = 0;</script>\n<button on:click={() => count++}>{count}</button>\n",
  julia: "function greet(name)\n  println(\"hello $name\")\nend\n",
};
const fixturePath = resolve(import.meta.dir, "../packages/highlight/test/fixtures/token-parity.json");
const tokenTypes: Record<string, string> = { "#000001": "keyword", "#000002": "string", "#000003": "number", "#000004": "comment", "#000005": "function", "#000006": "type", "#000007": "variable", "#000008": "constant", "#000009": "operator", "#00000a": "punctuation", "#00000b": "tag", "#00000c": "attribute", "#00000d": "regexp", "#00000e": "inserted", "#00000f": "deleted" };
function lines(source: string, tokens: Token[][]) { return { source, lines: tokens }; }
function split(tokens: Token[]): Token[][] { const out: Token[][] = [[]]; for (const token of tokens) for (const [i, text] of token.text.split("\n").entries()) { if (text) out.at(-1)!.push({ text, ...(token.type ? { type: token.type } : {}) }); if (i < token.text.split("\n").length - 1) out.push([]); } return out; }
async function legacy() {
  const highlighter = createHighlighter();
  const out: Fixture["legacy"] = {};
  try { for (const [language, source] of Object.entries(paritySnippets)) out[language] = lines(source, split(await highlighter(source, language, { id: `parity-${language}`, version: 1, state: "done" }))); }
  finally { highlighter.dispose(); }
  return out;
}
async function reference() {
  const engine = createJavaScriptRegexEngine();
  const highlighter = await createHighlighterCore({ engine, langs: [vue, svelte, julia], themes: [semanticTheme] });
  const out: Fixture["newReference"] = {};
  for (const [language, source] of Object.entries(newSnippets)) {
    const tokens = highlighter.codeToTokens(source, { lang: language, theme: semanticTheme });
    out[language] = lines(source, split(tokens.tokens.flat().map((token) => ({ text: token.content, ...(tokenTypes[token.color?.toLowerCase() ?? ""] ? { type: tokenTypes[token.color!.toLowerCase()!] } : {}) }))));
    if (!out[language]!.lines.some((line) => line.some((token) => token.type))) throw new Error(`direct reference has no typed token: ${language}`);
  }
  return out;
}
const mode = process.argv[2] ?? "check";
if (mode === "generate") { await mkdir(resolve(fixturePath, ".."), { recursive: true }); await writeFile(fixturePath, JSON.stringify({ legacy: await legacy(), newReference: await reference() }, null, 2) + "\n"); console.log("wrote token parity fixture"); }
else {
  const expected = JSON.parse(await readFile(fixturePath, "utf8")) as Fixture;
  for (let run = 1; run <= 3; run++) { const actual = await legacy(); if (JSON.stringify(actual) !== JSON.stringify(expected.legacy)) throw new Error(`legacy token parity failed on real-clock run ${run}`); }
  const direct = await reference(); if (JSON.stringify(direct) !== JSON.stringify(expected.newReference)) throw new Error("direct Shiki reference parity failed");
  console.log(`token parity passed: ${Object.keys(expected.legacy).length} legacy languages, ${Object.keys(expected.newReference).length} direct references, 3 runs`);
}
