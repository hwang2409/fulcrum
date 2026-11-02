import { describe, expect, test } from "bun:test";
import { createHighlighter, type Token, type TokenType } from "../src/index";

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
};

const text = (tokens: Token[]) => tokens.map((token) => token.text).join("");

async function full(language: string, code: string) {
  const highlighter = createHighlighter({ worker: false });
  const result = await highlighter(code, language, { id: `full-${language}`, version: 1, state: "done" });
  highlighter.dispose();
  return result!;
}

describe("language and scope mapping", () => {
  for (const [language, code] of Object.entries(samples)) {
    test(`${language} reconstructs the exact source`, async () => {
      const tokens = await full(language, code);
      expect(text(tokens)).toBe(code);
      expect(tokens.some((token) => token.type)).toBe(true);
    });
  }

  test("maps representative textmate scopes to the fixed token types", async () => {
    const tokens = await full("typescript", "// note\nconst value: number = /x+/gi.test(\"12\") ? 12 : 0;\nfunction run() {}\n");
    const types = new Set(tokens.map((token) => token.type));
    for (const type of ["comment", "keyword", "type", "regexp", "string", "number", "function", "operator"] satisfies TokenType[])
      expect(types).toContain(type);
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
      expect(streamed).toEqual(await full(language, code));
      highlighter.dispose();
    });
  }

  test("keeps an incomplete line plain until it is complete", async () => {
    const highlighter = createHighlighter({ worker: false });
    const partial = await highlighter("const value", "typescript", { id: "partial", version: 1, state: "streaming" });
    expect(partial).toEqual([{ text: "const value" }]);
    const complete = await highlighter("const value = 1;\n", "typescript", { id: "partial", version: 2, state: "streaming" });
    expect(text(complete!)).toBe("const value = 1;\n");
    expect(complete!.some((token) => token.type)).toBe(true);
    highlighter.dispose();
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

  test("worker construction failure falls back without losing source", async () => {
    const highlighter = createHighlighter({ workerFactory: () => { throw new Error("blocked by csp"); } });
    const code = samples.python;
    expect(text((await highlighter(code, "python", { id: "worker-failure", version: 1, state: "done" }))!)).toBe(code);
    highlighter.dispose();
  });
});
