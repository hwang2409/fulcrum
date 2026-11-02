/** A styled run of `text`: [start, end) with the space-separated `ansi-*` classes that color it. */
export type AnsiSpan = { start: number; end: number; style: string };
/**
 * Terminal output with its escape codes applied: `text` has every control sequence removed, `spans` style it. `style`
 * and `tail` (an escape split by a chunk boundary, held back) let `parseAnsi(next, prior)` continue a stream.
 */
export type AnsiText = { text: string; spans: AnsiSpan[]; style: Style; tail: string };
type Style = { fg?: number; bg?: number; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; inverse?: boolean };

const NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const color = (index: number) => (index < 8 ? NAMES[index] : `bright-${NAMES[index - 8]}`);
// Bounds keep a malicious stream linear: a sequence that runs past its bound is dropped and the rest stays text.
const MAX_CSI = 64;
const MAX_STRING = 4_096; // OSC (titles, hyperlinks), DCS, SOS, PM, APC
const MAX_ESCAPE = 16;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
const STRING_STARTS = "]PX^_";
const C1_STRINGS: Record<number, boolean> = { 0x9d: true, 0x90: true, 0x98: true, 0x9e: true, 0x9f: true };

const classes = (style: Style) => {
  const out: string[] = [];
  // Inverse draws the foreground as the background, with the page background as text (the badge rule below), so it
  // keeps the contrast every theme is checked for; a set background's color is not used as text.
  if (style.inverse) out.push(style.fg === undefined ? "ansi-inverse" : `ansi-bg-${color(style.fg)}`);
  else {
    if (style.fg !== undefined) out.push(`ansi-${color(style.fg)}`);
    if (style.bg !== undefined) out.push(`ansi-bg-${color(style.bg)}`);
  }
  if (style.bold) out.push("ansi-bold");
  if (style.dim) out.push("ansi-dim");
  if (style.italic) out.push("ansi-italic");
  if (style.underline) out.push("ansi-underline");
  return out.join(" ");
};

const number = (field: string | undefined) => (field === undefined ? undefined : field === "" ? 0 : field.length > 5 ? -1 : Number(field));

function applySgr(style: Style, params: string): Style {
  const next = { ...style };
  // `:` separates sub-parameters (38:5:n, 4:3).
  const codes = params.split(";").map((param) => param.split(":"));
  for (let i = 0; i < codes.length; i++) {
    const fields = codes[i]!;
    const code = number(fields[0]);
    if (code === 0) for (const key of Object.keys(next) as Array<keyof Style>) delete next[key];
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = fields[1] !== "0";
    else if (code === 7) next.inverse = true;
    else if (code === 21) next.underline = true;
    else if (code === 22) { delete next.bold; delete next.dim; }
    else if (code === 23) delete next.italic;
    else if (code === 24) delete next.underline;
    else if (code === 27) delete next.inverse;
    else if (code! >= 30 && code! <= 37) next.fg = code! - 30;
    else if (code === 39) delete next.fg;
    else if (code! >= 40 && code! <= 47) next.bg = code! - 40;
    else if (code === 49) delete next.bg;
    else if (code! >= 90 && code! <= 97) next.fg = code! - 82;
    else if (code! >= 100 && code! <= 107) next.bg = code! - 92;
    else if (code === 38 || code === 48) {
      // shortcut: 256-color indexes 16-255 and truecolor keep the theme's color, so text holds its contrast in every
      // theme; map them to the nearest theme color if tools that rely on them become common.
      const colon = fields.length > 1;
      const mode = colon ? number(fields[1]) : number(codes[i + 1]?.[0]);
      const index = colon ? number(fields[2]) : number(codes[i + 2]?.[0]);
      const key = code === 38 ? "fg" : "bg";
      if (mode === 5 && index !== undefined && index >= 0 && index < 16) next[key] = index;
      else delete next[key];
      if (!colon) i += mode === 5 ? 2 : mode === 2 ? 4 : 0;
    }
  }
  return next;
}

/** Applies SGR codes and strips every other control sequence. Pass the previous result to continue a stream. */
export function parseAnsi(chunk: string, prior?: AnsiText): AnsiText {
  const input = prior ? prior.tail + chunk : chunk;
  let text = prior?.text ?? "";
  const spans = prior?.spans ?? [];
  let style = prior?.style ?? {};
  let styleClass = classes(style);
  let tail = "";
  const emit = (from: number, to: number) => {
    if (to <= from) return;
    const start = text.length;
    text += input.slice(from, to);
    if (!styleClass) return;
    const last = spans.at(-1);
    if (last && last.end === start && last.style === styleClass) spans[spans.length - 1] = { ...last, end: text.length };
    else spans.push({ start, end: text.length, style: styleClass });
  };
  let at = 0;
  CONTROL.lastIndex = 0;
  for (let match = CONTROL.exec(input); match; match = CONTROL.exec(input)) {
    const i = match.index;
    emit(at, i);
    const code = input.charCodeAt(i);
    const next = input[i + 1];
    let end = i + 1; // where text resumes
    if (code === 0x1b && next === undefined) { tail = input.slice(i); at = input.length; break; }
    const csi = code === 0x9b || (code === 0x1b && next === "[");
    const string = C1_STRINGS[code] || (code === 0x1b && STRING_STARTS.includes(next!));
    if (csi) {
      const from = code === 0x9b ? i + 1 : i + 2;
      let j = from;
      while (j < input.length && j - from <= MAX_CSI && input.charCodeAt(j) >= 0x20 && input.charCodeAt(j) <= 0x3f) j++;
      const final = input.charCodeAt(j);
      if (j === input.length && j - from <= MAX_CSI) { tail = input.slice(i); at = input.length; break; }
      if (j - from <= MAX_CSI && final >= 0x40 && final <= 0x7e) {
        if (final === 0x6d && !/[\x20-\x2f<=>?]/.test(input.slice(from, j))) { style = applySgr(style, input.slice(from, j)); styleClass = classes(style); }
        end = j + 1;
      } else end = from; // malformed or over the bound: drop the introducer only
    } else if (string) {
      const from = code === 0x1b ? i + 2 : i + 1;
      let j = from;
      let close = -1;
      for (; j < input.length && j - from <= MAX_STRING; j++) {
        const c = input.charCodeAt(j);
        if (c === 0x07 || c === 0x9c) { close = j + 1; break; }
        if (c === 0x1b) { if (j + 1 === input.length) break; close = input[j + 1] === "\\" ? j + 2 : j; break; }
      }
      if (close < 0 && j === input.length && j - from <= MAX_STRING) { tail = input.slice(i); at = input.length; break; }
      end = close < 0 ? from : close;
    } else if (code === 0x1b) {
      let j = i + 1;
      while (j < input.length && j - i <= MAX_ESCAPE && input.charCodeAt(j) >= 0x20 && input.charCodeAt(j) <= 0x2f) j++;
      if (j === input.length && j - i <= MAX_ESCAPE) { tail = input.slice(i); at = input.length; break; }
      const final = input.charCodeAt(j);
      end = final >= 0x30 && final <= 0x7e && j - i <= MAX_ESCAPE ? j + 1 : i + 1;
    }
    at = end;
    CONTROL.lastIndex = end;
  }
  emit(at, input.length);
  return { text, spans, style, tail };
}

/** The spans that overlap [start, end), clipped to it and shifted to start at 0. */
export function spansIn(spans: AnsiSpan[], start: number, end: number): AnsiSpan[] {
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (spans[mid]!.end <= start) low = mid + 1;
    else high = mid;
  }
  const out: AnsiSpan[] = [];
  for (let i = low; i < spans.length && spans[i]!.start < end; i++) {
    const span = spans[i]!;
    out.push({ start: Math.max(span.start, start) - start, end: Math.min(span.end, end) - start, style: span.style });
  }
  return out;
}

/** True when the text has any control character, so plain output skips the parser. */
export const hasControls = (text: string) => {
  CONTROL.lastIndex = 0;
  return CONTROL.test(text);
};
