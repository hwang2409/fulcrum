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

const grammarUrls: Record<string, URL> = {
  typescript: new URL("../langs/typescript.js", import.meta.url), tsx: new URL("../langs/tsx.js", import.meta.url),
  javascript: new URL("../langs/javascript.js", import.meta.url), jsx: new URL("../langs/jsx.js", import.meta.url),
  python: new URL("../langs/python.js", import.meta.url), shell: new URL("../langs/shellscript.js", import.meta.url),
  json: new URL("../langs/json.js", import.meta.url), diff: new URL("../langs/diff.js", import.meta.url),
  rust: new URL("../langs/rust.js", import.meta.url), go: new URL("../langs/go.js", import.meta.url),
  sql: new URL("../langs/sql.js", import.meta.url), yaml: new URL("../langs/yaml.js", import.meta.url),
  css: new URL("../langs/css.js", import.meta.url), html: new URL("../langs/html.js", import.meta.url),
  markdown: new URL("../langs/markdown.js", import.meta.url), toml: new URL("../langs/toml.js", import.meta.url),
  dockerfile: new URL("../langs/dockerfile.js", import.meta.url), c: new URL("../langs/c.js", import.meta.url),
  cpp: new URL("../langs/cpp.js", import.meta.url), java: new URL("../langs/java.js", import.meta.url),
  kotlin: new URL("../langs/kotlin.js", import.meta.url), swift: new URL("../langs/swift.js", import.meta.url),
  ruby: new URL("../langs/ruby.js", import.meta.url), php: new URL("../langs/php.js", import.meta.url),
  lua: new URL("../langs/lua.js", import.meta.url), makefile: new URL("../langs/make.js", import.meta.url),
  ini: new URL("../langs/ini.js", import.meta.url), xml: new URL("../langs/xml.js", import.meta.url),
  graphql: new URL("../langs/graphql.js", import.meta.url), protobuf: new URL("../langs/proto.js", import.meta.url),
};

export function normalizeLanguage(language: string | undefined): string | undefined {
  return language ? aliases[language.trim().toLowerCase()] : undefined;
}

// File extensions and names that are not language aliases themselves.
const extensions: Record<string, string> = {
  pyi: "python", mdx: "markdown", mk: "makefile", env: "shell", bash: "shell", ksh: "shell", svg: "xml", xsd: "xml", xsl: "xml",
  plist: "xml", xhtml: "html", jsonl: "json", ndjson: "json", json5: "json", geojson: "json", cfg: "ini", conf: "ini",
  kts: "kotlin", cxx: "cpp", hh: "cpp", hxx: "cpp", rake: "ruby", gemspec: "ruby", pgsql: "sql",
};
const fileNames: Record<string, string> = {
  makefile: "makefile", gnumakefile: "makefile", dockerfile: "dockerfile", containerfile: "dockerfile", gemfile: "ruby",
  rakefile: "ruby", ".bashrc": "shell", ".bash_profile": "shell", ".bash_aliases": "shell", ".zshrc": "shell", ".zprofile": "shell",
  ".zshenv": "shell", ".profile": "shell", ".envrc": "shell", ".env": "shell", ".gitconfig": "ini", ".editorconfig": "ini",
  ".npmrc": "ini", "pipfile": "toml", "cargo.lock": "toml",
};

/** The language of a file by its well-known name (Makefile, Dockerfile, .bashrc) or its extension; undefined when unknown. */
export function languageForPath(path: string): string | undefined {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1).toLowerCase();
  if (fileNames[name]) return fileNames[name];
  if (name.startsWith("dockerfile.")) return "dockerfile";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined; // no extension, or a dotfile whose name is not known
  const extension = name.slice(dot + 1);
  return normalizeLanguage(extensions[extension] ?? extension);
}

const mediaTypes: Record<string, string> = {
  "application/json": "json", "text/json": "json", "text/html": "html", "application/xhtml+xml": "html", "application/xml": "xml",
  "text/xml": "xml", "text/css": "css", "text/javascript": "javascript", "application/javascript": "javascript",
  "application/ecmascript": "javascript", "text/ecmascript": "javascript", "text/markdown": "markdown", "text/x-markdown": "markdown",
  "application/yaml": "yaml", "application/x-yaml": "yaml", "text/yaml": "yaml", "application/toml": "toml", "application/sql": "sql",
  "text/x-diff": "diff", "text/x-patch": "diff", "application/x-sh": "shell", "text/x-python": "python",
};

/** The language of an HTTP body by its media type (`application/json; charset=utf-8`, `application/problem+json`). */
export function languageForContentType(contentType: string): string | undefined {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return mediaTypes[type] ?? (type.endsWith("+json") ? "json" : type.endsWith("+xml") ? "xml" : undefined);
}

export async function loadLanguage(language: string): Promise<LanguageInput[]> {
  return (await import(grammarUrls[language].href) as { default: LanguageInput[] }).default;
}
