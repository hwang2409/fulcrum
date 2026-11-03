import { delimiterRun } from "./delimiters.js";
import type { Inline } from "./index.js";

/** Only this many trailing characters of a growing line may be provisional. */
export const PENDING_INLINE_SUFFIX = 256;

type OpenerKind = "emphasis" | "code" | "bracket" | "angle";
// A bracket moves through `dest`, `title`, `close`, or `ref` after its `]`; that syntax stays hidden.
type LinkState = "text" | "dest" | "title" | "close" | "ref";
type Opener = { index: number; end: number; kind: OpenerKind; marker: string; node: number; state: LinkState; hideFrom?: number; quote?: string };

const whitespace = (character: string | undefined) => character !== undefined && /\s/.test(character);
const runLength = (source: string, index: number) => {
  let end = index;
  while (source[end] === source[index]) end++;
  return end - index;
};
const special = /[\\`*_~[\]!<]/g;

/** Source that puts a lone parse of the suffix back into the state the line is in at `emittedEnd`. */
function suffixContext(opener: Opener | undefined) {
  if (!opener || opener.kind === "emphasis") return "";
  if (opener.kind !== "bracket") return opener.marker;
  if (opener.state === "text") return "[";
  if (opener.state === "ref") return "[][";
  if (opener.state === "dest") return "[](";
  if (opener.state === "close") return "[](x \"\"";
  return opener.quote ? `[](x ${opener.quote === ")" ? "(" : opener.quote}` : "[](x ";
}

/**
 * Tracks unresolved inline openers over one growing line. A scan stops early when a closer resolves an
 * opener from an earlier scan, because the text after that opener must be parsed again as one span.
 */
class OpenerScan {
  resolved?: Opener;

  constructor(private readonly source: string, private readonly openers: Opener[], private readonly existing: number) {}

  run(from: number, to: number) {
    for (let index = from; index < to && !this.resolved;) index = this.step(index, to);
    return this.resolved;
  }

  private resolve(position: number) {
    if (position < this.existing) this.resolved = this.openers[position];
    this.openers.length = position;
  }

  private push(index: number, end: number, kind: OpenerKind) {
    this.openers.push({ index, end, kind, marker: this.source.slice(index, end), node: -1, state: "text" });
    return end;
  }

  private step(index: number, to: number): number {
    const top = this.openers.at(-1);
    if (top?.kind === "code") return this.code(index, to, top);
    if (top?.kind === "angle") return this.angle(index, to);
    if (top?.kind === "bracket" && top.state !== "text") return this.link(index, top);
    return this.text(index, to);
  }

  private text(from: number, to: number) {
    special.lastIndex = from;
    const index = special.exec(this.source)?.index ?? to;
    if (index >= to) return to;
    const character = this.source[index]!;
    if (character === "\\") return index + 2;
    if (character === "`") return this.push(index, index + runLength(this.source, index), "code");
    if (character === "[") return this.push(index, index + 1, "bracket");
    if (character === "!") return this.source[index + 1] === "[" ? this.push(index, index + 2, "bracket") : index + 1;
    if (character === "<") return this.push(index, index + 1, "angle");
    if (character === "]") return this.closeBracket(index);
    return this.emphasis(index);
  }

  private emphasis(index: number) {
    const length = runLength(this.source, index);
    const { canOpen, canClose } = delimiterRun(this.source, index, length);
    const match = canClose ? this.emphasisOpener(this.source[index]!) : -1;
    if (match >= 0) this.resolve(match);
    else if (canOpen) this.push(index, index + length, "emphasis");
    return index + length;
  }

  private emphasisOpener(marker: string) {
    for (let position = this.openers.length - 1; position >= 0; position--) {
      const opener = this.openers[position]!;
      if (opener.kind === "bracket") return -1;
      if (opener.marker[0] === marker) return position;
    }
    return -1;
  }

  private closeBracket(index: number) {
    let position = this.openers.length - 1;
    while (position >= 0 && this.openers[position]!.kind !== "bracket") position--;
    if (position < 0) return index + 1;
    const opener = this.openers[position]!;
    const next = this.source[index + 1];
    if (next !== "(" && next !== "[") {
      this.resolve(position);
      return index + 1;
    }
    this.openers.length = position + 1;
    opener.state = next === "(" ? "dest" : "ref";
    opener.hideFrom = index;
    return index + 2;
  }

  private code(from: number, to: number, opener: Opener) {
    const index = this.source.indexOf("`", from);
    if (index < 0 || index >= to) return to;
    const length = runLength(this.source, index);
    if (length === opener.marker.length) this.resolve(this.openers.length - 1);
    return index + length;
  }

  private angle(from: number, to: number) {
    const match = /[>\s]/g;
    match.lastIndex = from;
    const index = match.exec(this.source)?.index ?? to;
    if (index >= to) return to;
    this.resolve(this.openers.length - 1);
    return index + 1;
  }

  private link(index: number, opener: Opener) {
    const character = this.source[index]!;
    if (character === "\\" && opener.state !== "close") return index + 2;
    const top = this.openers.length - 1;
    if (opener.state === "dest") {
      if (character === ")") this.resolve(top);
      else if (whitespace(character)) opener.state = "title";
    } else if (opener.state === "ref") {
      if (character === "]" || character === "[") this.resolve(top);
    } else if (opener.state === "close") {
      if (!whitespace(character)) this.resolve(top);
    } else this.title(character, opener, top);
    return index + 1;
  }

  private title(character: string, opener: Opener, top: number) {
    if (opener.quote) {
      if (character === opener.quote) opener.state = "close";
    } else if (character === "\"" || character === "'" || character === "(") opener.quote = character === "(" ? ")" : character;
    else if (!whitespace(character)) this.resolve(top);
  }
}

export type InlineParser = (source: string, streaming: boolean) => Inline[];

const rawKinds: ReadonlySet<OpenerKind> = new Set(["code", "angle"]);

/** Cuts at a recent space so no construct, escape, or surrogate pair is split between stable chunks. */
function cutPoint(source: string, target: number) {
  if (target <= 0) return 0;
  const window = Math.max(0, target - 64);
  const space = source.slice(window, target).lastIndexOf(" ");
  let cut = space >= 0 ? window + space + 1 : target;
  // A suffix that starts with a backtick would merge with the code-span marker it is parsed behind.
  const unsafe = (index: number) => source[index] === "`" || /[\uDC00-\uDFFF]/.test(source[index]!) || /[\\!]/.test(source[index - 1]!)
    || source[index] === source[index - 1] && /[*_~]/.test(source[index]!) || source[index - 1] === "]" && /[([]/.test(source[index]!);
  while (cut > 0 && unsafe(cut)) cut--;
  return cut;
}

/**
 * The growing line of the open paragraph: stable nodes for `content.slice(0, emittedEnd)` plus a provisional
 * suffix of at most PENDING_INLINE_SUFFIX characters. Stable text is emitted once; a closer re-parses only
 * the span after the opener it resolves.
 */
export class PendingInline {
  readonly nodes: Inline[] = [];
  content = "";
  emittedEnd = 0;
  copiedCharacters = 0;
  private readonly openers: Opener[] = [];

  constructor(private readonly parse: InlineParser) {}

  get owner(): Readonly<Opener> | undefined {
    return this.openers[0];
  }

  /** Appends text to the line and returns the nodes of its suffix, which later text may still restyle. */
  append(delta: string): Inline[] {
    this.content += delta;
    const cut = cutPoint(this.content, this.content.length - PENDING_INLINE_SUFFIX);
    if (cut > this.emittedEnd) this.emitStable(cut);
    return this.suffix();
  }

  /** Final streaming nodes for the finished line, or undefined when `line` does not extend this line. */
  commit(line: string): Inline[] | undefined {
    if (!line.startsWith(this.content)) return undefined;
    this.content = line;
    const owner = this.openers[0];
    const kept = owner ? owner.node : this.nodes.length;
    const tail = this.parseText(owner ? owner.index : this.emittedEnd, line.length, true);
    const nodes = this.nodes.slice(0, kept);
    for (const node of tail) nodes.push(node);
    return nodes;
  }

  private emitStable(cut: number) {
    let from = this.emittedEnd;
    for (;;) {
      const existing = this.openers.length;
      const resolved = new OpenerScan(this.content, this.openers, existing).run(from, cut);
      if (!resolved) {
        this.emitSegments(from, cut, existing);
        break;
      }
      this.nodes.length = resolved.node;
      from = resolved.index;
    }
    this.emittedEnd = cut;
  }

  private emitSegments(from: number, to: number, existing: number) {
    let start = from;
    let owner = this.openers[existing - 1];
    for (let position = existing; position < this.openers.length; position++) {
      const opener = this.openers[position]!;
      this.emitText(start, opener.index, owner);
      opener.node = this.nodes.length;
      start = opener.end;
      owner = opener;
    }
    this.emitText(start, to, owner);
  }

  private emitText(from: number, to: number, owner: Opener | undefined) {
    const end = owner?.hideFrom === undefined ? to : Math.min(to, owner.hideFrom);
    const nodes = owner && rawKinds.has(owner.kind) ? this.rawText(from, end) : this.parseText(from, end, false);
    for (const node of nodes) this.nodes.push(node);
  }

  private rawText(from: number, to: number): Inline[] {
    if (from >= to) return [];
    this.copiedCharacters += to - from;
    return [{ type: "text", value: this.content.slice(from, to).replace(/\|/g, "") }];
  }

  private parseText(from: number, to: number, streaming: boolean): Inline[] {
    if (from >= to) return [];
    this.copiedCharacters += to - from;
    return this.parse(this.content.slice(from, to), streaming);
  }

  private suffix(): Inline[] {
    const source = this.content.slice(this.emittedEnd);
    if (!source) return [];
    this.copiedCharacters += source.length;
    // Behind a code, autolink, or link-destination opener the suffix is parsed after that syntax, so its closer
    // and the text after it already follow the streaming rules they will have once stable.
    const context = suffixContext(this.openers.at(-1));
    const nodes = this.parse(context + source, true);
    const first = nodes[0];
    if (context.startsWith("[") && first && (first.type === "link" && !first.children.length || first.type === "text" && !first.value)) nodes.shift();
    return nodes;
  }
}
