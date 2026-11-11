import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { TOKEN_TYPES } from "../../highlight/src/types.js";
import { themes } from "../src/index.js";

test("themes lists every palette in themes.css, in file order", () => {
  const css = readFileSync(new URL("../themes.css", import.meta.url), "utf8");
  expect([...css.matchAll(/^\[data-fulcrum-theme="([^"]+)"\] \{$/gm)].map((match) => match[1])).toEqual([...themes]);
});

// UI text and syntax (tok-*) colors must reach 4.5:1 on every background they sit on: bg, surface, the 8% diff row
// tints of styles.css, and for status colors their own 8% marker tint. Syntax and terminal (ansi-*: bg, surface, 3:1) colors keep each palette's official hex where it
// reaches its ratio. Otherwise the value carries an `/* official #rrggbb ... */` note and is the smallest OKLCH lightness
// change of it, at the same hue, that reaches the ratio.
const css = readFileSync(new URL("../themes.css", import.meta.url), "utf8");
const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
  name: selector!.replace(/\/\*[\s\S]*?\*\//g, "").trim().replace(/\s+/g, " "),
  vars: Object.fromEntries([...body!.matchAll(/--fulcrum-([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim()])),
  official: Object.fromEntries([...body!.matchAll(/--fulcrum-([\w-]+):[^;]+;\s*\/\*\s*official (#[0-9a-f]{6})\b/g)].map(([, name, hex]) => [name!, hex!])),
  source: Object.fromEntries([...body!.matchAll(/--fulcrum-(ui-[\w-]+):[^;]+;\s*\/\*\s*(tok-[\w-]+) (#[0-9a-f]{6})\b/g)].map(([, name, token, hex]) => [name!, [token!, hex!]])),
}));
const palettes = blocks.filter((block) => block.vars.bg);
const UI = ["fg", "muted", "accent", "ok", "warn", "danger"];
const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"].flatMap((name) => [`ansi-${name}`, `ansi-bright-${name}`]);
// Tool facts are UI text, so they get their own accents, each from one official syntax hue (named in its comment).
const ACCENTS = ["path", "number", "added", "removed", "pattern", "type"].map((name) => `ui-${name}`);
const TOKENS = TOKEN_TYPES.map((name) => `tok-${name}`);

type Rgb = [number, number, number];
// Channels stay unrounded (0-255 floats): browsers keep a color-mix() computed value at full precision (Chrome gives
// color(srgb 0.602902 0.668 0.17)), and axe, Lighthouse, and DevTools check contrast on that value. contrast() checks it
// and the 8-bit pixel the page paints, so a color passes only when both reach the ratio.
function color(value: string, vars: Record<string, string>): Rgb {
  value = value.trim();
  const variable = /^var\(--fulcrum-([\w-]+)\)$/.exec(value);
  if (variable) return color(vars[variable[1]!] ?? "", vars);
  if (value === "black" || value === "white") return value === "black" ? [0, 0, 0] : [255, 255, 255];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const digits = hex[1]!.length === 3 ? [...hex[1]!].map((d) => d + d).join("") : hex[1]!;
    return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as Rgb;
  }
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*(.+?)(?:\s+\d+%)?\)$/.exec(value);
  if (mix) {
    const [a, b, p] = [color(mix[1]!, vars), color(mix[3]!, vars), Number(mix[2]) / 100];
    return a.map((c, i) => c * p + b[i]! * (1 - p)) as Rgb;
  }
  throw new Error(`cannot read color ${JSON.stringify(value)}`);
}
const linear = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const luminance = (c: Rgb) => c.map(linear).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
const ratio = (a: Rgb, b: Rgb) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
};
const painted = (c: Rgb) => c.map(Math.round) as Rgb;
const contrast = (a: Rgb, b: Rgb) => Math.min(ratio(a, b), ratio(painted(a), painted(b)));
function oklch(c: Rgb) {
  const [r, g, b] = c.map(linear) as Rgb;
  const [l, m, s] = [[0.4122214708, 0.5363325363, 0.0514459929], [0.2119034982, 0.6806995451, 0.1073969566], [0.0883024619, 0.2817188376, 0.6299787005]].map(([x, y, z]) => Math.cbrt(x! * r + y! * g + z! * b)) as Rgb;
  const [a, bb] = [1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  return { L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, C: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180) / Math.PI };
}

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector!.trim().replace(/\s+/g, " "), body: body! }));
// The run-end marker writes ok, warn, and danger on a tint of the same color. The tint is read from styles.css, so the
// model is the real marker background (its 55% border is not text, so it has no contrast rule).
const STATUS = ["ok", "warn", "danger"];
const markerTints = new Set(rules.filter(({ selector }) => selector.startsWith('[data-part="run-end-marker"]')).flatMap(({ body }) =>
  [...body.matchAll(/background: color-mix\(in srgb, var\(--fulcrum-(?:ok|warn|danger)\) (\d+)%, var\(--fulcrum-(bg|surface)\)\)/g)].map(([, share, under]) => `${share} ${under}`)));
const [markerShare, markerUnder] = [...markerTints][0]!.split(" ") as [string, "bg" | "surface"];
function backgrounds(vars: Record<string, string>, key: string): Record<string, Rgb> {
  const bg = color(vars.bg!, vars);
  const surface = color(vars.surface!, vars);
  const tint = (name: string, under = bg, share = 0.08): Rgb => color(vars[name]!, vars).map((c, i) => c * share + under[i]! * (1 - share)) as Rgb;
  const base = { bg, surface };
  if (key.startsWith("ansi-")) return base;
  const rows = { ...base, "inserted row": tint("tok-inserted"), "deleted row": tint("tok-deleted") };
  if (!STATUS.includes(key)) return rows;
  return { ...rows, [`${key} end-marker tint`]: tint(key, { bg, surface }[markerUnder], Number(markerShare) / 100) };
}
// A changed color is the official hex's smallest OKLCH lightness change: just over the ratio (hex rounding allows a
// little), same hue, no added chroma, so it stays in its palette's family.
function familyProblems(where: string, value: Rgb, official: string, on: Record<string, Rgb>, min: number): string[] {
  const problems: string[] = [];
  if (worst(color(official, {}), on) >= min) problems.push(`${where}: official ${official} already reaches ${min}:1, use it`);
  const ratio = worst(value, on);
  if (ratio >= min + 0.1) problems.push(`${where} is ${ratio.toFixed(3)}:1, more change than ${min}:1 needs`);
  const [a, b] = [oklch(color(official, {})), oklch(value)];
  const hueShift = Math.abs(((a.h - b.h + 540) % 360) - 180);
  if (a.C > 0.03 && hueShift > 3) problems.push(`${where} moves hue ${hueShift.toFixed(1)} deg from ${official}`);
  if (b.C > a.C + 0.005) problems.push(`${where} adds chroma to ${official}`);
  return problems;
}
const worst = (rgb: Rgb, on: Record<string, Rgb>) => Math.min(...Object.values(on).map((bg) => contrast(rgb, bg)));

test("there are 12 named themes and the OS-dark default, and each defines every text color", () => {
  expect(palettes.length).toBe(13);
  expect(palettes.flatMap(({ name, vars }) => [...UI, ...ACCENTS, ...TOKENS, ...ANSI].filter((key) => !vars[key]).map((key) => `${name}: --fulcrum-${key}`))).toEqual([]);
});

test("the run-end marker uses one tint for ok, warn, and danger", () => {
  expect([...markerTints]).toHaveLength(1);
});

// Status text keeps a margin over AA: a value that passes 4.5:1 only by rounding (4.5004) can drop below it under another
// blend, gamma, or subpixel rendering. Status marks (rails, squares, borders) keep the same margin over 3:1.
const STATUS_TEXT_FLOOR = 4.6;
const STATUS_MARK_FLOOR = 3.1;

test("UI text reaches 4.5:1 (status text 4.6:1) on bg, surface, diff rows, and its own end-marker tint in every theme", () => {
  const problems: string[] = [];
  for (const { name, vars } of palettes) {
    for (const key of UI) {
      const min = STATUS.includes(key) ? STATUS_TEXT_FLOOR : 4.5;
      for (const [background, rgb] of Object.entries(backgrounds(vars, key))) {
        const ratio = contrast(color(vars[key]!, vars), rgb);
        if (ratio < min) problems.push(`${name}: --fulcrum-${key} on ${background} is ${ratio.toFixed(4)}:1, needs ${min}:1`);
      }
    }
  }
  expect(problems).toEqual([]);
});

test("ok, warn, and danger are the official hex or its smallest OKLCH lightness change", () => {
  const problems: string[] = [];
  for (const { name, vars, official } of palettes) {
    for (const key of STATUS) {
      const where = `${name}: --fulcrum-${key} ${vars[key]}`;
      if (!/^#[0-9a-f]{6}$/i.test(vars[key]!)) { problems.push(`${where} is not a palette hex`); continue; }
      if (official[key]) problems.push(...familyProblems(where, color(vars[key]!, vars), official[key]!, backgrounds(vars, key), STATUS_TEXT_FLOOR));
    }
  }
  expect(problems).toEqual([]);
});

test("ok, warn, and danger marks (rails, squares, borders) reach 3.1:1 on bg and surface in every theme", () => {
  const problems: string[] = [];
  for (const { name, vars } of palettes) {
    for (const key of STATUS) {
      for (const background of ["bg", "surface"]) {
        const ratio = contrast(color(vars[key]!, vars), color(vars[background]!, vars));
        if (ratio < STATUS_MARK_FLOOR) problems.push(`${name}: --fulcrum-${key} mark on ${background} is ${ratio.toFixed(4)}:1, needs ${STATUS_MARK_FLOOR}:1`);
      }
    }
  }
  expect(problems).toEqual([]);
});

// Apps put fg text on a status or accent tint (apps/web badges use 12% over bg, highlighted session rows 8-10%).
test("fg reaches 4.5:1 on a 12% ok, warn, danger, accent, or muted tint over bg", () => {
  const problems: string[] = [];
  for (const { name, vars } of palettes) {
    const [fg, bg] = [color(vars.fg!, vars), color(vars.bg!, vars)];
    for (const key of [...STATUS, "accent", "muted"]) {
      const ratio = contrast(fg, color(vars[key]!, vars).map((c, i) => c * 0.12 + bg[i]! * 0.88) as Rgb);
      if (ratio < 4.5) problems.push(`${name}: fg on a 12% --fulcrum-${key} tint is ${ratio.toFixed(3)}:1`);
    }
  }
  expect(problems).toEqual([]);
});

test("syntax colors reach 4.5:1 and ANSI colors 3:1 where they sit, as the official hex or its smallest OKLCH lightness change", () => {
  const problems: string[] = [];
  for (const { name, vars, official } of palettes) {
    for (const key of [...TOKENS, ...ANSI]) {
      const min = key.startsWith("tok-") ? 4.5 : 3;
      const where = `${name}: --fulcrum-${key} ${vars[key]}`;
      if (!/^#[0-9a-f]{6}$/i.test(vars[key]!)) { problems.push(`${where} is not a palette hex`); continue; }
      const on = backgrounds(vars, key);
      const value = color(vars[key]!, vars);
      const ratio = worst(value, on);
      if (ratio < min) problems.push(`${where} is ${ratio.toFixed(3)}:1, needs ${min}:1`);
      if (official[key]) problems.push(...familyProblems(where, value, official[key]!, on, min));
    }
  }
  expect(problems).toEqual([]);
});

test("ui-* accents reach 4.5:1 on bg and surface, as their source tok-* official hex or its smallest OKLCH lightness change", () => {
  const problems: string[] = [];
  for (const { name, vars, official, source } of palettes) {
    for (const key of ACCENTS) {
      const where = `${name}: --fulcrum-${key} ${vars[key]}`;
      if (!source[key] || !/^#[0-9a-f]{6}$/i.test(vars[key]!)) { problems.push(`${where} needs a palette hex and a /* tok-<name> #rrggbb */ source note`); continue; }
      const [token, hex] = source[key]!;
      if (hex !== (official[token!] ?? vars[token!])) problems.push(`${where}: source ${hex} is not the official ${token} ${official[token!] ?? vars[token!]}`);
      const on = { bg: color(vars.bg!, vars), surface: color(vars.surface!, vars) };
      const value = color(vars[key]!, vars);
      const ratio = worst(value, on);
      if (ratio < 4.5) problems.push(`${where} is ${ratio.toFixed(3)}:1`);
      if (vars[key] !== hex) problems.push(...familyProblems(where, value, hex!, on, 4.5));
    }
  }
  expect(problems).toEqual([]);
});

// tok-* colors are code colors, so only code may use them: the token spans and the diff rows' tint and changed-word line.
const CODE = /^(\.tok-[\w-]+|\[data-part="diff-line"\]\[data-change="(insert|delete)"\]|\[data-change="(insert|delete)"\] \[data-part="diff-word"\])$/;
const TOOL_FACTS = ["summary-path", "summary-pattern", "diff-stat", "tool-duration", "tool-cwd", "tool-path", "tool-size", "search-path", "search-count", "search-total", "fetch-type", "fetch-url"];

test("styles.css uses tok-* variables only in code selectors", () => {
  expect(rules.filter(({ selector, body }) => body.includes("--fulcrum-tok-") && !selector.split(",").every((part) => CODE.test(part.trim()))).map(({ selector }) => selector)).toEqual([]);
});

test("every tool fact is colored by a ui-* accent, never a tok-* variable", () => {
  const problems = TOOL_FACTS.flatMap((part) => {
    const own = rules.filter(({ selector, body }) => selector.includes(`[data-part="${part}"]`) && /\bcolor:/.test(body));
    if (!own.length) return [`${part} has no color rule`];
    return own.filter(({ body }) => body.includes("--fulcrum-tok-") || !body.includes("var(--fulcrum-ui-")).map(({ selector }) => `${selector} is not colored by --fulcrum-ui-*`);
  });
  expect(problems).toEqual([]);
});

// Every fulcrum stylesheet (the packages' css, themes.css, the apps' css) and every package and app source file, whose
// template strings and inline style objects can also carry css.
const ROOT = new URL("../../../", import.meta.url);
const files = (top: string, keep: (path: string) => boolean) => readdirSync(new URL(top, ROOT), { recursive: true, encoding: "utf8" })
  .filter((path) => keep(path) && !/(^|\/)(node_modules|dist)\//.test(path)).map((path) => `${top}/${path}`);
const SHEETS = ["packages", "apps"].flatMap((top) => files(top, (path) => path.endsWith(".css"))).sort();
const SOURCES = ["packages", "apps"].flatMap((top) => files(top, (path) => /^[^/]+\/src\/.*\.tsx?$/.test(path))).sort();
type Declaration = { where: string; selector: string; body: string; property: string; value: string };
// Each declaration with its file:line. Comments are blanked with their newlines kept, so lines stay true.
function cssDeclarations(file: string, text: string): Declaration[] {
  text = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((rule) => {
    const bodyAt = rule.index! + rule[1]!.length + 1;
    return [...rule[2]!.matchAll(/([\w-]+)\s*:\s*([^;]+)/g)].map((decl) => ({
      where: `${file}:${text.slice(0, bodyAt + decl.index!).split("\n").length}`,
      selector: rule[1]!.trim().replace(/\s+/g, " "), body: rule[2]!, property: decl[1]!, value: decl[2]!.trim(),
    }));
  });
}
// In source: `prop: value` in css template strings, `prop: "value"` in style objects (camelCase or quoted kebab), and
// `style.prop = value` / `setProperty("prop", value)`, wherever the value names a custom property.
const kebab = (name: string) => name.replace(/^["']|["']$/g, "").replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/^webkit-/, "-webkit-");
function sourceDeclarations(file: string, text: string): Declaration[] {
  const at = (index: number) => `${file}:${text.slice(0, index).split("\n").length}`;
  return [
    ...[...text.matchAll(/(--[\w-]+|"[\w-]+"|'[\w-]+'|\b[a-zA-Z][\w]*)\s*:\s*["'`]?([^"'`;,}\n]*var\(--[\w-]+\)[^"'`;,}\n]*)/g)].map((m) => ({ where: at(m.index!), property: kebab(m[1]!), value: m[2]!.trim() })),
    ...[...text.matchAll(/\.style\.(\w+)\s*=\s*["'`]([^"'`]*var\(--[\w-]+\)[^"'`]*)/g)].map((m) => ({ where: at(m.index!), property: kebab(m[1]!), value: m[2]! })),
    ...[...text.matchAll(/setProperty\(\s*["'`]([\w-]+)["'`]\s*,\s*["'`]([^"'`]*var\(--[\w-]+\)[^"'`]*)/g)].map((m) => ({ where: at(m.index!), property: m[1]!, value: m[2]! })),
  ].map((decl) => ({ ...decl, selector: "(source)", body: "" }));
}
const declarations = [...SHEETS.flatMap((file) => cssDeclarations(file, readFileSync(new URL(file, ROOT), "utf8"))), ...SOURCES.flatMap((file) => sourceDeclarations(file, readFileSync(new URL(file, ROOT), "utf8")))];
// A custom property is a status tone when any value it is ever set to reaches ok, warn, or danger, through any chain of
// aliases (--fulcrum-error: var(--fulcrum-danger), --mark: var(--fulcrum-error), ...), or when a state/urgency selector
// assigns it. shortcut: one global set, not per-element cascade, so a property used for status anywhere is a tone
// everywhere; that only errs strict.
function statusCarriers(decls: { selector: string; property: string; value: string }[]) {
  const tones = new Set(["--fulcrum-ok", "--fulcrum-warn", "--fulcrum-danger"]);
  for (const { selector, property } of decls) if (property.startsWith("--") && /\[data-(?:state|urgency)(?:[=\]])/.test(selector)) tones.add(property);
  for (let grew = true; grew; ) {
    grew = false;
    for (const { property, value } of decls) {
      if (!property.startsWith("--") || tones.has(property)) continue;
      if ([...value.matchAll(/var\(\s*(--[\w-]+)/g)].some(([, name]) => tones.has(name!))) tones.add(property), (grew = true);
    }
  }
  return tones;
}
const toneSet = (decls: { selector: string; property: string; value: string }[]) => {
  const tones = statusCarriers(decls);
  return (value: string) => [...value.matchAll(/var\(\s*(--[\w-]+)/g)].some(([, name]) => tones.has(name!));
};
const toned = toneSet(declarations);
// Text paint: color, the WebKit fill that overrides it, and fill (svg text).
const TEXT = new Set(["color", "-webkit-text-fill-color", "fill"]);
const textProblems = (decls: Declaration[], isToned = toneSet(decls)) => decls.filter(({ property, value }) => TEXT.has(property) && isToned(value))
  .map(({ where, selector, property, value }) => `${where} ${selector} { ${property}: ${value} }: status tokens are marks only; use fg (or muted) for the word and a mark (square, rail, border) for the tone`);

// These status words use fg or muted; their adjacent square, rail, or border carries the status tone.
const STATUS_WORD = /\[data-part="(?:delivery-note|sub-agent-status|run-urgency)"\]/;
test("delivery and sub-agent status words do not use status colors", () => {
  expect(SHEETS).toContain("packages/react/styles.css");
  expect(textProblems(declarations.filter(({ selector }) => selector === "(source)" || STATUS_WORD.test(selector)), toned)).toEqual([]);
});

// The scan must see every route a status color takes to text, or it passes by missing them.
test("the status text scan catches aliases, chains, text fill, and inline styles", () => {
  const sheet = cssDeclarations("plant.css", `
    :root { --fulcrum-error: var(--fulcrum-danger); --a: var(--fulcrum-warn); --b: var(--a); --calm: var(--fulcrum-muted); }
    .alias { color: var(--fulcrum-error); }
    .chain { color: color-mix(in srgb, var(--b) 80%, black); }
    .fill { -webkit-text-fill-color: var(--fulcrum-ok); }
    text { fill: var(--b); }
    [data-part="sub-agent"][data-state="idle"] { --state: var(--fulcrum-ui-type); }
    [data-part="sub-agent-status"] { color: var(--state); }
    .fine { color: var(--calm); border-color: var(--fulcrum-error); }`);
  const source = sourceDeclarations("plant.tsx", `
    const a = <p style={{ color: "var(--fulcrum-danger)" }} />;
    const b = <p style={{ WebkitTextFillColor: \`var(--fulcrum-warn)\` }} />;
    node.style.color = "var(--fulcrum-ok)";
    node.style.setProperty("color", "var(--fulcrum-error)");
    const css = \`.x { color: var(--b); }\`;
    const fine = <p style={{ color: "var(--fulcrum-fg)", borderColor: "var(--fulcrum-danger)" }} />;`);
  expect(textProblems([...sheet, ...source]).map((problem) => problem.split(" ")[0]).sort()).toEqual(["plant.css:3", "plant.css:4", "plant.css:5", "plant.css:6", "plant.css:8", "plant.tsx:2", "plant.tsx:3", "plant.tsx:4", "plant.tsx:5", "plant.tsx:6"]);
});

test("the OS-dark default is github-dark", () => {
  const dark = palettes.find((theme) => theme.name === '[data-fulcrum-theme="github-dark"]')!;
  const fallback = palettes.find((theme) => theme.name === ":root:not([data-fulcrum-theme])")!;
  expect(fallback.vars).toEqual(dark.vars);
});
