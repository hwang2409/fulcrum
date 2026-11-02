import type { ThemeRegistration } from "@shikijs/types";
import type { Token, TokenType } from "./types.js";

const colors: Record<TokenType, string> = {
  keyword: "#000001", string: "#000002", number: "#000003", comment: "#000004",
  function: "#000005", type: "#000006", variable: "#000007", constant: "#000008",
  operator: "#000009", punctuation: "#00000a", tag: "#00000b", attribute: "#00000c",
  regexp: "#00000d", inserted: "#00000e", deleted: "#00000f",
};
const byColor = new Map(Object.entries(colors).map(([type, color]) => [color, type as TokenType]));

// Later TextMate rules are more specific and take precedence over broad rules.
export const semanticTheme: ThemeRegistration = {
  name: "fulcrum-semantic",
  type: "dark",
  fg: "#000000",
  bg: "#ffffff",
  settings: [
    { settings: { foreground: "#000000" } },
    { scope: ["comment"], settings: { foreground: colors.comment } },
    { scope: ["string"], settings: { foreground: colors.string } },
    { scope: ["constant"], settings: { foreground: colors.constant } },
    { scope: ["constant.numeric"], settings: { foreground: colors.number } },
    { scope: ["keyword", "storage.modifier", "storage.type"], settings: { foreground: colors.keyword } },
    { scope: ["variable", "entity.name.variable"], settings: { foreground: colors.variable } },
    { scope: ["punctuation"], settings: { foreground: colors.punctuation } },
    { scope: ["entity.name.function", "support.function", "variable.function"], settings: { foreground: colors.function } },
    { scope: ["entity.name.type", "entity.name.class", "entity.name.namespace", "support.type"], settings: { foreground: colors.type } },
    { scope: ["entity.name.tag"], settings: { foreground: colors.tag } },
    { scope: ["entity.other.attribute-name", "support.type.property-name"], settings: { foreground: colors.attribute } },
    { scope: ["variable.other.constant", "constant.language", "constant.character"], settings: { foreground: colors.constant } },
    { scope: ["keyword.operator"], settings: { foreground: colors.operator } },
    { scope: ["string.regexp", "constant.regexp"], settings: { foreground: colors.regexp } },
    { scope: ["markup.inserted", "markup.inserted.diff"], settings: { foreground: colors.inserted } },
    { scope: ["markup.deleted", "markup.deleted.diff"], settings: { foreground: colors.deleted } },
  ],
};

export function appendToken(tokens: Token[], text: string, color?: string): void {
  if (!text) return;
  const type = color ? byColor.get(color.toLowerCase()) : undefined;
  const last = tokens.at(-1);
  if (last && last.type === type) last.text += text;
  else tokens.push(type ? { text, type } : { text });
}
