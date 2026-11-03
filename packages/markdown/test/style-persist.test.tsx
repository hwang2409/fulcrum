import { expect, test } from "bun:test";
import { createStreamingDocument, type Block, type Inline } from "../src/index.js";

// Strict ux 6, finding M-A: once a span shows as strong or emphasis, no later frame of the growing line may show
// it as raw markers again. Each visible character keeps its position and every style it has had.
type Styled = { text: string; styles: string[] };

function inlineChars(nodes: readonly Inline[], style: string, out: Styled) {
  for (const node of nodes) {
    if (node.type === "strong" || node.type === "emphasis") {
      inlineChars(node.children, style + (node.type === "strong" ? "S" : "E"), out);
    } else if ("children" in node) inlineChars(node.children, style, out);
    else {
      const value = node.type === "image" ? node.alt : "value" in node ? node.value : "";
      out.text += value;
      for (let index = 0; index < value.length; index++) out.styles.push(style);
    }
  }
}

function blockChars(blocks: readonly Block[], out: Styled = { text: "", styles: [] }) {
  for (const block of blocks) {
    if (block.type === "paragraph" || block.type === "heading") inlineChars(block.children, "", out);
    else if (block.type === "blockquote") blockChars(block.children, out);
    else if (block.type === "list") for (const item of block.items) blockChars(item.children, out);
  }
  return out;
}

/** The first frame where shown text moves or a shown style goes away, or undefined. */
function styleRegression(source: string, delta: number) {
  const document = createStreamingDocument();
  let previous: Styled = { text: "", styles: [] };
  for (let offset = 0; offset < source.length; offset += delta) {
    document.append(source.slice(offset, offset + delta));
    const current = blockChars(document.render());
    if (!current.text.startsWith(previous.text)) return `at ${offset + delta}: text moved ${JSON.stringify(previous.text.slice(-40))} -> ${JSON.stringify(current.text.slice(previous.text.length - 40, previous.text.length + 2))}`;
    for (let index = 0; index < previous.styles.length; index++) {
      const lost = [...previous.styles[index]!].find((style) => !current.styles[index]!.includes(style));
      if (lost) return `at ${offset + delta}: char ${index} ${JSON.stringify(previous.text[index])} lost ${lost}`;
    }
    previous = current;
  }
}

const long = " lorem ipsum dolor sit amet".repeat(20);
const reportCases: Record<string, string> = {
  para_strong: "**Bold opener sentence here.**" + long + "\n",
  para_em: "*Emph opener sentence here.*" + long + "\n",
  para_code: "`code opener here`" + long + "\n",
  para_link: "[a link opener](https://example.com)" + long + "\n",
  list_strong: "- **Bold opener sentence here.**" + long + "\n",
  mid_strong: "start text **bold in the middle** then" + long + "\n",
};

for (const delta of [1, 7, 64]) for (const [name, source] of Object.entries(reportCases)) {
  test(`report case ${name} keeps its style at ${delta}-character deltas`, () => {
    expect(styleRegression(source, delta)).toBeUndefined();
  });
}

function random(seed: number) {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

test("generated long lines with styled spans before and after the suffix cut have zero style regressions", () => {
  const rng = random(0x5eed);
  const pick = <Value,>(values: readonly Value[]) => values[Math.floor(rng() * values.length)]!;
  const words = (length: number) => {
    let text = "";
    // Code spans, links, and autolinks inside a styled span put another opener on top of the emphasis.
    while (text.length < length) text += pick(["alpha", "beta", "gamma", "delta", "lorem", "ipsum", "sit", "amet", "`x`", "`a b`", "[a b](u)", "<https://e.com>"]) + " ";
    return text;
  };
  const failures: string[] = [];
  for (let index = 0; index < 400; index++) {
    const container = pick(["", "- ", "1. ", "> "]);
    const marker = pick(["**", "*", "__", "_", "***"]);
    const before = pick([0, 30, 200, 240, 255, 270, 400, 900]);
    const total = 200 + Math.floor(rng() * 1_801);
    let line = before ? words(before) : "";
    while (line.length < total) {
      line += `${marker}${words(pick([5, 60, 200, 300])).trimEnd()}${marker}${pick([" ", ". ", ", "])}`;
      line += words(pick([20, 100, 300]));
    }
    const source = `${container}${line.trimEnd()}\n`;
    const delta = pick([1, 7, 64]);
    const failure = styleRegression(source, delta);
    if (failure) failures.push(`${JSON.stringify(source.slice(0, 80))}… (${source.length}, ${marker}, delta ${delta}) ${failure}`);
  }
  expect(`${failures.length} regressions\n${failures.slice(0, 5).join("\n")}`).toBe("0 regressions\n");
}, 60_000);
