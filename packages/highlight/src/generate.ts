import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { createGenerationManifest, generationDigest, verifyGenerationCache } from "./generation-cache.js";
import { generationEntries } from "./generation-config.js";

const root = new URL(".", import.meta.url);
const packageRoot = new URL("../", root);
const manifestUrl = new URL("../.recipe-generation-manifest.json", root);

const command = process.argv[2];

if (command === "--worker") {
  const outputPath = process.argv[3];
  const actuals = process.argv.slice(4);
  if (!outputPath || !actuals.length) throw new Error("missing recipe worker arguments");
  const [{ defaultJavaScriptRegexConstructor }, { grammarPatterns, REGEX_TARGET }] = await Promise.all([
    import("@shikijs/engine-javascript"), import("./regex.js"),
  ]);
  for (const actual of actuals) {
    const grammar = (await import(`@shikijs/langs/${actual}`)).default;
    const recipes: Record<string, readonly [string, string, unknown]> = {};
    for (const pattern of grammarPatterns(grammar)) {
      try {
        const regex = defaultJavaScriptRegexConstructor(pattern, { target: REGEX_TARGET }) as RegExp & { rawOptions?: unknown };
        recipes[pattern] = [regex.source, regex.flags, regex.rawOptions];
      } catch { /* Unsupported static patterns keep the bounded runtime fallback and its existing error semantics. */ }
    }
    await writeFile(new URL(`.recipe-entries/${actual}.ts`, outputPath), `export default ${JSON.stringify(recipes)} as const;\n`);
  }
  process.exit(0);
}

const hash = await generationDigest();
if (command === "--hash") {
  console.log(hash);
  process.exit(0);
}

const grammarEntries = new URL("../.grammar-entries/", root);
const recipeEntries = new URL("../.recipe-entries/", root);
const entries = generationEntries();
const expectedFiles = entries.flatMap((entry) => [`.grammar-entries/${entry.actual}.ts`, `.recipe-entries/${entry.actual}.ts`]).sort();
const cacheRoot = packageRoot;
if (await verifyGenerationCache(cacheRoot, manifestUrl, hash, expectedFiles)) {
  console.log(`reused ${hash} regex recipe chunks`);
  process.exit(0);
}

const [compatibility, { REGEX_TARGET }] = await Promise.all([
  import("./compatibility.js"), import("./regex.js"),
]);
const { compatibilityAliases, compatibilityExtensions, compatibilityFileNames, compatibilityMediaTypes } = compatibility;
const aliases: Record<string, string> = {};
for (const entry of entries) {
  aliases[entry.name] = entry.name;
  aliases[entry.actual] = entry.name;
  for (const alias of entry.aliases) aliases[alias] = entry.name;
}
Object.assign(aliases, compatibilityAliases);
// Common file extensions not present in TextMate's grammar metadata. The generated language list remains the source of truth for fences.
const extensions: Record<string, string> = {
  pyi: "python", mdx: "markdown", mk: "makefile", svg: "xml", xsd: "xml", xsl: "xml", env: "dotenv", tf: "terraform", tfvars: "terraform", hcl: "hcl", vue: "vue", svelte: "svelte", astro: "astro", r: "r", R: "r",
  jl: "julia", sol: "solidity", graphql: "graphql", gql: "graphql", proto: "protobuf", prisma: "prisma", sql: "sql", psql: "sql",
  toml: "toml", ini: "ini", cfg: "ini", conf: "ini", csv: "csv", tsv: "tsv", tex: "latex", sty: "latex", log: "log", diff: "diff", patch: "diff",
  zig: "zig", nix: "nix", ex: "elixir", exs: "elixir", erl: "erlang", hrl: "erlang", hs: "haskell", lhs: "haskell", ml: "ocaml", mli: "ocaml",
  scala: "scala", sc: "scala", dart: "dart", ps1: "powershell", psm1: "powershell", cs: "csharp", cmake: "cmake", nginx: "nginx", http: "http", ...compatibilityExtensions,
};
const fileNames: Record<string, string> = {
  dockerfile: "dockerfile", containerfile: "dockerfile", makefile: "makefile", gnumakefile: "makefile", "cmakelists.txt": "cmake", "nginx.conf": "nginx",
  "apache.conf": "apache", "httpd.conf": "apache", ".gitconfig": "ini", ".env": "dotenv", ".envrc": "shell", ".bashrc": "shell", ".bash_profile": "shell", ".bash_aliases": "shell", ".zshrc": "shell", ".zprofile": "shell", ".zshenv": "shell", ".profile": "shell", gemfile: "ruby", rakefile: "ruby", ...compatibilityFileNames,
};
const mediaTypes: Record<string, string> = {
  "application/json": "json", "text/html": "html", "application/xhtml+xml": "html", "application/xml": "xml", "text/xml": "xml", "text/css": "css",
  "text/javascript": "javascript", "application/javascript": "javascript", "text/markdown": "markdown", "application/yaml": "yaml", "text/yaml": "yaml",
  "application/toml": "toml", "application/sql": "sql", "text/x-markdown": "markdown", "application/graphql": "graphql", "text/csv": "csv", "text/tab-separated-values": "tsv",
  "text/x-diff": "diff", "text/x-patch": "diff", "text/x-python": "python", "application/x-sh": "shell", "application/protobuf": "protobuf", ...compatibilityMediaTypes,
};
const json = (value: unknown) => JSON.stringify(value, null, 2);
// names.ts is the public compatibility registry. do not replace it with Shiki metadata:
// slice 2 keeps the main-supported resolver set while grammar chunks remain prepared for slice 4.
await writeFile(new URL("languages.ts", root), `// generated by generate.ts from Shiki's bundled language registry; do not edit.\nimport type { LanguageInput } from "@shikijs/types";\nexport const allGeneratedLanguages = ${json(entries.map((entry) => entry.name))} as const;\nconst grammarUrls: Record<string, URL> = {\n${entries.map((entry) => `  ${JSON.stringify(entry.name)}: new URL("../langs/${entry.actual}.js", import.meta.url),`).join("\n")}\n};\nconst recipeUrls: Record<string, URL> = {\n${entries.map((entry) => `  ${JSON.stringify(entry.name)}: new URL("../recipes/${entry.actual}.js", import.meta.url),`).join("\n")}\n};\nexport async function loadLanguage(language: string): Promise<LanguageInput[]> { const url = grammarUrls[language]; if (!url) throw new Error("unknown language: " + language); return (await import(url.href) as { default: LanguageInput[] }).default; }\nexport async function loadRegexRecipes(language: string): Promise<import("./regex.js").RegexRecipes> { const url = recipeUrls[language]; if (!url) throw new Error("unknown language: " + language); return (await import(url.href) as { default: import("./regex.js").RegexRecipes }).default; }\n`);

const temporary = await mkdtemp(new URL(".recipe-generation-", packageRoot).pathname);
const temporaryUrl = new URL(`file://${temporary}/`);
await Promise.all([mkdir(new URL(".grammar-entries/", temporaryUrl)), mkdir(new URL(".recipe-entries/", temporaryUrl))]);
await Promise.all(entries.map((entry) => writeFile(new URL(`.grammar-entries/${entry.actual}.ts`, temporaryUrl), `import grammar from "@shikijs/langs/${entry.actual}"; export default grammar;\n`)));
const workerCount = Math.min(availableParallelism(), entries.length);
const workers = Array.from({ length: workerCount }, (_, index) => Bun.spawn([
  process.execPath, import.meta.filename, "--worker", temporaryUrl.href,
  ...entries.filter((_, entryIndex) => entryIndex % workerCount === index).map((entry) => entry.actual),
], { stdout: "inherit", stderr: "inherit" }));
const results = await Promise.all(workers.map((worker) => worker.exited));
if (results.some((code) => code !== 0)) {
  await rm(temporary, { recursive: true, force: true });
  throw new Error(`recipe generation worker failed: ${results.join(", ")}`);
}
const manifest = await createGenerationManifest(temporaryUrl, hash, expectedFiles);
await rm(manifestUrl, { force: true });
await Promise.all([rm(grammarEntries, { recursive: true, force: true }), rm(recipeEntries, { recursive: true, force: true })]);
await Promise.all([
  rename(new URL(".grammar-entries/", temporaryUrl), grammarEntries),
  rename(new URL(".recipe-entries/", temporaryUrl), recipeEntries),
]);
await writeFile(new URL("manifest.json", temporaryUrl), `${JSON.stringify(manifest, null, 2)}\n`);
await rename(new URL("manifest.json", temporaryUrl), manifestUrl);
await rm(temporary, { recursive: true, force: true });
console.log(`generated ${entries.length} lazy grammar and ${REGEX_TARGET} regex recipe chunks with ${workerCount} workers (${hash})`);
