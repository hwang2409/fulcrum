import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as ts from "typescript";
import { aliases, languageForContentType, languageForPath, normalizeLanguage } from "../packages/highlight/src/names.js";

type Result = string | undefined;
type Contract = { baseCommit: string; sourceSha256: string; counts: Record<string, number>; aliases: Record<string, Result>; paths: Record<string, Result>; media: Record<string, Result>; improvements: Record<string, string> };
const fixture = resolve(import.meta.dir, "../packages/highlight/test/fixtures/resolver-contract.json");
const mode = process.argv[2] ?? "check";
const ref = process.argv[3] ?? process.env.GITHUB_BASE_SHA ?? "origin/main";

async function sourceAt(refName: string) {
  const proc = Bun.spawn(["git", "show", `${refName}:packages/highlight/src/names.ts`], { stdout: "pipe", stderr: "pipe" });
  const [text, error] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (await proc.exited) throw new Error(`cannot read ${refName}: ${error}`);
  return text;
}
function objectKeys(source: string, name: string) {
  const file = ts.createSourceFile("names.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let keys: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      keys = node.initializer.properties.flatMap((property) => {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return [];
        const key = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)) ? property.name.text : undefined;
        return key === undefined ? [] : [key];
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!keys.length) throw new Error(`could not find ${name} object in base names.ts`);
  return keys;
}
function runBase(source: string) {
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  new Function("module", "exports", js)(module, module.exports);
  return module.exports as { normalizeLanguage: (x: string) => Result; languageForPath: (x: string) => Result; languageForContentType: (x: string) => Result };
}
function addCase(target: Record<string, Result>, input: string, result: Result) { target[input] = result; }
async function generate() {
  const source = await sourceAt(ref);
  const base = runBase(source);
  const names = ["aliases", "extensions", "fileNames", "mediaTypes"] as const;
  const keys = Object.fromEntries(names.map((name) => [name, objectKeys(source, name)]));
  const out: Contract = { baseCommit: ref, sourceSha256: createHash("sha256").update(source).digest("hex"), counts: Object.fromEntries(names.map((name) => [name, keys[name].length])), aliases: {}, paths: {}, media: {}, improvements: {} };
  for (const key of keys.aliases) {
    addCase(out.aliases, key, base.normalizeLanguage(key));
    addCase(out.aliases, key.toUpperCase(), base.normalizeLanguage(key.toUpperCase()));
  }
  for (const key of keys.extensions) addCase(out.paths, `x.${key}`, base.languageForPath(`x.${key}`));
  for (const key of keys.fileNames) addCase(out.paths, key, base.languageForPath(key));
  for (const key of keys.mediaTypes) {
    addCase(out.media, key, base.languageForContentType(key));
    addCase(out.media, `${key}; charset=utf-8`, base.languageForContentType(`${key}; charset=utf-8`));
  }
  addCase(out.paths, "Dockerfile.dev", base.languageForPath("Dockerfile.dev"));
  addCase(out.media, "application/problem+json", base.languageForContentType("application/problem+json"));
  addCase(out.media, "application/problem+xml", base.languageForContentType("application/problem+xml"));
  addCase(out.paths, "unknown.extension", base.languageForPath("unknown.extension"));
  addCase(out.paths, ".unknown", base.languageForPath(".unknown"));
  await mkdir(resolve(fixture, ".."), { recursive: true });
  await writeFile(fixture, JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote ${fixture}: ${Object.keys(out.aliases).length} aliases, ${Object.keys(out.paths).length} paths, ${Object.keys(out.media).length} media`);
}
function check(contract: Contract) {
  const failures: string[] = [];
  const checkMap = (kind: string, values: Record<string, Result>, fn: (input: string) => Result) => { for (const [input, expected] of Object.entries(values)) { const actual = fn(input); if (actual !== expected && !contract.improvements[`${kind}:${input}`]) failures.push(`${kind} ${input}: ${actual} != ${expected}`); } };
  checkMap("alias", contract.aliases, normalizeLanguage);
  checkMap("path", contract.paths, languageForPath);
  checkMap("media", contract.media, languageForContentType);
  if (Object.keys(aliases).length < contract.counts.aliases) failures.push(`head aliases ${Object.keys(aliases).length} < base AST count ${contract.counts.aliases}`);
  if (failures.length) throw new Error(`resolver contract failed:\n${failures.join("\n")}`);
  console.log(`resolver contract passed: ${Object.keys(contract.aliases).length} aliases, ${Object.keys(contract.paths).length} paths, ${Object.keys(contract.media).length} media`);
}
if (mode === "generate") await generate();
else check(JSON.parse(await readFile(fixture, "utf8")) as Contract);
