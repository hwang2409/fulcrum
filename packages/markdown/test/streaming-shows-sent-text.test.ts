import { expect, test } from "bun:test";
import { createStreamingDocument, parseMarkdown, type Block, type Inline } from "../src/index.js";
import { waits } from "./accepted-changes.js";

// The rule this file locks: streaming never hides text the model already sent. At every streamed prefix, every
// character of the final committed text whose source character has arrived is visible in the rendered tail, in order.
//
// "Markup" is defined narrowly, here and nowhere else. Markup is what the final text does not contain: fence markers,
// the table delimiter row, cell-border pipes of a table, list and quote markers once parsed. Those are absent from the
// final text, so the check never asks for them. A pipe or a backslash inside prose is text, never markup.
//
// The waits at the growing edge that are allowed, and only these, are named one by one in accepted-changes.ts (`waits`):
// a block-marker candidate line (a line of pipes, colons, and dashes is not one: `|`, `||`, `|:-` show as sent until a
// delimiter row is complete), an inline code or emphasis opener, the bracket wait (only `[` and `]` of a possible link
// span `[...]`, released at the first character after `]` that is not `(` or `[`, bounded by the line end; the text
// inside always shows), the destination or label after such a `]`, an autolink `<`, a trailing entity, and a trailing
// backslash. A later `[x]: url` definition never makes a bracket wait.
//
// Every frame also hands a memoized view a new object for each block whose content changed: a block grown in place
// (a whole table row or line arriving in one frame) would stay hidden in a view that skips equal objects.
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

/** Every block object in `blocks` with its content, for the in-place-change check. */
function blockContents(blocks: readonly Block[], into = new Map<Block, string>()) {
  for (const block of blocks) {
    into.set(block, JSON.stringify(block));
    if (block.type === "blockquote") blockContents(block.children, into);
    if (block.type === "list") for (const item of block.items) blockContents(item.children, into);
  }
  return into;
}

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

// Long inputs print only their ends.
const clip = (value: string) => JSON.stringify(value.length > 160 ? `${value.slice(0, 60)}...${value.slice(-100)}` : value);

/**
 * The position in `owed` of a character that `shown` (in order, spaces ignored) lacks, or -1: the first one whose
 * removal leaves the rest in order, so the report names the hidden character, not a later one the greedy match tripped on.
 */
function firstMissing(owed: string, shown: string) {
  const ahead: number[] = []; // ahead[i]: where in `shown` owed[0..i] ends at the earliest
  for (let at = 0, index = 0; at < owed.length; at++, index++) {
    while (index < shown.length && shown[index] !== owed[at]) index++;
    if (index >= shown.length) break;
    ahead[at] = index;
  }
  if (ahead.length === owed.length) return -1;
  const behind: number[] = []; // behind[i]: where in `shown` owed[i..] starts at the latest
  for (let at = owed.length - 1, index = shown.length - 1; at >= 0; at--, index--) {
    while (index >= 0 && shown[index] !== owed[at]) index--;
    if (index < 0) break;
    behind[at] = index;
  }
  for (let at = 0; at <= ahead.length; at++)
    if ((at === 0 || ahead[at - 1] !== undefined) && (at + 1 === owed.length || behind[at + 1] !== undefined) && (at === 0 || at + 1 === owed.length || ahead[at - 1]! < behind[at + 1]!)) return at;
  return ahead.length;
}

/** Streams `source` in `deltas` and checks the rule at every delta boundary; `identity` adds the in-place-change check. */
function check(source: string, deltas: readonly string[], identity = false) {
  const final = visible(parseMarkdown(source));
  const indexes = sourceIndexes(final, source);
  const document = createStreamingDocument();
  let end = 0;
  let previous = new Map<Block, string>();
  for (const delta of deltas) {
    end += delta.length;
    document.append(delta);
    const blocks = document.render();
    const lineStart = source.lastIndexOf("\n", end - 1) + 1;
    const growing = source.slice(lineStart, end);
    const allowed = Object.values(waits);
    const held = (at: number) => at >= lineStart && allowed.some((wait) => wait(growing, at - lineStart));
    const owedIndexes = indexes.filter((index) => index >= 0 && index < end && !held(index));
    const owed = owedIndexes.map((index) => source[index]!).join("");
    const missing = firstMissing(owed, visible(blocks));
    if (missing >= 0) {
      const offset = owedIndexes[missing]!;
      const kind = offset >= lineStart ? "a hidden character no named wait covers" : "a character of an ended line is hidden";
      return `${kind}: ${JSON.stringify(source[offset])} at offset ${offset} of ${clip(source)}, prefix ${clip(source.slice(0, end))}`;
    }
    if (identity) {
      const current = blockContents(blocks);
      for (const [block, content] of current) {
        const before = previous.get(block);
        if (before !== undefined && before !== content && !(block.type === "code" && block.open))
          return `prefix ${clip(source.slice(0, end))}: a ${block.type} changed in place (a memoized view keeps showing ${clip(before)})`;
      }
      previous = current;
    }
  }
  // The stream end ends the last line: nothing of the final text may stay hidden.
  document.finish();
  const missing = firstMissing(indexes.filter((index) => index >= 0).map((index) => source[index]!).join(""), visible(document.render()));
  if (missing >= 0) return `a character is hidden at the stream end: offset ${indexes.filter((index) => index >= 0)[missing]} of ${clip(source)}`;
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
  // brackets that are text show at once; only a possible link span waits, and never its inner text
  "a] b",
  "x [] y",
  "jq '.items[] | x' and more",
  "arr[0] = 1",
  "[x] y",
  "[x](",
  "[x](url) tail",
  "[x][ref] tail",
  "[WARN] disk almost full",
  "see map[key] foo] and ![alt] text",
  "Run `" + "jq '.items[] | .name' ".repeat(12) + "` then " + "arr[i] = b[j]; ".repeat(20) + "[docs](https://e.com/x) end",
  // a lone tilde is text
  "cd ~/src && ls ~ | wc -l\nnext",
  // an ended line shows its unmatched emphasis openers
  "*a b\nmore",
  "2 * 3 *x\nmore",
  "a_b *c\nmore",
  "~~a\nmore",
  "*a b\nmore* tail",
  "`a b\nmore",
  "`a b\nmore` tail",
  "run `npm test\nthen ``x`` and `y\nz",
  // an entity is text until it ends
  "AT&T is here",
  "AT&T\nmore",
  "a &amp; b &#35; c",
  "AT&Tx is",
  "x &amp\nmore",
  "&" + "a".repeat(40) + " tail",
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
  const words = ["use", "grep", "foo", "sort", "-u", "a", "b", "x1", "true", "false", "42", "`a | b`", "a < b", "x<y", "<br", "a[0]", "[x]", "x]", "[ok](u)"];
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

// Delta plans: one character, 7 characters, one whole line (with its line break) per delta, and three lines per delta.
// The line plans are how servers that send line-sized deltas, and a store that batches a frame, deliver text.
const lines = (source: string) => source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const plans: Array<[string, (source: string) => string[], boolean]> = [
  ["every character", (source) => [...source], false],
  ["7-character deltas", (source) => source.match(/[^]{1,7}/g) ?? [], false],
  ["one whole line per delta", lines, true],
  ["three lines per delta", (source) => lines(source).reduce<string[]>((deltas, line, index) => (index % 3 ? deltas[deltas.length - 1] += line : deltas.push(line), deltas), []), true],
];

for (const [name, plan, identity] of plans) {
  test(`every streamed prefix shows every character of the final text sent so far (${sources.length} sources, ${name})`, () => {
    const failures = sources.map((source) => check(source, plan(source), identity)).filter(Boolean);
    expect(failures.slice(0, 8), `${failures.length} of ${sources.length} sources hide sent text`).toEqual([]);
  }, 120_000);
}
