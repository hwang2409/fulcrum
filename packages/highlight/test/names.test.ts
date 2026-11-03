import { expect, test } from "bun:test";
import { aliases, advertisedLanguages, languageForContentType, languageForPath, normalizeLanguage } from "../src/names.js";

test("every generated language and alias resolves as a fence", () => {
  expect(advertisedLanguages.length).toBeGreaterThan(200);
  for (const language of advertisedLanguages) expect(normalizeLanguage(language)).toBe(language === "v" ? "verilog" : language);
  for (const [alias, language] of Object.entries(aliases)) expect(normalizeLanguage(alias)).toBe(language);
});

test("the expanded registry resolves representative paths", () => {
  const cases: Record<string, string> = {
    Dockerfile: "dockerfile", Makefile: "makefile", ".env": "dotenv", "main.cs": "csharp", "script.ps1": "powershell",
    "app.dart": "dart", "Main.scala": "scala", "lib.clj": "clojure", "app.ex": "elixir", "main.erl": "erlang",
    "Main.hs": "haskell", "lib.ml": "ocaml", "build.zig": "zig", "flake.nix": "nix", "main.tf": "terraform",
    "web.vue": "vue", "page.svelte": "svelte", "index.astro": "astro", "stats.R": "r", "analysis.jl": "julia",
    "Token.sol": "solidity", "schema.graphql": "graphql", "schema.prisma": "prisma", "query.sql": "sql", "config.toml": "toml",
    "config.ini": "ini", "data.csv": "csv", "data.tsv": "tsv", "paper.tex": "latex", "changes.diff": "diff", "server.log": "log",
  };
  for (const [path, language] of Object.entries(cases)) expect(languageForPath(path)).toBe(language);
});

test("a path resolves by extension, then by well-known file name", () => {
  const cases: Record<string, string | undefined> = {
    "src/a.ts": "typescript", "web/App.TSX": "tsx", "a.mjs": "javascript", "tool.py": "python", "types.pyi": "python",
    "Cargo.toml": "toml", "go.mod": undefined, "main.go": "go", "lib.rs": "rust", "notes.md": "markdown", "page.mdx": "markdown",
    "Makefile": "makefile", "GNUmakefile": "makefile", "rules.mk": "makefile", "Dockerfile": "dockerfile", "Dockerfile.dev": "dockerfile",
    "build/Containerfile": "dockerfile", "~/.bashrc": "shell", "/home/u/.zshrc": "shell", ".profile": "shell", "x.env": "dotenv", ".env": "dotenv",
    "C:\\work\\run.sh": "shell", "icon.svg": "xml", "a.jsonl": "jsonl", "settings.jsonc": "jsonc", ".gitconfig": "ini", "setup.cfg": "ini",
    "README": undefined, "LICENSE": undefined, "archive.tar.gz": undefined, "": undefined, "dir.ts/": undefined, ".ts": undefined,
  };
  for (const [path, language] of Object.entries(cases)) expect([path, languageForPath(path)]).toEqual([path, language]);
});

test("the legacy resolver contract remains intact", () => {
  const fences: Record<string, string> = { patch: "diff", htm: "html", h: "c", cc: "cpp", hpp: "cpp", ts: "typescript", m: "objective-c", pl: "perl", v: "verilog" };
  for (const [name, language] of Object.entries(fences)) expect(normalizeLanguage(name)).toBe(language);
  const paths: Record<string, string> = { "script.ksh": "shell", "data.plist": "xml", "page.xhtml": "html", "rows.ndjson": "json", "map.geojson": "json", "main.cxx": "cpp", "header.hh": "cpp", "header.hxx": "cpp", ".editorconfig": "ini", ".npmrc": "ini", Pipfile: "toml", "Cargo.lock": "toml", "Makefile.am": "makefile", ".env.local": "dotenv" };
  for (const [path, language] of Object.entries(paths)) expect(languageForPath(path)).toBe(language);
  const media: Record<string, string> = { "text/json": "json", "application/ecmascript": "javascript", "application/x-yaml": "yaml" };
  for (const [type, language] of Object.entries(media)) expect(languageForContentType(type)).toBe(language);
});

test("a content type resolves by its media type, ignoring parameters and case", () => {
  const cases: Record<string, string | undefined> = {
    "application/json": "json", "application/json; charset=utf-8": "json", "application/problem+json": "json", "application/vnd.api+json": "json",
    "text/html; charset=UTF-8": "html", "application/xhtml+xml": "html", "application/xml": "xml", "text/xml": "xml", "application/atom+xml": "xml",
    "image/svg+xml": "xml", "text/css": "css", "text/javascript": "javascript", "application/javascript": "javascript", "text/markdown": "markdown",
    "TEXT/X-MARKDOWN": "markdown", "application/yaml": "yaml", "text/plain": undefined, "application/octet-stream": undefined, "": undefined, "json": undefined,
  };
  for (const [type, language] of Object.entries(cases)) expect([type, languageForContentType(type)]).toEqual([type, language]);
});
