import { expect, test } from "bun:test";
import { parseAnsi } from "../src/tools/ansi.js";
import { jsonText } from "../src/tools/json.js";

const ESC = "\x1b";
const styled = (input: string) => {
  const { text, spans } = parseAnsi(input);
  return { text, spans: spans.map(({ start, end, style }) => [text.slice(start, end), style]) };
};

test("SGR colors, bold, and underline become themed spans; reset ends them", () => {
  expect(styled(`${ESC}[31merror${ESC}[0m: ${ESC}[1;4mfile.ts${ESC}[22m:3${ESC}[m ok`)).toEqual({
    text: "error: file.ts:3 ok",
    spans: [["error", "ansi-red"], ["file.ts", "ansi-bold ansi-underline"], [":3", "ansi-underline"]],
  });
  expect(styled(`${ESC}[92mpass${ESC}[39m ${ESC}[41;30m FAIL ${ESC}[49m${ESC}[2mdim${ESC}[0m`).spans).toEqual([
    ["pass", "ansi-bright-green"], [" FAIL ", "ansi-black ansi-bg-red"], ["dim", "ansi-black ansi-dim"],
  ]);
  // Inverse (7) swaps the run's colors through a themed class; 27 and 0 end it.
  expect(styled(`${ESC}[7mA${ESC}[27mB${ESC}[31;7mC${ESC}[0mD`).spans).toEqual([["A", "ansi-inverse"], ["C", "ansi-red ansi-inverse"]]);
  // 256-color indexes below 16 are the theme's 16 colors; others and truecolor keep the theme's text color.
  expect(styled(`${ESC}[38;5;9mA${ESC}[38;5;200mB${ESC}[38;2;1;2;3mC${ESC}[0m`).spans).toEqual([["A", "ansi-bright-red"]]);
});

test("other control sequences are stripped; text is never lost", () => {
  const input = `a${ESC}[2K${ESC}[1G${ESC}]8;;https://x.dev${ESC}\\link${ESC}]8;;${ESC}\\${ESC}(Bb\x07c\x08d${ESC}]0;title\x07e\x9b32mf`;
  expect(parseAnsi(input).text).toBe("alinkbcdef");
  expect(parseAnsi("tab\tand\r\nlines\n").text).toBe("tab\tand\r\nlines\n");
  expect(parseAnsi("no escapes here").spans).toEqual([]);
});

test("malicious and huge sequences stay bounded and linear", () => {
  // An unterminated CSI with a megabyte of parameters is dropped at its bound; the rest stays text.
  const params = `${ESC}[${"1;".repeat(500_000)}`;
  const started = performance.now();
  const parsed = parseAnsi(`${params}tail`);
  expect(performance.now() - started).toBeLessThan(500);
  expect(parsed.text.endsWith("tail")).toBe(true);
  expect(parsed.text.includes(ESC)).toBe(false);
  // An unterminated OSC does not swallow the rest of the output.
  expect(parseAnsi(`${ESC}]0;${"x".repeat(10_000)}\nvisible`).text.endsWith("\nvisible")).toBe(true);
  // A huge number of style changes produces at most one span per styled run.
  const many = Array.from({ length: 100_000 }, (_, i) => `${ESC}[3${i % 8}m${i % 10}`).join("");
  const result = parseAnsi(many);
  expect(result.text.length).toBe(100_000);
  expect(result.spans.length).toBeLessThanOrEqual(100_000);
  expect(parseAnsi(`${ESC}[99999999999999999999m x`).text).toBe(" x");
});

test("streamed chunks parse the same as the whole, even when a chunk splits an escape", () => {
  const input = `${ESC}[1;31mFAIL${ESC}[0m src/a.test.ts\n${ESC}[32m✓${ESC}[39m ok ${ESC}[7mselected${ESC}[27m back\n`;
  const whole = parseAnsi(input);
  expect(whole.spans.map(({ start, end, style }) => [whole.text.slice(start, end), style]).at(-1)).toEqual(["selected", "ansi-green ansi-inverse"]);
  for (let cut = 0; cut <= input.length; cut++) {
    const first = parseAnsi(input.slice(0, cut));
    expect([cut, parseAnsi(input.slice(cut), first)]).toEqual([cut, whole]);
  }
});

test("JSON is detected structurally, never by guessing; compact JSON is pretty-printed losslessly", () => {
  expect(jsonText('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', json: true });
  expect(jsonText('[1,{"b":[],"c":{}},"x,\\"y:"]')).toEqual({ text: '[\n  1,\n  {\n    "b": [],\n    "c": {}\n  },\n  "x,\\"y:"\n]', json: true });
  // Big integers keep every digit: the printer re-indents the source, it does not round-trip numbers.
  expect(jsonText('{"id":12345678901234567890}').text).toBe('{\n  "id": 12345678901234567890\n}');
  // Already formatted JSON stays exactly as sent.
  expect(jsonText('{\n    "a": 1\n}\n')).toEqual({ text: '{\n    "a": 1\n}\n', json: true });
  for (const text of ["", "42", '"str"', "true", "{not json}", "{\"a\":1} trailing", "hello {\"a\":1}", "[1,2"]) expect(jsonText(text)).toEqual({ text, json: false });
  // Over the bound it is JSON but left as sent.
  const big = `[${"1,".repeat(200_000)}1]`;
  expect(jsonText(big)).toEqual({ text: big, json: true });
});
