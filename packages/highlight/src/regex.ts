/** ES2024 uses the `v` flag supported by Safari 17 and Chromium 112; do not emit ES2025 flag groups. */
export const REGEX_TARGET = "ES2024" as const;
export type RegexRecipe = readonly [source: string, flags: string];
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

export function grammarPatterns(value: unknown, patterns = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) grammarPatterns(item, patterns);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && (key === "match" || key === "begin" || key === "end" || key === "while"))
        for (const source of textmateSources(item)) patterns.add(source);
      else grammarPatterns(item, patterns);
    }
  }
  return patterns;
}
