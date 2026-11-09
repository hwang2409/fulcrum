import { expect, test } from "bun:test";
import { createStreamingDocument, parseMarkdown, type Block, type Inline } from "../src/index.js";

// The rule this file locks: streaming never hides text the model already sent. At every streamed prefix, every
// character of the final committed text whose source character has arrived is visible in the rendered tail, in order.
//
// "Markup" is defined narrowly, here and nowhere else. Markup is what the final text does not contain: fence markers,
// the table delimiter row, cell-border pipes of a table, list and quote markers once parsed. Those are absent from the
// final text, so the check never asks for them. A pipe or a backslash inside prose is text, never markup.
//
// Three waits at the growing edge are allowed, and only these three:
// - a growing line that is still only a block-marker candidate (a lone `>`, `-`, `+`, `*`, `=`, `#` run, a number
//   that may become `1.`, fence ticks, or only pipes, colons, and dashes: a table delimiter row still arriving, like
//   `|`, `||`, or `|:-`): it may hide
//   until its line ends, as a lone `>` or `-` always has (it shows at commit if it stays text);
// - an inline span opener on the growing line (a backtick, `*`, `_`, `~`, `[`): it may still open code, emphasis, or a
//   link, so it may hide until its closer arrives or its line ends (the words inside it always show);
// - a backslash that is the last character sent: the next character decides whether it escapes (and vanishes) or
//   is text, so showing it could flash a character that disappears.
const text = (nodes: readonly Inline[]): string => nodes.map((node) =>
  node.type === "text" || node.type === "code" || node.type === "pending-reference" ? node.value
  : node.type === "image" ? node.alt
  : node.type === "break" ? "\n"
  : text(node.children)).join("");

const visible = (blocks: readonly Block[]): string => blocks.map((block) =>
  block.type === "paragraph" || block.type === "heading" ? text(block.children)
  : block.type === "code" ? block.value
  : block.type === "table" ? [...block.header, ...block.rows.flat()].map(text).join(" ")
  : block.type === "blockquote" ? visible(block.children)
  : block.type === "list" ? block.items.map((item) => visible(item.children)).join("\n") : "").join("\n");

const blockMarkerCandidate = (line: string) => {
  const rest = line.replace(/^[ \t]*(?:(?:>|[-+*]|\d{1,9}[.)])(?:[ \t]+|$))*/, "");
  return /^[ \t]*(?:#+|[-+*=_]+|\d{1,9}[.)]?|`+|~+)?[ \t]*$/.test(rest) || /^[ \t|:-]*$/.test(rest);
};

/** The source index each non-space character of `final` came from, matched from the end (so never earlier than real). */
function sourceIndexes(final: string, source: string) {
  const indexes: number[] = [];
  let cursor = source.length;
  for (let index = final.length - 1; index >= 0; index--) {
    const at = /\s/.test(final[index]!) ? -1 : source.lastIndexOf(final[index]!, cursor - 1);
    indexes[index] = at;
    if (at >= 0) cursor = at;
  }
  return indexes;
}

function check(source: string, split: number) {
  const final = visible(parseMarkdown(source));
  const indexes = sourceIndexes(final, source);
  const document = createStreamingDocument();
  for (let start = 0; start < source.length; start += split) {
    const end = Math.min(start + split, source.length);
    document.append(source.slice(start, end));
    const lineStart = source.lastIndexOf("\n", end - 1) + 1;
    const growing = source.slice(lineStart, end);
    const entity = /&(?:#(?:x[0-9a-f]*|[0-9]*)?|[a-z][a-z0-9]*)?$/i.exec(growing);
    const waits = (at: number) => at >= lineStart && (blockMarkerCandidate(growing) || "`*_~[]".includes(source[at]!)
      || source[at] === "<" && !/[\s>]/.test(source.slice(at + 1, end))
      || entity !== null && at >= lineStart + entity.index)
      || at === end - 1 && source[at] === "\\";
    const owed = [...final].filter((character, index) => indexes[index]! >= 0 && indexes[index]! < end && !waits(indexes[index]!)).join("");
    const seen = visible(document.render()).replace(/\s/g, "");
    let at = 0;
    for (const character of seen) if (character === owed[at]) at++;
    // Long lines print only their ends, so the report names the hidden text.
    const clip = (value: string) => JSON.stringify(value.length > 160 ? `${value.slice(0, 60)}...${value.slice(-100)}` : value);
    if (at < owed.length) return `prefix ${clip(source.slice(0, end))}: owed ${clip(owed)}, seen ${clip(seen)}, missing from ${clip(owed.slice(at))}`;
  }
  return undefined;
}

const repros = [
  // a pipe inside a line, in prose
  "Run it:\n\nuse grep foo | sort -u to dedupe",
  "Pick true || false and a|b",
  "Use \\| to escape: a \\| b",
  "Results:\n\na | b",
  "Run `a | b` now, then `c || d`.",
  "C:\\path\\to | the end",
  // a line that starts with a pipe, stalled or ended on
  "| a | b |",
  "Intro\n\n| a | b |",
  "| a | b |\n",
  "| a | b |\n| - |",
  "| a | b |\nmo",
  "Intro\n| a | b |",
  "> | a | b |",
  "- item\n  | a | b |",
  "| grep foo is how you pipe",
  "a\n| x |\nb",
  "Intro line\n| a | b |\nmore prose",
  "Use the shell:\n\n| grep foo is how you pipe\nand then sort the output",
  "Results:\n\n| a | b |\nnot a delimiter",
  "Results:\n\n| a | b |\n|:-",
  "Results:\n\n|",
  // a paragraph line directly above a table header
  "Intro line\n| a | b |\n|---|---|\n| 1 | 2 |",
  "Intro line\na | b\n--|--\nc | d",
  // tables, in quotes and lists
  "Every check passed:\n\n| check | result |\n| --- | --- |\n| typecheck | pass |\n| unit tests | 412 pass |\n\nDone.",
  "| x | y |\n|:--|--:|\n| 1 | 2 |\n| a \\| b | `c | d` |",
  "Quote:\n\n> | a | b |\n> |---|---|\n> | 1 | 2 |\n> | 3 | 4 |",
  "> Intro\n>\n> | a | b |\n> |---|---|\n> | 1 | 2 |",
  "- item\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n- next",
  "| a | b | c |\n|---|---|\n| 1 | 2 |",
  // an angle bracket is text until it closes an autolink
  "Check a < b and x<y here",
  "Line one<br",
  "Line one<br and more",
  "See <https://example.com/a_b for it",
  "See <https://example.com/a_b> for it",
  "<https://",
  // an entity is text until it ends
  "AT&T is here",
  "AT&T\nmore",
  "a &amp; b &#35; c",
  // lines longer than the growing line's settled-suffix window (PENDING_INLINE_SUFFIX, 128 characters) and than 4 KB
  "Run `" + "a | b ".repeat(200) + "` now",
  "Run `" + "a | b ".repeat(200),
  "kubectl get pods -o json | jq '.items[] | .metadata.name' | sort | uniq -c | sort -rn | head -n 20 | awk '{print $2}' | xargs -n1 kubectl describe pod | grep -i error",
  "see <" + "a|b".repeat(400) + " x",
  "| " + Array.from({ length: 700 }, (_, index) => `c${index}`).join(" | ") + " |",
  "Intro\n\n| a | b |\n|---|---|\n| " + "x | y ".repeat(120) + "|",
];

// Random pipe text: words, every kind of pipe, rows, delimiter rows, and container markers, joined into lines.
function corpus(count: number) {
  let seed = 120;
  const next = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const pick = <T,>(items: readonly T[]) => items[next(items.length)]!;
  const words = ["use", "grep", "foo", "sort", "-u", "a", "b", "x1", "true", "false", "42", "`a | b`", "a < b", "x<y", "<br"];
  const joins = [" ", " ", " | ", "|", " || ", " \\| ", "||", " \\ "];
  const lines = ["| a | b |", "|---|---|", "| :-- | --: |", "| 1 | 2 |", "a | b", "--|--", ""];
  const prefixes = ["", "", "> ", "- ", "  "];
  // A line this long crosses the growing line's settled-suffix window (PENDING_INLINE_SUFFIX).
  const long = () => {
    let value = pick(words);
    for (let word = 40 + next(40); word > 0; word--) value += pick(joins) + pick(words);
    return value;
  };
  const sources: string[] = [];
  for (let index = 0; index < count; index++) {
    const out: string[] = [];
    for (let line = 1 + next(6); line > 0; line--) {
      if (next(3) === 0) out.push(pick(prefixes) + pick(lines));
      else if (next(4) === 0) out.push(pick(prefixes) + (next(4) === 0 ? "| " : "") + long());
      else {
        let value = pick(words);
        for (let word = next(5); word > 0; word--) value += pick(joins) + pick(words);
        out.push(pick(prefixes) + (next(4) === 0 ? "| " : "") + value);
      }
    }
    sources.push(out.join("\n") + (next(2) ? "\n" : ""));
  }
  return sources;
}

const sources = [...repros, ...corpus(400)];

test(`every streamed prefix shows every character of the final text sent so far (${sources.length} sources, every prefix)`, () => {
  const failures = sources.map((source) => check(source, 1)).filter(Boolean);
  expect(failures.slice(0, 8), `${failures.length} of ${sources.length} sources hide sent text`).toEqual([]);
});

test(`the same holds when the text arrives in chunks (${sources.length} sources, 7-character deltas)`, () => {
  const failures = sources.map((source) => check(source, 7)).filter(Boolean);
  expect(failures.slice(0, 8), `${failures.length} of ${sources.length} sources hide sent text`).toEqual([]);
});
