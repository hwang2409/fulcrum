import { expect, test } from "bun:test";
import { languageForContentType, languageForPath } from "../src/names.js";

test("a path resolves by extension, then by well-known file name", () => {
  const cases: Record<string, string | undefined> = {
    "src/a.ts": "typescript", "web/App.TSX": "tsx", "a.mjs": "javascript", "tool.py": "python", "types.pyi": "python",
    "Cargo.toml": "toml", "go.mod": undefined, "main.go": "go", "lib.rs": "rust", "notes.md": "markdown", "page.mdx": "markdown",
    "Makefile": "makefile", "GNUmakefile": "makefile", "rules.mk": "makefile", "Dockerfile": "dockerfile", "Dockerfile.dev": "dockerfile",
    "build/Containerfile": "dockerfile", "~/.bashrc": "shell", "/home/u/.zshrc": "shell", ".profile": "shell", "x.env": "shell", ".env": "shell",
    "C:\\work\\run.sh": "shell", "icon.svg": "xml", "a.jsonl": "json", "settings.jsonc": "json", ".gitconfig": "ini", "setup.cfg": "ini",
    "README": undefined, "LICENSE": undefined, "archive.tar.gz": undefined, "": undefined, "dir.ts/": undefined, ".ts": undefined,
  };
  for (const [path, language] of Object.entries(cases)) expect([path, languageForPath(path)]).toEqual([path, language]);
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
