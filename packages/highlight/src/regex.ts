/** ES2024 uses the `v` flag supported by Safari 17 and Chromium 112; do not emit ES2025 flag groups. */
export const REGEX_TARGET = "ES2024" as const;
export type RegexRecipeOptions = {
  hiddenCaptures?: number[];
  lazyCompile?: boolean;
  strategy?: string | null;
  transfers?: [number, number[]][];
};
export type RegexRecipe = readonly [source: string, flags: string, options?: RegexRecipeOptions];
export type RegexRecipes = Record<string, RegexRecipe>;

// vscode-textmate rewrites anchors before it asks the regex engine to compile a grammar pattern.
export function textmateSources(pattern: string): string[] {
  let source = "";
  let anchored = false;
  for (let index = 0; index < pattern.length; index++) {
    const next = pattern[index + 1];
    if (pattern[index] !== "\\" || next === undefined) { source += pattern[index]; continue; }
    source += next === "z" ? "$(?!\\n)(?<!\\n)" : `\\${next}`;
    anchored ||= next === "A" || next === "G";
    index++;
  }
  if (!anchored) return [source];
  const variant = (allowA: boolean, allowG: boolean) => source.replace(/\\([\s\S])/g, (escape, next: string) =>
    (next === "A" && !allowA) || (next === "G" && !allowG) ? "\\\uFFFF" : escape);
  return [variant(true, true), variant(true, false), variant(false, true), variant(false, false)];
}

const patternFields = new Set(["match", "begin", "end", "while"]);
const isPatternField = (key: string, value: unknown): value is string => typeof value === "string" && patternFields.has(key);

function collectGrammarValue(value: unknown, pending: unknown[], patterns: Set<string>): void {
  if (Array.isArray(value)) { pending.push(...value); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (isPatternField(key, item)) for (const source of textmateSources(item)) patterns.add(source);
    else pending.push(item);
  }
}

export function grammarPatterns(value: unknown): Set<string> {
  const patterns = new Set<string>();
  const pending = [value];
  while (pending.length) collectGrammarValue(pending.pop(), pending, patterns);
  return patterns;
}
