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
// one-line change. Each takes the growing line so far (`line`) and a character offset in it, and says whether that
// character may still be hidden.
type Wait = (line: string, at: number) => boolean;

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

/** An inline code or emphasis opener: until its closer arrives or its line ends (the words inside always show). A lone `~`
 * is text (strikethrough needs `~~`) unless it ends the line and can still grow into `~~`. */
const spanOpener: Wait = (line, at) => "`*_".includes(line[at]!) || line[at] === "~" && (line[at - 1] === "~" || line[at + 1] === "~" || at === line.length - 1);

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

export const waits: Record<string, Wait> = { blockMarker, spanOpener, bracket, linkTail, angle, entity, backslash };

// A line of pipes, colons, and dashes shows as sent while it arrives, and leaves when it completes a delimiter row (the
// one flip the table rule allows). Order checks drop every line of only pipes, colons, and dashes, with its line break,
// on both sides.
export const withoutDelimiterCells = (text: string) => text.replace(/(?:^|\n)[ \t]*(?=[|:-])[ \t|:-]*(?=\n|$)/g, "");
