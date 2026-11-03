// sanitizeSvg runs in real chromium (apps/playground/scripts/mermaid-check.ts): happy-dom parses svg differently.
import { expect, test } from "bun:test";
import { shortError } from "../src/sanitize.ts";
import { themeVariables, TOKENS } from "../src/theme.ts";

test("a parse error is its first line and what it expected, short", () => {
  const error = new Error(`Parse error on line 3:
...[start] --> B(  B --> C[end]
----------------------^
Expecting 'SQE', 'DOUBLECIRCLEEND', 'PE', '-)', 'STADIUMEND', 'SUBROUTINEEND', 'PIPE', got 'SQS'`);
  expect(shortError(error)).toBe("Parse error on line 3: Expecting 'SQE', 'DOUBLECIRCLEEND', 'PE', …, got 'SQS'");
  expect(shortError(new Error("No diagram type detected matching given configuration for text: hello"))).toBe("No diagram type detected matching given configuration for text: hello");
  expect(shortError("x".repeat(500))).toHaveLength(240);
  expect(shortError(new Error(""))).toBe("invalid diagram");
});

test("theme variables come from the tokens: flat, sharp, and dark or light by the background", () => {
  const tokens = Object.fromEntries(TOKENS.map((name, index) => [name, `#${index.toString(16).padStart(2, "0")}0000`]));
  const dark = themeVariables({ ...tokens, bg: "#1a1b26", fg: "#c0caf5", accent: "#7aa2f7" }, "JetBrains Mono", "14px");
  expect(dark).toMatchObject({ darkMode: true, radius: 0, useGradient: false, dropShadow: "", fontFamily: "JetBrains Mono", background: "#1a1b26", primaryTextColor: "#c0caf5", primaryBorderColor: "#7aa2f7", pie1: "#7aa2f7", cScale0: "#7aa2f7" });
  expect(themeVariables({ bg: "#ffffff" }, "mono", "14px").darkMode).toBe(false);
  // a page without the fulcrum tokens keeps mermaid's own colors: nothing undefined reaches mermaid
  expect(Object.values(themeVariables({}, "mono", "14px")).every((value) => value !== undefined)).toBe(true);
});
