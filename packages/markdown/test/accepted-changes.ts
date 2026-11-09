// The accepted changes of the bracket wait (the one place tests name them): a label at a line start shows while its line
// may still become a reference definition, and a shown `[label]` or `[text][label]` becomes a link when its definition
// arrives. Order checks compare text with every definition label of `source`, and the brackets, dropped.
const labels = (source: string) => [...source.matchAll(/^[ \t>\-+*\d.)]*\[([^\]\n]+)\]:/gm)].map((match) => match[1]!);

export function withoutDefinitionLabels(source: string, text: string) {
  const found = labels(source);
  if (!found.length) return text;
  return found.reduce((value, label) => {
    value = value.split(`][${label}]`).join("]").split(label).join("").replace(/\[([^[\]]*)\]/g, "$1");
    // A label still arriving at the end of the text.
    for (let length = label.length - 1; length > 0; length--) if (value.endsWith(label.slice(0, length))) return value.slice(0, -length);
    return value;
  }, text);
}

// An ended line shows its emphasis markers as sent; the line end's full parse may pair a marker the growing line's
// provisional parse showed as text, so that marker leaves (the flash the sent-text rule accepts). Style checks compare
// text without `*` and `_`.
export const withoutEmphasisMarkers = (text: string) => text.replace(/[*_]/g, "");

// The waits at the growing edge that streaming-shows-sent-text.test.ts allows, one named entry each, so removing one is a
// one-line change. Each takes the growing line so far (`line`), a character offset in it, and the paragraph's text above
// the line (`before`, from the last blank line; only the code-span pairing reads it), and says whether that character
// may still be hidden.
type Wait = (line: string, at: number, before: string) => boolean;

// The checker asks about every character of one growing line, so each per-line computation runs once per line.
const once = <T,>(compute: (line: string) => T) => {
  let last: string | undefined;
  let value: T;
  return (line: string) => {
    if (line !== last) { last = line; value = compute(line); }
    return value;
  };
};

/** A growing line that is still only a block-marker candidate (`>`, `-`, `#`, `1.`, fence ticks): until its line ends. */
const markerLine = once((line) => /^[ \t]*(?:#+|[-+*=_]+|\d{1,9}[.)]?|`+|~+)?[ \t]*$/.test(line.replace(/^[ \t]*(?:(?:>|[-+*]|\d{1,9}[.)])(?:[ \t]+|$))*/, "")));
const blockMarker: Wait = (line) => markerLine(line);

/**
 * The `*`/`_` runs of the growing line that can open a span, and its backtick runs that can still open or sit inside a
 * code span: `[start, end)` offsets in `line`. `before` is the paragraph's text above the growing line.
 */
let openerKey: [string, string] | undefined;
let openerValue: Array<[number, number]> = [];
function openerRuns(line: string, before: string) {
  if (openerKey?.[0] === line && openerKey[1] === before) return openerValue;
  const runs: Array<[number, number]> = [];
  const ticks: Array<[number, number]> = [];
  const text = before + line;
  for (let index = 0; index < text.length;) {
    const character = text[index]!;
    if (character === "\\") { index += 2; continue; }
    let end = index + 1;
    while (text[end] === character) end++;
    // CommonMark left-flanking, the condition to open: not followed by whitespace, and an `_` not inside a word. A run
    // that ends the line has no next character yet: that is the `trailingDelimiter` wait, not this one.
    if ((character === "*" || character === "_") && index >= before.length && end < text.length && !/\s/.test(text[end]!)
      && (character === "*" || !/[\p{L}\p{N}]/u.test(text[index - 1] ?? ""))) runs.push([index, end]);
    if (character === "`") ticks.push([index, end]);
    index = end;
  }
  // A backtick run opens a code span while no later run of the same length closes it. Every run after such an open run
  // (on an earlier line of the paragraph or this one) may still be code content, or a span of its own if the open run
  // stays literal: it is undecided until the line ends.
  let open = false;
  for (let index = 0; index < ticks.length; index++) {
    const [start, end] = ticks[index]!;
    const closer = ticks.findIndex(([from, to], at) => at > index && to - from === end - start);
    if (closer < 0 || open) runs.push([start, end]);
    if (closer < 0) open = true;
    else if (!open) index = closer; // the span's own runs, and every run inside it, are paired
  }
  openerKey = [line, before];
  return openerValue = runs.filter(([, end]) => end > before.length).map(([start, end]) => [start - before.length, end - before.length]);
}

/** An inline code or emphasis opener (a left-flanking `*`/`_` run; a backtick run that is unmatched or follows an
 * unmatched one in the paragraph): until its line ends (the words inside always show). A lone `~` is text
 * (strikethrough needs `~~`) unless it ends the line and can still grow into `~~`. */
const spanOpener: Wait = (line, at, before) => openerRuns(line, before).some(([start, end]) => at >= start && at < end)
  || line[at] === "~" && (line[at - 1] === "~" || line[at + 1] === "~" || at === line.length - 1);

/** A `*`, `_`, or backtick run that ends what was sent (`a_`, `x *`, `` x ` ``): the next character decides whether it
 * can open, or grows the run. */
const trailingDelimiter: Wait = (line, at) => /[*_`]/.test(line[at]!) && /^([*_`])\1*$/.test(line.slice(at));

/** The pairs of a possible link span `[...]` on `line`: `[` and `]` offsets, and the offset of a `(` or `[` after `]`. */
const linkSpans = once((line: string) => {
  const spans: Array<{ open: number; close?: number; tail?: number }> = [];
  const open: number[] = [];
  const closes = (after: string) => {
    let depth = 0;
    for (const character of after) if (character === "(") depth++; else if (character === ")" && --depth === 0) return true;
    return false;
  };
  for (let index = 0; index < line.length; index++) {
    if (line[index] === "\\") index++;
    else if (line[index] === "[") open.push(index);
    else if (line[index] === "]" && open.length) {
      const opener = open.pop()!;
      const after = line.slice(index + 1);
      if (!after) spans.push({ open: opener, close: index });
      else if (after[0] === "(" && !closes(after) || after[0] === "[" && !after.includes("]", 1)) {
        spans.push({ open: opener, close: index, tail: index + 1 });
        break;
      }
    }
  }
  for (const opener of open) spans.push({ open: opener });
  return spans;
});

/** The bracket wait: only `[` and `]` of a possible link span, until the character after `]` decides it, bounded by the line end. */
const bracket: Wait = (line, at) => linkSpans(line).some((span) => span.open === at || span.close === at);

/** The destination `(url` or label `[ref` after a closed `[...]`: until the link closes or the line ends. */
const linkTail: Wait = (line, at) => linkSpans(line).some((span) => span.tail !== undefined && at >= span.tail);

/** An autolink opener `<` while nothing after it on the line is a space or `>`: only the `<`. */
const angle: Wait = (line, at) => line[at] === "<" && !/[\s>]/.test(line.slice(at + 1));

/** An entity still arriving at the very end of what was sent (`&`, `&amp`, `&#35`), at most 32 characters after `&`. */
const entityStart = once((line) => {
  const tail = line.slice(-40);
  const run = /&(?:#(?:[xX][0-9a-fA-F]{0,6}|[0-9]{0,7})|[A-Za-z][A-Za-z0-9]{0,31})?$/.exec(tail);
  return run ? line.length - tail.length + run.index : Infinity;
});
const entity: Wait = (line, at) => at >= entityStart(line);

/** A backslash that is the last character sent: the next character decides whether it escapes. */
const backslash: Wait = (line, at) => at === line.length - 1 && line[at] === "\\";

export const waits: Record<string, Wait> = { blockMarker, spanOpener, trailingDelimiter, bracket, linkTail, angle, entity, backslash };

/**
 * The one wait on an ended line, part of the backslash wait: a backslash that ends the line just above the growing line,
 * while the growing line (`line`) is blank or only block markers. Its first other character decides: a line that
 * continues the paragraph makes the backslash a hard break, which drops it; any other line makes it text.
 */
export const lineEndBackslash = (sent: string, at: number, line: string) => at === sent.length - line.length - 2
  && sent[at] === "\\" && sent[at + 1] === "\n" && markerLine(line) && (/\\+$/.exec(sent.slice(0, at + 1))![0].length % 2 === 1);

/**
 * A list marker that a later delimiter row turns into a table cell (GFM: `- | a` above `--|--` is a header whose first
 * cell is `-`): markup until that delimiter row ends, the same flip as a delimiter row completing. `sent` is the length
 * sent so far.
 */
export const headerCellMarker = (source: string, at: number, sent: number) => {
  const lineStart = source.lastIndexOf("\n", at - 1) + 1;
  if (!/^[ \t]*$/.test(source.slice(lineStart, at)) || !"-+*".includes(source[at]!) || !/[ \t]/.test(source[at + 1] ?? "")) return false;
  const next = source.indexOf("\n", at);
  if (next < 0) return false;
  const end = source.indexOf("\n", next + 1);
  const row = source.slice(next + 1, end < 0 ? source.length : end);
  return /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(row) && row.includes("|") && sent <= (end < 0 ? source.length : end);
};

// A line of pipes, colons, and dashes shows as sent while it arrives, and leaves when it completes a delimiter row (the
// one flip the table rule allows). Order checks drop every line of only pipes, colons, and dashes, with its line break,
// on both sides.
export const withoutDelimiterCells = (text: string) => text.replace(/(?:^|\n)[ \t]*(?=[|:-])[ \t|:-]*(?=\n|$)/g, "");
