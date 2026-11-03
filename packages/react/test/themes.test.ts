import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { themes } from "../src/index.js";

test("themes lists every palette in themes.css, in file order", () => {
  const css = readFileSync(new URL("../themes.css", import.meta.url), "utf8");
  expect([...css.matchAll(/^\[data-fulcrum-theme="([^"]+)"\] \{$/gm)].map((match) => match[1])).toEqual([...themes]);
});


// UI text must reach 4.5:1 on every background text sits on: bg, surface, and the 8% diff row tints of styles.css.
// Syntax (tok-*) and terminal (ansi-*) colors keep each palette's official hex where it reaches 3:1 on the backgrounds
// they sit on (tok-*: bg, surface, diff rows; ansi-*: bg, surface). Otherwise the value carries an
// `/* official #rrggbb ... */` note and is the smallest OKLCH lightness change of it, at the same hue, that reaches 3:1.
const css = readFileSync(new URL("../themes.css", import.meta.url), "utf8");
const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
  name: selector!.replace(/\/\*[\s\S]*?\*\//g, "").trim().replace(/\s+/g, " "),
  vars: Object.fromEntries([...body!.matchAll(/--fulcrum-([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim()])),
  official: Object.fromEntries([...body!.matchAll(/--fulcrum-([\w-]+):[^;]+;\s*\/\*\s*official (#[0-9a-f]{6})\b/g)].map(([, name, hex]) => [name!, hex!])),
}));
const themes = blocks.filter((block) => block.vars.bg);
const UI = ["fg", "muted", "accent", "ok", "warn", "danger"];
const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"].flatMap((name) => [`ansi-${name}`, `ansi-bright-${name}`]);
const TOKENS = ["keyword", "string", "number", "comment", "function", "type", "variable", "constant", "operator", "punctuation", "tag", "attribute", "regexp", "inserted", "deleted"].map((name) => `tok-${name}`);

type Rgb = [number, number, number];
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
const contrast = (a: Rgb, b: Rgb) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
};
function oklch(c: Rgb) {
  const [r, g, b] = c.map(linear) as Rgb;
  const [l, m, s] = [[0.4122214708, 0.5363325363, 0.0514459929], [0.2119034982, 0.6806995451, 0.1073969566], [0.0883024619, 0.2817188376, 0.6299787005]].map(([x, y, z]) => Math.cbrt(x! * r + y! * g + z! * b)) as Rgb;
  const [a, bb] = [1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  return { L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, C: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180) / Math.PI };
}

function backgrounds(vars: Record<string, string>, key: string): Record<string, Rgb> {
  const bg = color(vars.bg!, vars);
  const tint = (name: string): Rgb => color(vars[name]!, vars).map((c, i) => c * 0.08 + bg[i]! * 0.92) as Rgb;
  const base = { bg, surface: color(vars.surface!, vars) };
  return key.startsWith("ansi-") ? base : { ...base, "inserted row": tint("tok-inserted"), "deleted row": tint("tok-deleted") };
}
const worst = (rgb: Rgb, on: Record<string, Rgb>) => Math.min(...Object.values(on).map((bg) => contrast(rgb, bg)));

test("there are 12 named themes and the OS-dark default, and each defines every text color", () => {
  expect(themes.length).toBe(13);
  expect(themes.flatMap(({ name, vars }) => [...UI, ...TOKENS, ...ANSI].filter((key) => !vars[key]).map((key) => `${name}: --fulcrum-${key}`))).toEqual([]);
});

test("UI text reaches 4.5:1 on bg, surface, and diff rows in every theme", () => {
  const problems: string[] = [];
  for (const { name, vars } of themes) {
    for (const key of UI) {
      for (const [background, rgb] of Object.entries(backgrounds(vars, key))) {
        const ratio = contrast(color(vars[key]!, vars), rgb);
        if (ratio < 4.5) problems.push(`${name}: --fulcrum-${key} on ${background} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
  expect(problems).toEqual([]);
});

test("syntax and ANSI colors reach 3:1 where they sit, as the official hex or its smallest OKLCH lightness change", () => {
  const problems: string[] = [];
  for (const { name, vars, official } of themes) {
    for (const key of [...TOKENS, ...ANSI]) {
      const where = `${name}: --fulcrum-${key} ${vars[key]}`;
      if (!/^#[0-9a-f]{6}$/i.test(vars[key]!)) { problems.push(`${where} is not a palette hex`); continue; }
      const on = backgrounds(vars, key);
      const value = color(vars[key]!, vars);
      const ratio = worst(value, on);
      if (ratio < 3) problems.push(`${where} is ${ratio.toFixed(2)}:1`);
      if (!official[key]) continue;
      const before = color(official[key]!, vars);
      if (worst(before, on) >= 3) problems.push(`${where}: official ${official[key]} already reaches 3:1, use it`);
      // Minimal: just over 3:1 (hex rounding allows a little), same hue, no added chroma.
      if (ratio >= 3.1) problems.push(`${where} is ${ratio.toFixed(2)}:1, more change than 3:1 needs`);
      const [a, b] = [oklch(before), oklch(value)];
      const hueShift = Math.abs(((a.h - b.h + 540) % 360) - 180);
      if (a.C > 0.03 && hueShift > 3) problems.push(`${where} moves hue ${hueShift.toFixed(1)} deg from ${official[key]}`);
      if (b.C > a.C + 0.005) problems.push(`${where} adds chroma to ${official[key]}`);
    }
  }
  expect(problems).toEqual([]);
});

test("the OS-dark default is github-dark", () => {
  const dark = themes.find((theme) => theme.name === '[data-fulcrum-theme="github-dark"]')!;
  const fallback = themes.find((theme) => theme.name === ":root:not([data-fulcrum-theme])")!;
  expect(fallback.vars).toEqual(dark.vars);
});
