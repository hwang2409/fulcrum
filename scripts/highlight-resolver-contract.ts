import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { languageForContentType, languageForPath, normalizeLanguage, aliases } from "../packages/highlight/src/names.js";

type Cases = { fences: Record<string, string>; paths: Record<string, string | undefined>; media: Record<string, string | undefined> };
const fixture = resolve(import.meta.dir, "../packages/highlight/test/fixtures/resolver-contract.json");
const cases: Cases = JSON.parse(await readFile(fixture, "utf8"));
const improvements: Record<string, string> = {};
const failures: string[] = [];
for (const [name, expected] of Object.entries(cases.fences)) if (normalizeLanguage(name) !== expected && improvements[name] !== normalizeLanguage(name)) failures.push(`fence ${name}: ${normalizeLanguage(name)} != ${expected}`);
for (const [name, expected] of Object.entries(cases.paths)) if (languageForPath(name) !== expected && improvements[name] !== languageForPath(name)) failures.push(`path ${name}: ${languageForPath(name)} != ${expected}`);
for (const [name, expected] of Object.entries(cases.media)) if (languageForContentType(name) !== expected && improvements[name] !== languageForContentType(name)) failures.push(`media ${name}: ${languageForContentType(name)} != ${expected}`);
for (const [name, expected] of Object.entries(aliases)) if (normalizeLanguage(name) !== expected) failures.push(`alias ${name}: ${normalizeLanguage(name)} != ${expected}`);
if (failures.length) throw new Error(`resolver contract failed:\n${failures.join("\n")}`);
console.log(`resolver contract passed: ${Object.keys(aliases).length} aliases, ${Object.keys(cases.paths).length} paths, ${Object.keys(cases.media).length} media types`);
