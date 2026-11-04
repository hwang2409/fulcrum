// the public resolver contract predates the generated shiki registry. keep these decisions explicit.
export const compatibilityAliases: Record<string, string> = {
  patch: "diff", htm: "html", h: "c", cc: "cpp", hpp: "cpp",
  v: "verilog", ts: "typescript", m: "objective-c", pl: "perl", jsonc: "json",
};
export const compatibilityExtensions: Record<string, string> = {
  ksh: "shell", plist: "xml", xhtml: "html", ndjson: "json", geojson: "json",
  cxx: "cpp", hh: "cpp", hxx: "cpp", rake: "ruby", gemspec: "ruby", pgsql: "sql",
  editorconfig: "ini", npmrc: "ini", h: "c", m: "objective-c", pl: "perl", jsonl: "json", json5: "json", env: "shell",
};
export const compatibilityFileNames: Record<string, string> = {
  "makefile.am": "makefile", ".env.local": "dotenv", ".env": "shell", ".editorconfig": "ini", ".npmrc": "ini",
  pipfile: "toml", "cargo.lock": "toml",
};
export const compatibilityMediaTypes: Record<string, string> = {
  "text/json": "json", "application/ecmascript": "javascript", "text/ecmascript": "javascript", "application/x-yaml": "yaml",
};
