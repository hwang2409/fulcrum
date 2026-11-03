import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { themes } from "../src/index.js";

test("themes lists every palette in themes.css, in file order", () => {
  const css = readFileSync(new URL("../themes.css", import.meta.url), "utf8");
  expect([...css.matchAll(/^\[data-fulcrum-theme="([^"]+)"\] \{$/gm)].map((match) => match[1])).toEqual([...themes]);
});


// Every color a theme uses for text must reach 4.5:1 on the backgrounds text sits on: bg, surface, and the 8% diff row
// tints of styles.css.
const css = readFileSync(new URL("../themes.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
  name: selector!.trim().replace(/\s+/g, " "),
  vars: Object.fromEntries([...body!.matchAll(/--fulcrum-([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim()])),
}));
const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"].flatMap((name) => [`ansi-${name}`, `ansi-bright-${name}`]);
const TOKENS = ["keyword", "string", "number", "comment", "function", "type", "variable", "constant", "operator", "punctuation", "tag", "attribute", "regexp", "inserted", "deleted"].map((name) => `tok-${name}`);
const TEXT = ["fg", "muted", "accent", "ok", "warn", "danger", ...TOKENS, ...ANSI];

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
const luminance = (c: Rgb) => c.map((v) => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
const contrast = (a: Rgb, b: Rgb) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
};

test("every theme defines every text color, and each reaches 4.5:1 on bg, surface, and diff rows", () => {
  const themes = blocks.filter((block) => block.vars.bg);
  expect(themes.length).toBe(13); // 12 named themes and the OS-dark default
  const problems: string[] = [];
  for (const { name, vars } of themes) {
    for (const key of TEXT) {
      if (!vars[key]) { problems.push(`${name}: --fulcrum-${key} is missing`); continue; }
      const bg = color(vars.bg!, vars);
      const tint = (name: string): Rgb => color(vars[name]!, vars).map((c, i) => c * 0.08 + bg[i]! * 0.92) as Rgb;
      const backgrounds: Record<string, Rgb> = { bg, surface: color(vars.surface!, vars), "inserted row": tint("tok-inserted"), "deleted row": tint("tok-deleted") };
      for (const [background, rgb] of Object.entries(backgrounds)) {
        const ratio = contrast(color(vars[key]!, vars), rgb);
        if (ratio < 4.5) problems.push(`${name}: --fulcrum-${key} on ${background} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
  expect(problems).toEqual([]);
});
