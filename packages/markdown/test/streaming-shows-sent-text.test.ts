import { expect, test } from "bun:test";
import { createStreamingDocument, parseMarkdown, type Block, type Inline } from "../src/index.js";
import { headerCellMarker, lineEndBackslash, waits } from "./accepted-changes.js";

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
// backslash. A later `[x]: url` definition never makes a bracket wait. When a line ends, nothing on it is hidden, with
// one exception named there too (`lineEndBackslash`): a backslash that ends the line, until the next character decides
// a hard break or text. Any other hidden character fails, named with its offset and the input.
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

/**
 * Markdown collapses whitespace runs, removes indentation and trailing space, and turns preserved line and block
 * boundaries into separators. Canonicalizing those four syntax changes still requires every visible-word separator.
 */
const comparable = (value: string) => value.trim().replace(/\s+/g, " ");

/** The source index each comparable final character came from, matched from the end (so never earlier than real). */
function sourceIndexes(final: string, source: string) {
  const indexes: number[] = [];
  let cursor = source.length;
  for (let index = final.length - 1; index >= 0; index--) {
    let at = cursor - 1;
    if (final[index] === " ") {
      while (at >= 0 && !/\s/.test(source[at]!)) at--;
    } else {
      at = source.lastIndexOf(final[index]!, at);
    }
    indexes[index] = at;
    if (at >= 0) cursor = at;
  }
  return indexes;
}

/** The position in `shown` of the first character that is not part of an in-order match in `sent`, or -1. */
function unexplained(shown: string, sent: string) {
  let at = 0;
  for (let index = 0; index < sent.length && at < shown.length; index++) if (sent[index] === shown[at]) at++;
  return at < shown.length ? at : -1;
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

/**
 * Streams `source` in `deltas` and checks the rule at every delta boundary; `identity` adds the in-place-change check.
 * `every` > 1 checks one boundary in `every` (rotating with the source, so the corpus covers every offset) and every
 * boundary that ends a line or the stream; each delta is still appended and rendered.
 */
function check(source: string, deltas: readonly string[], identity = false, every = 1, show = visible) {
  const final = comparable(visible(parseMarkdown(source)));
  const indexes = sourceIndexes(final, source);
  const document = createStreamingDocument();
  let end = 0;
  let previous = new Map<Block, string>();
  for (const [step, delta] of deltas.entries()) {
    end += delta.length;
    document.append(delta);
    const blocks = document.render();
    if ((step + source.length) % every && !delta.endsWith("\n") && step < deltas.length - 1) continue;
    const lineStart = source.lastIndexOf("\n", end - 1) + 1;
    const growing = source.slice(lineStart, end);
    const allowed = Object.values(waits);
    const sent = source.slice(0, end);
    let paragraphStart = lineStart;
    while (paragraphStart > 0) {
      const above = source.lastIndexOf("\n", paragraphStart - 2) + 1;
      if (/^[ \t>]*$/.test(source.slice(above, paragraphStart - 1))) break;
      paragraphStart = above;
    }
    const before = source.slice(paragraphStart, lineStart);
    const held = (at: number) => headerCellMarker(source, at, end)
      || (at >= lineStart ? allowed.some((wait) => wait(growing, at - lineStart, before)) : lineEndBackslash(sent, at, growing));
    const owedCharacters = indexes.flatMap((index, at) => {
      const next = indexes[at + 1];
      const separatesVisibleText = final[at] !== " " || (next !== undefined && next < end && !held(next));
      return index >= 0 && index < end && !held(index) && separatesVisibleText ? [{ character: final[at]!, index }] : [];
    });
    const owedIndexes = owedCharacters.map(({ index }) => index);
    const owed = owedCharacters.map(({ character }) => character).join("");
    const shown = comparable(show(blocks));
    // The reverse direction: everything shown is sent text, in order (owed ⊆ shown ⊆ sent), so no character shows
    // before the text that precedes it in the source, and no stand-in character shows at all.
    const extra = unexplained(shown, comparable(sent));
    if (extra >= 0) return `a shown character the sent text does not explain at that place: ${JSON.stringify(shown[extra])} (shown character ${extra}) of ${clip(source)}, prefix ${clip(sent)}`;
    const missing = firstMissing(owed, shown);
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
  const missing = firstMissing(indexes.flatMap((index, at) => index >= 0 ? final[at]! : []), comparable(show(document.render())));
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
  // a link tail waits until the link closes or its line ends, never past the line end
  "see [a](http://x.y\nnext\n",
  "see [a](x then\nmore\n",
  "call [f](a, b) and [g](\nnext\n",
  "see [a][missing ref\nnext\n",
  "use arr[i](x) to call and arr[j](y z w\nok\n",
  "![alt](no close here\nnext\n",
  "see [docs] | and [a|b](x then\nmore",
  "- see [a](x then\n  more",
  "> see [a][r\n> more",
  "Run `" + "jq '.items[] | .name' ".repeat(12) + "` then " + "arr[i] = b[j]; ".repeat(20) + "[docs](https://e.com/x) end",
  // a `[` whose label is longer than the settled-suffix window shows at its own place, also when its `]`, the next
  // character, and the line end arrive in one delta
  "Note [this applies to every package in the workspace, including the ones that are only built for tests and never published to the registry at all, and the docs].\n",
  "see [note " + "word text ".repeat(200) + "] done and some more words\nnext",
  // a lone tilde is text
  "cd ~/src && ls ~ | wc -l\nnext",
  // an ended line shows its unmatched emphasis openers
  "*a b\nmore",
  "2 * 3 *x\nmore",
  "a_b *c\nmore",
  // a `*` or `_` that cannot open (intraword, followed by a space) shows on the growing line too
  "use snake_case_name and 2 * 3 more",
  "one\ntwo\nthree\nuse snake_case_name and 2 * 3 more",
  "~~a\nmore",
  "*a b\nmore* tail",
  "`a b\nmore",
  // a backslash that ends a line shows; the next line makes it a hard break
  "a\\\n\nb",
  "a\\\nb",
  "> a\\\n> b",
  // a backslash that ends a line, then a line that starts a new block: the backslash is text once that line shows text
  "para\\\n# head",
  "- item\\\n  more\\\n- next",
  "> q\\\n- x",
  "- a\\\n- b long text here",
  "- item\\\n  more\\\n- next\\",
  "a\\\n```\nx",
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
  const words = ["use", "grep", "foo", "sort", "-u", "a", "b", "x1", "true", "false", "42", "`a | b`", "a < b", "x<y", "<br", "a[0]", "[x]", "x]", "[ok](u)", "[a](u", "[g](", "[b][r"];
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
// The character plan checks every prefix on CI. Locally (many test jobs share one machine) it checks the repros at every
// prefix and the random corpus at one prefix in 4 plus every line end: the char plan alone took 79-111 s under load.
const sampled = process.env.CI ? 1 : 4;
const plans: Array<[string, (source: string) => string[], boolean, number?]> = [
  ["every character", (source) => [...source], false, sampled],
  ["7-character deltas", (source) => source.match(/[^]{1,7}/g) ?? [], false],
  ["one whole line per delta", lines, true],
  ["three lines per delta", (source) => lines(source).reduce<string[]>((deltas, line, index) => (index % 3 ? deltas[deltas.length - 1] += line : deltas.push(line), deltas), []), true],
];

for (const [name, plan, identity, every = 1] of plans) {
  test(`every streamed prefix shows every character of the final text sent so far (${sources.length} sources, ${name}${every > 1 ? `, corpus 1 prefix in ${every}` : ""})`, () => {
    const failures = sources.map((source, index) => check(source, plan(source), identity, index < repros.length ? 1 : every)).filter(Boolean);
    expect(failures.slice(0, 8), `${failures.length} of ${sources.length} sources hide sent text`).toEqual([]);
    // All four plans use about 8 s of CPU; the limit is wall time on a machine shared with other test jobs.
  }, 300_000);
}

test("the property catches a hidden word-separating space", () => {
  const failure = check("hello world", [..."hello world"], false, 1, (blocks) => visible(blocks).replace(" ", ""));
  expect(failure).toContain('a hidden character no named wait covers: " " at offset 5');
});

// A `\r` is a line end on its own or before `\n`: the line shows as ended in the frame the `\r` arrives, not one delta
// later, and a `\n` that opens the next delta is not a second line end.
test("a carriage return ends its line in the frame it arrives", () => {
  for (const [deltas, ended] of [[["see <y\r", "\nz"], "see <y"], [["see <y\r", "z"], "see <y"], [["a [b](c\r", "\n", "d"], "a [b](c"]] as const) {
    const document = createStreamingDocument();
    document.append(deltas[0]);
    expect(visible(document.render()), JSON.stringify(deltas)).toBe(ended);
    for (const delta of deltas.slice(1)) document.append(delta);
    document.finish();
    expect(JSON.stringify(document.render()), JSON.stringify(deltas)).toBe(JSON.stringify(parseMarkdown(deltas.join(""))));
  }
});
