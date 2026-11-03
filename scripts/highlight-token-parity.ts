import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type Token = { text: string; type?: string };
type Highlighter = ((code: string, language: string, context: { id: string; version: number; state: "done" }) => Token[] | Promise<Token[]>) & { subscribe(id: string, listener: () => void): () => void; dispose(): void };

export const paritySnippets: Record<string, string> = {
  tsx: "type Props = { name: string };\nexport const View = ({ name }: Props) => <main className=\"card\">{name}</main>;\n",
  jsx: "export const App = () => <main className=\"app\">hello</main>;\n",
  typescript: "type User = { id: number };\nconst greet = (user: User) => `hi ${user.id}`;\n",
  javascript: "function add(a, b) { return a + b; }\n",
  html: "<style>.card { color: red; }</style>\n<script>const answer = 42;</script>\n<article data-id=\"1\">hello</article>\n",
  vue: "<template><button @click=\"count++\">{{ count }}</button></template>\n<script setup lang=\"ts\">const count = ref(0);</script>\n",
  svelte: "<script>let count = 0;</script>\n<button on:click={() => count++}>{count}</button>\n",
  markdown: "# title\n\n```typescript\nconst answer: number = 42;\n```\n",
  julia: "function greet(name)\n  println(\"hello $name\")\nend\n",
  python: "def greet(name: str):\n    return f\"hello {name}\"\n",
  rust: "fn main() { let value: u32 = 42; println!(\"{value}\"); }\n",
  go: "package main\nfunc main() { println(\"hello\") }\n",
  c: "#include <stdio.h>\nint main(void) { return 0; }\n",
  cpp: "#include <vector>\nstd::vector<int> values;\n",
  shell: "#!/bin/sh\nfor file in *.ts; do echo \"$file\"; done\n",
  json: "{\n  \"ok\": true,\n  \"count\": 2\n}\n",
  yaml: "name: fulcrum\nitems:\n  - one\n  - two\n",
  toml: "[package]\nname = \"fulcrum\"\nversion = \"1.0\"\n",
  sql: "SELECT id, name FROM users WHERE active = true;\n",
  diff: "diff --git a/file.ts b/file.ts\n-old line\n+new line\n",
};

function serialize(tokens: Token[]) {
  return tokens.map(({ text, type }) => ({ text, ...(type ? { type } : {}) }));
}

async function colored(highlighter: Highlighter, language: string, code: string, id: string) {
  let resolveUpdate!: () => void;
  const updated = new Promise<void>((resolve) => { resolveUpdate = resolve; });
  const stop = highlighter.subscribe(id, resolveUpdate);
  const first = await highlighter(code, language, { id, version: 1, state: "done" });
  if (first?.some((token) => token.type)) { stop(); return first; }
  const deadline = Date.now() + 30_000;
  let final = first;
  while (Date.now() < deadline) {
    await Promise.race([updated, new Promise((resolve) => setTimeout(resolve, 25))]);
    final = await highlighter(code, language, { id, version: 1, state: "done" });
    if (final?.some((token) => token.type)) break;
  }
  stop();
  return final ?? first ?? [];
}

const root = resolve(import.meta.dir, "../packages/highlight");
const fixturePath = resolve(root, "test/fixtures/token-parity.json");
const mode = process.argv[2] ?? "check";
const baselineRoot = resolve(process.env.MAIN_HIGHLIGHT_ROOT ?? resolve(root, "../../.worktrees/pr45-main/packages/highlight"));
const packageRoot = mode === "generate" ? baselineRoot : root;
const { createHighlighter } = await import(`${packageRoot}/dist/index.js`) as { createHighlighter: () => Highlighter };
const highlighter = createHighlighter();
const output: Record<string, { source: string; lines: Token[][] }> = {};
try {
  for (const [language, source] of Object.entries(paritySnippets)) {
    const tokens = await colored(highlighter, language, source, `parity-${language}`);
    const lines: Token[][] = Array.from({ length: source.split("\n").length }, () => []);
    let line = 0;
    for (const token of tokens) for (const [index, text] of token.text.split("\n").entries()) {
      if (text) lines[line]!.push({ text, ...(token.type ? { type: token.type } : {}) });
      if (index < token.text.split("\n").length - 1) line++;
    }
    output[language] = { source, lines };
  }
} finally { highlighter.dispose(); }
if (mode === "generate") {
  await mkdir(resolve(fixturePath, ".."), { recursive: true });
  await writeFile(fixturePath, JSON.stringify(output, null, 2) + "\n");
  console.log(`wrote ${fixturePath}`);
} else {
  const expected = JSON.parse(await readFile(fixturePath, "utf8")) as typeof output;
  const differences: string[] = [];
  for (const language of Object.keys(expected)) {
    const actual = output[language];
    if (JSON.stringify(actual) !== JSON.stringify(expected[language])) differences.push(language);
  }
  if (differences.length) throw new Error(`token parity failed: ${differences.join(", ")}`);
  console.log(`token parity passed: ${Object.keys(expected).length} languages`);
}
