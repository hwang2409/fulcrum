import type { LanguageInput } from "@shikijs/types";

export const aliases: Record<string, string> = {
  ts: "typescript", typescript: "typescript", cts: "typescript", mts: "typescript",
  tsx: "tsx", js: "javascript", javascript: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx", py: "python", python: "python", bash: "shell", sh: "shell", shell: "shell", zsh: "shell",
  json: "json", jsonc: "json", diff: "diff", patch: "diff", rust: "rust", rs: "rust", go: "go",
  sql: "sql", yaml: "yaml", yml: "yaml", css: "css", html: "html", htm: "html", md: "markdown",
  markdown: "markdown", toml: "toml", docker: "dockerfile", dockerfile: "dockerfile",
  c: "c", h: "c", cpp: "cpp", "c++": "cpp", cc: "cpp", hpp: "cpp", java: "java", kotlin: "kotlin", kt: "kotlin",
  swift: "swift", ruby: "ruby", rb: "ruby", php: "php", lua: "lua", make: "makefile", makefile: "makefile",
  ini: "ini", properties: "ini", xml: "xml", graphql: "graphql", gql: "graphql", proto: "protobuf", protobuf: "protobuf",
};

const loaders: Record<string, () => Promise<{ default: LanguageInput[] }>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  shell: () => import("shiki/langs/shellscript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  makefile: () => import("shiki/langs/make.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  protobuf: () => import("shiki/langs/proto.mjs"),
};

export function normalizeLanguage(language: string | undefined): string | undefined {
  return language ? aliases[language.trim().toLowerCase()] : undefined;
}

export async function loadLanguage(language: string): Promise<LanguageInput[]> {
  return (await loaders[language]()).default;
}
