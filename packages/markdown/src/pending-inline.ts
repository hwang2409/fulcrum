import { delimiterRun } from "./delimiters.js";
import type { Inline } from "./index.js";

/** Only this many trailing characters of a growing line may be provisional. */
export const PENDING_INLINE_SUFFIX = 128;

type OpenerKind = "emphasis" | "code" | "bracket" | "angle";
// A bracket moves through `dest`, `title`, `close`, or `ref` after its `]`; that syntax stays hidden.
type LinkState = "text" | "wait" | "text-close" | "dest" | "title" | "close" | "ref";
// `leadingSpace` marks a code span that an earlier line of the paragraph opened, and whether its content starts with a space.
// `node`: the slot node a stable opener's hidden marker waits in (an empty text node), or -1 while the opener is new.
// `below`: the nearest bracket and the nearest emphasis opener of each marker below this opener on the stack, so a
// truncation repairs the stable index in one step. `decided`: a stable `[` whose `]` arrived and decided it as text.
type Below = { bracket: number; "*": number; "_": number; "~": number };
type BlockedCloser = { index: number; length: number; marker: string; visible?: true; node?: number; slot?: number };
type Opener = { index: number; end: number; kind: OpenerKind; marker: string; node: number; slot?: number; closerSlot?: number; closeAt?: number; closeEnd?: number; state: LinkState; below: Below; hideFrom?: number; releaseFrom?: number; quote?: string; leadingSpace?: boolean; codePendingFrom?: number; decided?: true; blockedClosers?: BlockedCloser[] };
type PublicationSlot = { node: Inline; root: number; parent?: number; children: number[]; tombstone: boolean; flattened?: true };
const NONE_BELOW: Below = { bracket: -1, "*": -1, "_": -1, "~": -1 };

const whitespace = (character: string | undefined) => character !== undefined && /\s/.test(character);
const runLength = (source: string, index: number) => {
  let end = index;
  while (source[end] === source[index]) end++;
  return end - index;
};
const special = /[\\`*_~[\]!<]/g;

/** The `below` of an opener pushed onto `openers` now. */
function belowTop(openers: readonly Opener[]): Below {
  const top = openers.at(-1);
  if (!top) return NONE_BELOW;
  if (top.kind === "bracket") return { ...top.below, bracket: openers.length - 1 };
  if (top.kind === "emphasis") return { ...top.below, [top.marker[0]!]: openers.length - 1 };
  return top.below;
}

/**
 * Tracks unresolved inline openers over one growing line. A scan stops early when a closer resolves an
 * opener from an earlier scan, because the text after that opener must be parsed again as one span.
 */
type StableIndex = { emphasis: Map<string, number>; bracket: number; boundary: number };
export type DelimiterWorkStats = { sourceScanned: number; delimiterRecords: number; delimiterVisits: number; floorOperations: number; slotReads: number; slotWrites: number; slotShifts: number };
type MutableDelimiterWorkStats = DelimiterWorkStats;

class OpenerScan {
  resolved?: Opener;
  boundary?: BlockedCloser;
  /** In a dry run: the stack position of a stable `[` that a `]` decided as text. */
  decidedAt = -1;
  /** The lowest stack length this scan truncated to: openers from here up are new and need slots when emitted. */
  low: number;
  private readonly stable?: StableIndex;
  /** Where the closer of a resolved code span starts. */
  closedAt = -1;
  /** Where the last run stopped: just after the closer of `resolved`, when there is one. */
  stoppedAt = -1;

  /** In a dry run: the existing openers it changed or removed, by position, so `restore` can put them back. */
  private readonly saved?: Map<number, Opener>;

  /** A dry run stops only at an existing emphasis opener or a `[` decided as text, and `restore` undoes its changes to the existing openers. */
  /**
   * `reveal` shows a stable opener's marker in its slot when a `[` below it is decided as text. A dry run works on a
   * copy of the stable index, so its truncations repair only its own view.
   */
  constructor(private readonly source: string, private readonly openers: Opener[], private readonly existing: number, dryRun = false, stable?: StableIndex, private readonly reveal?: (opener: Opener) => void, private readonly work?: MutableDelimiterWorkStats, private readonly resolveMetadata?: LinkMetadataResolver) {
    this.low = existing;
    if (dryRun) this.saved = new Map();
    this.stable = dryRun && stable ? { ...stable, emphasis: new Map(stable.emphasis) } : stable;
  }

  restore() {
    for (const [position, opener] of this.saved ?? []) this.openers[position] = opener;
    this.openers.length = this.existing;
  }

  /** Keeps existing openers from `from` on, before they change or leave the stack. */
  private keep(from: number) {
    if (!this.saved) return;
    for (let position = from; position < Math.min(this.existing, this.openers.length); position++) {
      if (this.saved.has(position)) continue;
      this.saved.set(position, this.openers[position]!);
      this.openers[position] = { ...this.openers[position]! };
    }
  }

  run(from: number, to: number) {
    if (this.work) this.work.sourceScanned += to - from;
    let index = from;
    while (index < to && !this.resolved && !this.boundary) index = this.step(index, to);
    this.stoppedAt = index;
    return this.resolved;
  }

  private activeBracket(position: number) {
    let active = position;
    while (active >= 0 && this.openers[active]?.decided) {
      if (this.work) this.work.floorOperations++;
      active = this.openers[active]!.below.bracket;
    }
    while (position >= 0 && position !== active && this.openers[position]?.decided) {
      if (this.work) this.work.floorOperations++;
      const next = this.openers[position]!.below.bracket;
      this.openers[position]!.below.bracket = active;
      position = next;
    }
    return active;
  }

  private resolve(position: number) {
    const opener = this.openers[position]!;
    if (position < this.existing) this.resolved = opener;
    this.truncate(position);
  }

  /** A text-decided bracket stays as a transparent delimiter floor until every opener above it settles. */
  private settleText(position: number) {
    if (this.saved && position < this.existing) {
      this.keep(position);
      if (this.resolveBlocked(position)) return;
      this.resolved = this.openers[position];
      this.decidedAt = position;
      return;
    }
    if (!this.saved && this.work) this.work.floorOperations++;
    this.keep(position);
    const bracket = this.openers[position]!;
    bracket.decided = true;
    bracket.state = "text";
    bracket.releaseFrom = bracket.hideFrom;
    bracket.hideFrom = undefined;
    this.reveal?.(bracket);
    if (this.stable?.bracket === position) this.stable.bracket = this.activeBracket(bracket.below.bracket);
    this.resolveBlocked(position);
  }

  private resolveBlocked(position: number) {
    const bracket = this.openers[position]!;
    for (const candidate of bracket.blockedClosers ?? []) {
      if (this.work) this.work.delimiterVisits++;
      const closer = delimiterRun(this.source, candidate.index, candidate.length);
      for (let at = position - 1; at >= 0; at--) {
        if (this.work) this.work.delimiterVisits++;
        const opener = this.openers[at]!;
        if (opener.kind !== "emphasis") break;
        if (opener.marker[0] !== candidate.marker) continue;
        const opening = delimiterRun(this.source, opener.index, opener.marker.length);
        const oddMatch = (opening.canClose || closer.canOpen) && (opener.marker.length + candidate.length) % 3 === 0
          && (opener.marker.length % 3 !== 0 || candidate.length % 3 !== 0);
        if (oddMatch) continue;
        opener.closeAt = candidate.index;
        opener.closeEnd = candidate.index + candidate.length;
        opener.closerSlot = candidate.slot;
        this.resolve(at);
        return true;
      }
    }
    return false;
  }

  /** The one way openers leave the stack: the stable index steps to the openers below `length`, never rescans. */
  private truncate(length: number) {
    if (length >= this.openers.length) return;
    this.keep(length);
    const first = this.openers[length]!;
    this.openers.length = length;
    this.low = Math.min(this.low, length);
    const stable = this.stable;
    if (!stable || length >= stable.boundary) return;
    for (const [marker, index] of stable.emphasis) if (index >= length) {
      const previous = first.below[marker as "*" | "_" | "~"];
      if (previous < 0) stable.emphasis.delete(marker); else stable.emphasis.set(marker, previous);
    }
    if (stable.bracket >= length) stable.bracket = this.activeBracket(first.below.bracket);
    stable.boundary = length;
  }

  private push(index: number, end: number, kind: OpenerKind) {
    if (!this.saved && this.work && kind === "bracket") this.work.floorOperations++;
    const opener = { index, end, kind, marker: this.source.slice(index, end), node: -1, state: "text" as LinkState, below: belowTop(this.openers) };
    this.openers.push(opener);
    if (!this.saved) this.resolved = opener;
    return end;
  }

  private step(index: number, to: number): number {
    const top = this.openers.at(-1);
    if (top?.kind === "code") return this.code(index, to, top);
    if (top?.kind === "angle") return this.angle(index, to);
    if (top?.kind === "bracket" && top.state !== "text") {
      this.keep(this.openers.length - 1);
      return this.link(index, this.openers.at(-1)!);
    }
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
    if (this.source[index] === "~" && length < 2) return index + length;
    const { canOpen, canClose } = delimiterRun(this.source, index, length);
    if (canClose) {
      const match = this.emphasisOpener(this.source[index]!);
      if (match >= 0) {
        const matched = this.openers[match]!;
        const used = matched.marker.length;
        matched.closeAt = index;
        matched.closeEnd = index + used;
        this.resolve(match);
        return index + used;
      }
      const top = this.openers.at(-1);
      const nearest = top?.kind === "bracket" && !top.decided ? this.openers.length - 1 : top?.below.bracket ?? this.stable?.bracket ?? -1;
      const floor = this.activeBracket(nearest);
      if (floor >= 0) {
        this.keep(floor);
        const boundary = { index, length, marker: this.source[index]! };
        (this.openers[floor]!.blockedClosers ??= []).push(boundary);
        if (!this.saved) this.boundary = boundary;
        if (this.work) this.work.floorOperations++;
      }
    }
    if (canOpen) {
      let cursor = index;
      if (this.source[index] !== "~" && length % 2 === 1) {
        this.push(cursor, cursor + 1, "emphasis");
        cursor++;
      }
      while (cursor + 1 < index + length) {
        this.push(cursor, cursor + 2, "emphasis");
        cursor += 2;
      }
    }
    return index + length;
  }

  /** The nearest opener of `marker` above the nearest unresolved bracket floor. */
  private emphasisOpener(marker: string) {
    const top = this.openers.at(-1);
    const position = top?.kind === "emphasis" && top.marker[0] === marker
      ? this.openers.length - 1
      : top?.below[marker as "*" | "_" | "~"] ?? this.stable?.emphasis.get(marker) ?? -1;
    const nearest = top?.kind === "bracket" && !top.decided ? this.openers.length - 1 : top?.below.bracket ?? this.stable?.bracket ?? -1;
    const floor = this.activeBracket(nearest);
    if (position >= 0 && this.work) this.work.delimiterVisits++;
    return position > floor ? position : -1;
  }

  private closeBracket(index: number) {
    // Only the new openers are walked; below them the stable index names the nearest bracket.
    const top = this.openers.at(-1);
    const nearest = top?.kind === "bracket" && !top.decided ? this.openers.length - 1 : top?.below.bracket ?? this.stable?.bracket ?? -1;
    const position = this.activeBracket(nearest);
    if (position < 0) return index + 1;
    const bracket = this.openers[position]!;
    const next = this.source[index + 1];
    if (next === undefined) {
      bracket.state = "wait";
      bracket.hideFrom = index;
      if (!this.saved) this.boundary = { index, length: 1, marker: "]" };
      return index + 1;
    }
    if (next !== "(" && next !== "[") {
      const metadata = this.resolveMetadata?.({ kind: "reference", image: bracket.marker === "![", form: "shortcut", label: this.source.slice(bracket.end, index) });
      if (metadata) {
        bracket.metadata = metadata;
        this.resolve(position);
        return index + 1;
      }
      if (!this.saved) {
        bracket.state = "text-close";
        this.boundary = { index, length: 1, marker: "]" };
      } else this.settleText(position);
      return index + 1;
    }
    // The opener changes state in place: a dry run keeps its original first.
    this.keep(position);
    this.truncate(position + 1);
    const opener = this.openers[position]!;
    opener.state = next === "(" ? "dest" : "ref";
    opener.hideFrom = index;
    return index + 2;
  }

  private code(from: number, to: number, opener: Opener) {
    const index = this.source.indexOf("`", from);
    if (index < 0 || index >= to) return to;
    const length = runLength(this.source, index);
    if (length === opener.marker.length) {
      this.closedAt = index;
      opener.closeAt = index;
      opener.closeEnd = index + length;
      this.resolve(this.openers.length - 1);
    }
    return index + length;
  }

  private angle(from: number, to: number) {
    const match = /[>\s]/g;
    match.lastIndex = from;
    const index = match.exec(this.source)?.index ?? to;
    if (index >= to) return to;
    const opener = this.openers.at(-1)!;
    opener.closeAt = index;
    if (this.source[index] === ">") opener.closeEnd = index + 1;
    this.resolve(this.openers.length - 1);
    return index + 1;
  }

  private link(index: number, opener: Opener) {
    const character = this.source[index]!;
    if (character === "\\" && opener.state !== "close") return index + 2;
    const top = this.openers.length - 1;
    if (opener.state === "text-close") {
      this.settleText(top);
      return index;
    }
    if (opener.state === "wait") {
      if (character === "(") {
        opener.state = "dest";
        return index + 1;
      }
      if (character === "[") {
        opener.state = "ref";
        return index + 1;
      }
      const metadata = this.resolveMetadata?.({ kind: "reference", image: opener.marker === "![", form: "shortcut", label: this.source.slice(opener.end, opener.hideFrom) });
      if (metadata) {
        opener.metadata = metadata;
        this.resolve(top);
      } else if (!this.saved) {
        opener.state = "text-close";
        if (opener.closerSlot === undefined) this.boundary = { index: opener.hideFrom!, length: 1, marker: "]" };
      } else this.settleText(top);
      return index;
    }
    if (opener.state === "dest") {
      if (character === ")") {
        const metadata = this.resolveMetadata?.({ kind: "inline", image: opener.marker === "![", tail: this.source.slice(opener.hideFrom! + 1, index + 1) });
        if (metadata) {
          opener.metadata = metadata;
          this.resolve(top);
        } else this.settleText(top);
      } else if (whitespace(character)) opener.state = "title";
    } else if (opener.state === "ref") {
      if (character === "]") {
        const label = this.source.slice(opener.hideFrom! + 2, index);
        const metadata = this.resolveMetadata?.({ kind: "reference", image: opener.marker === "![", form: label ? "full" : "collapsed", label: label || this.source.slice(opener.end, opener.hideFrom) });
        if (metadata) {
          opener.metadata = metadata;
          this.resolve(top);
        } else this.settleText(top);
      } else if (character === "[") this.settleText(top);
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

// Inside a code span that may still close, a bracket is code text: it shows raw, and the span is parsed in pieces that
// could not pair it anyway.
export const literalBrackets = (source: string) => source.replace(/[[\]]/g, "\\$&");

const plainText = (nodes: readonly Inline[]): string => nodes.map((node) => "value" in node ? node.value
  : "children" in node ? plainText(node.children) : node.type === "image" ? node.alt : "").join("");

/** `growing`: the text may still grow (the default for streaming); a committed line's suffix passes false. */
export type InlineParser = (source: string, streaming: boolean, growing?: boolean, chargeScan?: (characters: number) => void) => Inline[];
export type LinkMetadataResolver = (request:
  | { kind: "inline"; image: boolean; tail: string }
  | { kind: "reference"; image: boolean; form: "full" | "collapsed" | "shortcut"; label: string }
) => { href?: string; title?: string; consumed: number } | undefined;


/** Cuts at a recent space so no construct, escape, or surrogate pair is split between stable chunks. */
function cutPoint(source: string, target: number) {
  if (target <= 0) return 0;
  const base = Math.max(0, target - 66);
  const window = source.slice(base, target + 2);
  const localTarget = target - base;
  const space = window.slice(0, localTarget).lastIndexOf(" ");
  let cut = space >= 0 ? space + 1 : localTarget;
  while (cut > 0 && unsafeCut(window, cut)) cut--;
  return base + cut;
}

// A suffix that starts with a backtick would merge with the code-span marker it is parsed behind, and one that
// starts with an intraword `*_~` would parse it as an opener.
const unsafeCut = (source: string, index: number) => source[index] === "`" || /[*_~]/.test(source[index]!) && /[\p{L}\p{N}]/u.test(source[index - 1]!) || /[\uDC00-\uDFFF]/.test(source[index]!) || /[\\!]/.test(source[index - 1]!)
  || source[index] === source[index - 1] && /[*_~]/.test(source[index]!) || source[index - 1] === "]" && /[([]/.test(source[index]!);

/**
 * The growing line of the open paragraph: stable nodes for `content.slice(0, emittedEnd)` plus a provisional
 * suffix of at most PENDING_INLINE_SUFFIX characters. Stable text is emitted once; a closer re-parses only
 * the span after the opener it resolves.
 */
export class PendingInline {
  /** Stable nodes followed by the current suffix nodes; updated in place so a frame copies no node list. */
  readonly nodes: Inline[];
  private content = "";
  emittedEnd = 0;
  copiedCharacters = 0;
  private readonly openers: Opener[] = [];
  private readonly stableIndex: StableIndex = { emphasis: new Map(), bracket: -1, boundary: 0 };
  private readonly work: MutableDelimiterWorkStats = { sourceScanned: 0, delimiterRecords: 0, delimiterVisits: 0, floorOperations: 0, slotReads: 0, slotWrites: 0, slotShifts: 0 };
  private indexedOpeners = 0;
  private suffixLength = 0;
  private totalLength = 0;
  private delimiterTail = "";
  private trailingDelimiterStart = -1;
  private trailingCodeStart = -1;
  private tildeOdd = false;
  private readonly publication: PublicationSlot[] = [];
  private readonly publicationByRoot = new Map<number, PublicationSlot>();
  private publicationStart = -1;
  private publicationValid = true;
  private lastPlainRoot = -1;
  private lastPlainOwner?: Opener;

  private shouldHoldTrailingDelimiter() {
    if (this.trailingDelimiterStart < 0) return false;
    const marker = this.content[this.trailingDelimiterStart]!;
    return marker !== "~" || this.content.length - this.trailingDelimiterStart >= 2;
  }

  private recordDelimiterSource(delta: string) {
    let offset = 0;
    for (const character of delta) {
      if (character !== "`") this.trailingCodeStart = -1;
      else if ((offset ? delta[offset - 1] : this.content.at(-1)) !== "`") this.trailingCodeStart = this.content.length + offset;
      const delimiter = character === "*" || character === "_" || character === "~";
      if (!delimiter) this.trailingDelimiterStart = -1;
      else if (character !== this.delimiterTail) this.trailingDelimiterStart = this.content.length + offset;
      if (character === "*" || character === "_") {
        this.work.delimiterRecords++;
      } else if (character === "~") {
        if (this.delimiterTail !== "~") this.tildeOdd = false;
        this.tildeOdd = !this.tildeOdd;
        if (!this.tildeOdd) this.work.delimiterRecords++;
      } else this.tildeOdd = false;
      this.delimiterTail = character;
      offset += character.length;
    }
  }
  private readonly chunks: string[] = [];
  private readonly prefixLength: number;

  get length() { return this.totalLength; }
  get delimiterStats(): DelimiterWorkStats {
    // Live slots carry one owed retirement read; include that potential so unfinished floors cannot hide future work.
    return { ...this.work, slotReads: this.work.slotReads + this.publication.length };
  }

  constructor(
    private readonly parseInline: InlineParser,
    private readonly openCode?: { marker: string; leadingSpace: boolean },
    prefix: readonly Inline[] = [],
    private readonly resolveMetadata?: LinkMetadataResolver,
  ) {
    this.nodes = prefix.slice();
    this.prefixLength = this.nodes.length;
    this.reset();
  }

  private reset() {
    this.content = "";
    this.nodes.length = this.prefixLength;
    this.openers.length = 0;
    this.indexedOpeners = 0;
    this.stableIndex.emphasis.clear();
    this.stableIndex.bracket = -1;
    this.stableIndex.boundary = 0;
    this.emittedEnd = 0;
    this.suffixLength = 0;
    this.totalLength = 0;
    this.delimiterTail = "";
    this.trailingDelimiterStart = -1;
    this.trailingCodeStart = -1;
    this.tildeOdd = false;
    this.chunks.length = 0;
    this.publication.length = 0;
    this.publicationByRoot.clear();
    this.publicationStart = -1;
    this.publicationValid = true;
    this.lastPlainRoot = -1;
    this.lastPlainOwner = undefined;
    if (this.openCode) this.openers.push({ index: 0, end: 0, kind: "code", node: this.prefixLength, state: "text", below: NONE_BELOW, ...this.openCode });
  }

  /**
   * Takes the line so far, which extends the previous content, and returns the nodes of its suffix, which
   * later text may still restyle. Settled source is discarded when no unresolved opener still needs it.
   */
  extend(content: string): Inline[] {
    // Invariant: `content` extends the previous content (the caller resets at each line end). A shorter line breaks
    // it, so the stable nodes start over; a full prefix check would cost O(line) per delta.
    if (content.length < this.totalLength) this.reset();
    return this.append(content.slice(this.totalLength));
  }

  append(delta: string): Inline[] {
    this.recordDelimiterSource(delta);
    this.content += delta;
    this.totalLength += delta.length;
    const lastChunk = this.chunks.length - 1;
    if (lastChunk >= 0 && this.chunks[lastChunk]!.length + delta.length <= 4_096) this.chunks[lastChunk] += delta;
    else if (delta) this.chunks.push(delta);
    this.nodes.length -= this.suffixLength;
    let cut = this.content.length;
    if (this.shouldHoldTrailingDelimiter()) cut = Math.min(cut, this.trailingDelimiterStart);
    if (this.trailingCodeStart >= 0) cut = Math.min(cut, this.trailingCodeStart);
    const trailingBackslashes = /\\+$/.exec(this.content)?.[0].length ?? 0;
    if (trailingBackslashes % 2) cut--;
    const entity = /&(?:#(?:x[0-9a-f]{0,6}|[0-9]{0,7})?|[a-z][a-z0-9]{0,31})?$/i.exec(this.content);
    if (entity) cut = Math.min(cut, entity.index);
    while (cut > this.emittedEnd) {
      const previous = this.emittedEnd;
      this.emitStable(cut);
      if (this.emittedEnd <= previous) break;
    }
    this.decideStable(false);
    if (!this.openers.length) this.settlePublicationTail();
    const suffix = this.suffix();
    // Blanks at the end of the growing line may still sit before a cell pipe.
    const last = suffix.at(-1);
    if (last?.type === "text") last.value = last.value.replace(/[ \t]+$/, "");
    for (const node of suffix) this.nodes.push(node);
    this.suffixLength = suffix.length;
    if (!this.openers.length && this.emittedEnd > 2) {
      const discarded = this.emittedEnd - 2;
      this.content = this.content.slice(discarded);
      this.emittedEnd = 2;
      if (this.trailingDelimiterStart >= 0) this.trailingDelimiterStart -= discarded;
      if (this.trailingCodeStart >= 0) this.trailingCodeStart -= discarded;
    }
    return suffix;
  }

  /** Final streaming nodes for the finished line, or undefined when `line` does not extend this line. */
  commit(line: string): Inline[] | undefined {
    if (line.length < this.totalLength || this.openers[0]?.leadingSpace !== undefined) return undefined;
    // The line end decides an open `<`, a last `]`, or a trailing entity as text, which the provisional parse still holds
    // back: parse the line again.
    const angle = line.lastIndexOf("<");
    if (this.openers.at(-1)?.kind === "angle" || angle >= 0 && !/[\s>]/.test(line.slice(angle + 1)) || /(?:\]|&[#A-Za-z0-9]*)$/.test(line.slice(-40))) return undefined;
    let offset = 0;
    for (const chunk of this.chunks) {
      if (!line.startsWith(chunk, offset)) return undefined;
      offset += chunk.length;
    }
    const delta = line.slice(this.totalLength);
    this.content += delta;
    this.totalLength = line.length;
    this.nodes.length -= this.suffixLength;
    this.suffixLength = 0;
    // The line end decides as any other character does: a stable `[` whose `]` arrived with it is text now.
    this.decideStable(true);
    // Reuse the same provisional suffix parser as render; finish() performs the authoritative one-shot parse.
    // An ended line shows its unmatched openers: the suffix parses as ended text, and an opener the stable part holds
    // open (an emphasis or code opener, or a `[` still undecided) sends the line to a full parse, once. The instance is
    // dropped after its commit, so the changes above need no undo.
    if (this.openers.some((opener) => opener.kind === "emphasis" || opener.kind === "code" || opener.kind === "bracket" && !opener.decided)) return undefined;
    const tail = this.suffix(false);
    for (const node of tail) this.nodes.push(node);
    return this.nodes;
  }

  /**
   * Decides every stable `[` whose deciding character arrived: its marker shows in its slot at once (no context
   * character stands in for it), and the stable text up to a safe cut past it is emitted. `ended`: the line ended, so
   * its end decides too.
   */
  private decideStable(ended: boolean) {
    for (;;) {
      const { cut, bracket } = this.pastStableCloser(ended);
      if (bracket !== undefined) this.reveal(this.openers[bracket]!);
      if (cut <= this.emittedEnd) return;
      const previous = this.emittedEnd;
      this.emitStable(cut);
      if (this.emittedEnd <= previous) return;
    }
  }

  private readonly reveal = (opener: Opener) => {
    this.work.slotReads++;
    const slot = opener.node >= 0 ? this.nodes[opener.node] : undefined;
    if (slot?.type === "text") {
      slot.value = opener.marker;
      const publication = this.publicationByRoot.get(opener.node);
      if (opener.kind === "bracket" && opener.closerSlot !== undefined) {
        const closer = this.publication[opener.closerSlot];
        const node = closer && this.nodes[closer.root];
        if (node?.type === "text") node.value = "]";
      }
      if (publication && !publication.flattened) {
        publication.flattened = true;
        const parent = publication.parent === undefined ? undefined : this.publication[publication.parent];
        const at = parent?.children.indexOf(publication.root) ?? -1;
        if (parent && at >= 0) {
          parent.children.splice(at, 1, publication.root, ...publication.children);
          publication.children.length = 0;
          this.work.slotWrites += parent.children.length - at;
        }
      }
      this.work.slotWrites++;
    }
  };

  private emitStable(cut: number) {
    let from = this.emittedEnd;
    for (;;) {
      const existing = this.openers.length;
      // Truncations repaired the index in place (OpenerScan.truncate): only openers pushed since need indexing.
      this.indexedOpeners = Math.min(this.indexedOpeners, existing);
      this.stableIndex.boundary = existing;
      for (; this.indexedOpeners < existing; this.indexedOpeners++) {
        const opener = this.openers[this.indexedOpeners]!;
        if (opener.kind === "emphasis") this.stableIndex.emphasis.set(opener.marker[0]!, this.indexedOpeners);
        if (opener.kind === "bracket" && !opener.decided) this.stableIndex.bracket = this.indexedOpeners;
      }
      const scan = new OpenerScan(this.content, this.openers, existing, false, this.stableIndex, this.reveal, this.work, this.resolveMetadata);
      let resolved = scan.run(from, cut);
      // The suffix parse already showed an autolink `<` that meets a space, so the cut moves past that end and
      // resolves it now instead of hiding the `<` until a later cut.
      for (let next = this.pastAngle(cut); !resolved && !scan.boundary && next > cut; next = this.pastAngle(cut)) {
        resolved = scan.run(cut, next);
        cut = next;
      }
      if (scan.boundary) {
        cut = scan.stoppedAt;
        this.indexOpeners(scan.low);
        this.emitBoundary(from, cut, scan.low, scan.boundary);
        break;
      }
      if (!resolved) {
        this.indexOpeners(scan.low);
        this.emitSegments(from, cut, scan.low);
        break;
      }
      this.indexedOpeners = Math.min(this.indexedOpeners, scan.low);
      if (resolved.closeEnd === undefined && resolved.leadingSpace === undefined && this.openers.includes(resolved)) {
        cut = scan.stoppedAt;
        this.indexOpeners(scan.low);
        this.emitSegments(from, cut, scan.low);
        break;
      }
      if (resolved.leadingSpace !== undefined) {
        // A span from an earlier line has no opener here to parse again from; its content is code up to the closer.
        const end = scan.closedAt - (this.stripsEdgeSpace(resolved, scan.closedAt) ? 1 : 0);
        for (const node of this.codeText(from, end, true)) this.nodes.push(node);
        from = scan.closedAt + resolved.marker.length;
        continue;
      }
      if (resolved.kind === "bracket" && resolved.decided) {
        const decidedFrom = resolved.releaseFrom === undefined ? from : Math.max(from, resolved.releaseFrom + 1);
        this.emitSegments(decidedFrom, scan.stoppedAt, scan.low);
        from = scan.stoppedAt;
        continue;
      }
      if (this.settleOwnerSlot(resolved, from)) {
        from = resolved.closeEnd ?? scan.stoppedAt;
        continue;
      }
      const discarded = this.nodes.length - resolved.node;
      this.work.slotReads += discarded;
      this.work.slotWrites += discarded;
      this.nodes.length = resolved.node;
      this.lastPlainRoot = -1;
      this.lastPlainOwner = undefined;
      this.publicationValid = false;
      this.discardPublicationFrom(resolved.node);
      from = resolved.index;
    }
    this.emittedEnd = Math.max(cut, from);
  }

  private emitBoundary(from: number, to: number, low: number, boundary: BlockedCloser) {
    if (from < boundary.index) this.emitSegments(from, boundary.index, low);
    let ownerIndex = this.openers.length - 1;
    while (this.openers[ownerIndex]?.decided) ownerIndex--;
    const owner = this.openers[ownerIndex];
    boundary.node = this.nodes.length;
    boundary.slot = this.publish({ type: "text", value: boundary.visible ? boundary.marker : "" }, owner, true);
    if (boundary.marker === "]" && owner?.kind === "bracket") owner.closerSlot = boundary.slot;
    this.emitText(boundary.index + boundary.length, to, owner);
  }

  private indexOpeners(low: number) {
    this.indexedOpeners = Math.min(this.indexedOpeners, low);
    for (; this.indexedOpeners < this.openers.length; this.indexedOpeners++) {
      const opener = this.openers[this.indexedOpeners]!;
      if (opener.kind === "emphasis") this.stableIndex.emphasis.set(opener.marker[0]!, this.indexedOpeners);
      if (opener.kind === "bracket" && !opener.decided) this.stableIndex.bracket = this.indexedOpeners;
    }
    this.stableIndex.boundary = this.openers.length;
  }

  /** Emits `from..to` behind the openers from `low` up (all new): each opener's hidden marker gets an empty slot node. */
  private emitSegments(from: number, to: number, low: number) {
    let start = from;
    let ownerIndex = low < this.openers.length && this.openers[low]!.node < 0 ? low - 1 : this.openers.length - 1;
    while (this.openers[ownerIndex]?.decided) ownerIndex--;
    let owner = this.openers[ownerIndex];
    for (let position = low; position < this.openers.length; position++) {
      const opener = this.openers[position]!;
      this.emitText(start, opener.index, owner);
      opener.node = this.nodes.length;
      opener.slot = this.publish({ type: "text", value: opener.decided ? opener.marker : opener.marker === "![" ? "!" : "" }, owner, true);
      start = opener.end;
      owner = opener;
    }
    this.emitText(start, to, owner);
  }

  private emitText(from: number, to: number, owner: Opener | undefined) {
    const hidesInlineDestination = owner?.kind === "bracket" && (owner.state === "dest" || owner.state === "title" || owner.state === "close");
    let end = hidesInlineDestination && owner.hideFrom !== undefined ? Math.min(to, owner.hideFrom) : to;
    let nodes: Inline[];
    if (owner?.kind === "code") {
      from = Math.min(from, owner.codePendingFrom ?? from);
      const closer = this.codeCloser(owner.marker, to);
      if (from === owner.end && this.content[from] === " ") from++;
      if (closer < 0) {
        while (end > from && this.content[end - 1] === " ") end--;
        owner.codePendingFrom = end;
      } else owner.codePendingFrom = undefined;
      nodes = this.codeText(from, end, closer >= 0);
    } else {
      const source = this.content.slice(from, end);
      nodes = owner?.kind === "angle" || !/[\\&\n]/.test(source) ? this.rawText(from, end) : this.parseText(from, end, false);
    }
    for (const node of nodes) this.publish(node, owner);
  }

  private publish(node: Inline, owner: Opener | undefined, structural = false) {
    if (!structural && node.type === "text" && this.lastPlainRoot === this.nodes.length - 1 && this.lastPlainOwner === owner) {
      const previous = this.nodes[this.lastPlainRoot];
      if (previous?.type === "text" && previous.value.length < 256) {
        previous.value += node.value;
        return -1;
      }
    }
    const root = this.nodes.length;
    this.nodes.push(node);
    this.lastPlainRoot = !structural && node.type === "text" ? root : -1;
    this.lastPlainOwner = owner;
    if (owner?.slot !== undefined) {
      this.publication[owner.slot]!.children.push(root);
      this.work.slotWrites++;
    }
    if (!structural) return -1;
    if (this.publicationStart < 0) this.publicationStart = root;
    const slotId = this.publication.length;
    const slot = { node, root, parent: owner?.slot, children: [], tombstone: false };
    this.publication.push(slot);
    this.publicationByRoot.set(root, slot);
    this.work.slotWrites++;
    return slotId;
  }

  /** Settles one owner without rebuilding source or moving descendant slots. */
  private settleOwnerSlot(opener: Opener, from: number) {
    if (!this.publicationValid || opener.slot === undefined) return false;
    if (opener.kind === "angle" && opener.closeEnd === undefined) {
      if (opener.closeAt === undefined) return false;
      this.emitText(from, opener.closeAt + 1, opener);
      this.reveal(opener);
      return true;
    }
    if (opener.closeAt === undefined || opener.closeEnd === undefined) return false;
    this.emitText(from, opener.closeAt, opener);
    if (opener.closerSlot === undefined) opener.closerSlot = this.publish({ type: "text", value: "" }, opener, true);
    const slot = this.publication[opener.slot];
    const closer = this.publication[opener.closerSlot];
    if (!slot || slot.tombstone || !closer) return false;
    const closeAt = slot.children.indexOf(closer.root);
    if (closeAt < 0) return false;
    const consumed = slot.children.slice(0, closeAt);
    const after = slot.children.slice(closeAt + 1);
    slot.children.length = 0;
    const parent = slot.parent === undefined ? undefined : this.publication[slot.parent];
    const parentAt = parent?.children.indexOf(slot.root) ?? -1;
    if (parent && parentAt >= 0 && after.length) parent.children.splice(parentAt + 1, 0, ...after);
    this.work.slotReads += slot.children.length + 2;
    this.work.slotWrites += after.length + 2;
    const children: Inline[] = [];
    for (const childRoot of consumed) {
      const child = this.nodes[childRoot];
      this.work.slotReads++;
      if (child?.type !== "text" || child.value) children.push(child!);
      this.nodes[childRoot] = { type: "text", value: "" };
      const structural = this.publicationByRoot.get(childRoot);
      if (structural) structural.tombstone = true;
      this.work.slotWrites++;
    }
    this.nodes[closer.root] = { type: "text", value: "" };
    closer.tombstone = true;
    this.work.slotWrites++;
    let wrapper: Inline;
    if (opener.kind === "emphasis") {
      const type = opener.marker[0] === "~" ? "strike" : opener.marker.length === 2 ? "strong" : "emphasis";
      wrapper = { type, children };
    } else if (opener.kind === "code") {
      const code = this.codeNode(this.content.slice(opener.end, opener.closeAt), true)[0];
      if (!code) return false;
      wrapper = code;
    } else if (opener.kind === "bracket" && opener.state === "link" && opener.metadata) {
      wrapper = opener.image
        ? { type: "image", src: opener.metadata.href, title: opener.metadata.title, alt: plainText(children) }
        : { type: "link", href: opener.metadata.href, title: opener.metadata.title, children };
    } else if (opener.kind === "angle") {
      const target = this.content.slice(opener.end, opener.closeAt);
      wrapper = { type: "link", href: target.includes("@") && !target.includes(":") ? `mailto:${target}` : target, children };
    } else return false;
    slot.node = wrapper;
    this.nodes[slot.root] = wrapper;
    this.work.slotWrites++;
    return true;
  }

  private discardPublicationFrom(root: number) {
    while (this.publication.at(-1)?.root !== undefined && this.publication.at(-1)!.root >= root) {
      const slot = this.publication.pop()!;
      this.publicationByRoot.delete(slot.root);
    }
    if (!this.publication.length) this.publicationStart = -1;
  }

  /** Compacts only the active tail after its last owner settles; the settled prefix is never revisited. */
  private settlePublicationTail() {
    if (this.publicationStart < 0) return;
    const settled: Inline[] = [];
    for (let index = this.publicationStart; index < this.nodes.length; index++) {
      const node = this.nodes[index]!;
      this.work.slotReads++;
      if (node.type !== "text" || node.value) settled.push(node);
    }
    this.nodes.length = this.publicationStart;
    for (const node of settled) {
      this.nodes.push(node);
      this.work.slotWrites++;
    }
    this.publication.length = 0;
    this.publicationByRoot.clear();
    this.publicationStart = -1;
    this.publicationValid = true;
  }

  private rawText(from: number, to: number): Inline[] {
    if (from >= to) return [];
    this.copiedCharacters += to - from;
    return [{ type: "text", value: this.content.slice(from, to) }];
  }

  /**
   * Content behind a code opener as a code span: raw once its closer is known, and until then only the text it
   * renders as markdown without brackets, which is what shows whether or not the span closes.
   */
  private codeText(from: number, to: number, closed: boolean): Inline[] {
    if (from >= to) return [];
    this.copiedCharacters += to - from;
    return this.codeNode(this.content.slice(from, to), closed);
  }

  private codeNode(source: string, closed: boolean): Inline[] {
    const value = closed ? source : source;
    return value ? [{ type: "code", value }] : [];
  }

  private parse(source: string, streaming: boolean, growing = streaming): Inline[] {
    this.work.sourceScanned += source.length;
    return this.parseInline(source, streaming, growing, (characters) => { this.work.sourceScanned += characters; });
  }

  private parseText(from: number, to: number, streaming: boolean): Inline[] {
    if (from >= to) return [];
    this.copiedCharacters += to - from;
    return this.parse(this.content.slice(from, to), streaming);
  }

  private suffix(growing = true): Inline[] {
    if (this.openers.some((opener) => !opener.decided)) return [];
    let visibleEnd = growing && this.shouldHoldTrailingDelimiter() ? this.trailingDelimiterStart : this.content.length;
    if (growing && this.trailingCodeStart >= 0) visibleEnd = Math.min(visibleEnd, this.trailingCodeStart);
    const source = this.content.slice(this.emittedEnd, visibleEnd);
    if (!source) return [];
    this.copiedCharacters += source.length;
    // Behind a link opener the suffix is parsed after that syntax, so its closer and the text after it already
    // follow the streaming rules they will have once stable.
    const top = this.openers.at(-1);
    if (top?.kind === "code" || top?.kind === "angle") return this.rawSuffix(source, top);
    return this.parse(source, true, growing);
  }

  /**
   * The first safe cut past the closer of a stable emphasis opener, or past the character that decides a stable `[...]`
   * is text, or -1. The suffix parses without the stable opener, so an emphasis closer would show as a raw marker over a
   * span that already showed styled, and a bracket decided as text would show its `[` at the suffix start, not where it is.
   */
  private pastStableCloser(ended: boolean): { cut: number; bracket?: number } {
    if (!this.openers.length) return { cut: -1 };
    let to = this.content.length;
    if (!ended && this.shouldHoldTrailingDelimiter()) to = this.trailingDelimiterStart;
    if (!ended && this.trailingCodeStart >= 0) to = Math.min(to, this.trailingCodeStart);
    if (!ended && (this.openers.at(-1)?.state === "wait" || this.openers.at(-1)?.state === "text-close")) to = Math.max(to, Math.min(this.content.length, this.emittedEnd + 1));
    if (to <= this.emittedEnd) return { cut: -1 };
    const scan = new OpenerScan(this.content, this.openers, this.openers.length, true, this.stableIndex, undefined, this.work, this.resolveMetadata);
    const resolved = scan.run(this.emittedEnd, to);
    scan.restore();
    if (!resolved) return { cut: -1 };
    const decided = scan.decidedAt >= 0 ? scan.decidedAt : undefined;
    // A closer run at the end of a growing line may still grow, and a last `]` waits for the character after it; an
    // ended line's end decides both and is a cut.
    if (scan.stoppedAt >= this.content.length) return ended ? { cut: this.content.length, bracket: decided } : { cut: -1 };
    // The character after `]` decides a text bracket even when that character starts syntax which must stay provisional.
    if (decided !== undefined) return { cut: scan.stoppedAt, bracket: decided };
    let cut = scan.stoppedAt;
    while (unsafeCut(this.content, cut)) if (++cut >= this.content.length) return { cut: ended ? this.content.length : -1, bracket: decided };
    return { cut, bracket: decided };
  }

  /** The first cut past the space, or past the space after the `>`, that ends the innermost open `<`; -1 while it is open. */
  private pastAngle(cut: number) {
    if (this.openers.at(-1)?.kind !== "angle") return -1;
    const terminator = /[>\s]/g;
    terminator.lastIndex = cut;
    const end = terminator.exec(this.content)?.index ?? -1;
    if (end < 0) return -1;
    // A space decides the `<` as text at once, so the cut moves just past it and the `<` shows with it.
    if (this.content[end] !== ">" && !unsafeCut(this.content, end + 1)) return end + 1;
    const space = this.content.indexOf(" ", end + 1);
    return space < 0 ? -1 : space + 1;
  }

  /** The index of the backtick run `marker` that closes a code span at or after `from`, or -1. */
  private codeCloser(marker: string, from: number) {
    const closer = new RegExp(`(?<!\`)${marker}(?!\`)`, "g");
    closer.lastIndex = from;
    return closer.exec(this.content)?.index ?? -1;
  }

  /**
   * Whether a code span strips one space at each edge, which it does when both edges are spaces. While the closer
   * is unknown the edge spaces hide, because a space the user has seen must never disappear.
   */
  private stripsEdgeSpace(opener: Opener, closer: number) {
    if (closer < 0) return true;
    if (opener.leadingSpace !== undefined) return opener.leadingSpace && this.content[closer - 1] === " ";
    let text = opener.end;
    while (text < closer && this.content[text] === " ") text++;
    return text > opener.end && text < closer && this.content[closer - 1] === " ";
  }

  /** Behind a code or autolink opener: the body stays raw, as it does when stable, its closer hides, and the rest parses alone. */
  private rawSuffix(source: string, top: Opener): Inline[] {
    let end: number;
    let closer = top.marker.length;
    if (top.kind === "angle") {
      end = source.search(/[>\s]/);
      if (source[end] !== ">") closer = 0;
    } else {
      const closer = this.codeCloser(top.marker, this.emittedEnd);
      end = closer < 0 ? -1 : closer - this.emittedEnd;
    }
    let from = this.emittedEnd;
    let to = end < 0 ? this.content.length : from + end;
    if (top.kind === "code" && this.stripsEdgeSpace(top, end < 0 ? -1 : to)) {
      if (this.content[to - 1] === " ") to--;
      if (top.leadingSpace === undefined && from === top.end && this.content[from] === " ") from++;
    }
    const body = source.slice(from - this.emittedEnd, to - this.emittedEnd);
    const nodes: Inline[] = top.kind === "code" ? this.codeNode(body, end >= 0) : body ? [{ type: "text", value: body }] : [];
    if (end >= 0) for (const node of this.parse(source.slice(end + closer), true)) nodes.push(node);
    return nodes;
  }
}

export const unmatchedCodeSpan = (source: string) => {
  let opener: { index: number; length: number } | undefined;
  for (const run of source.matchAll(/`+/g)) {
    if (run.index === undefined) continue;
    let escapes = 0;
    for (let index = run.index - 1; index >= 0 && source[index] === "\\"; index--) escapes++;
    if (escapes % 2) continue;
    if (!opener) opener = { index: run.index, length: run[0].length };
    else if (opener.length === run[0].length) opener = undefined;
  }
  return opener;
};

const escaped = (source: string, index: number) => {
  let escapes = 0;
  for (let at = index - 1; at >= 0 && source[at] === "\\"; at--) escapes++;
  return escapes % 2 === 1;
};

// Unescaped `[` and `]` outside code spans, including a span that may still close: code binds tighter than brackets.
function bracketMarks(source: string) {
  const marks: number[] = [];
  const code = closedCodeRanges(source);
  const end = unmatchedCodeSpan(source)?.index ?? source.length;
  let range = 0;
  for (let index = 0; index < end; index++) {
    while (range < code.length && code[range]![1] <= index) range++;
    if (range < code.length && index >= code[range]![0]) index = code[range]![1] - 1;
    else if (source[index] === "\\") index++;
    else if (source[index] === "[" || source[index] === "]") marks.push(index);
  }
  return marks;
}

// The one bracket wait (the text inside `[...]` always shows): an open `[` hides, and a closed `[...]` hides its two
// brackets only until the character after `]` decides it. Anything but `(` or `[` makes them text at once; after `(` or
// `[` they, and the destination or label, hide until the link closes or the line ends. A later `[x]: url` definition
// never makes a bracket wait (if it turns earlier text into a link, that rare change is accepted). Only the growing
// line waits: CommonMark lets a link span lines, but a line end shows what it holds (a link that closes on a later line
// takes its brackets back then, an accepted change).
function projectOpenLinks(source: string, growing: boolean) {
  if (!growing) return source;
  const lineStart = source.lastIndexOf("\n") + 1;
  const marks = bracketMarks(source).filter((mark) => mark >= lineStart);
  const hidden = new Set<number>();
  const open: number[] = [];
  let cut = source.length;
  for (const mark of marks) {
    if (mark >= cut) break;
    if (source[mark] === "[") { open.push(mark); continue; }
    const opener = open.pop();
    if (opener === undefined) continue;
    const after = source.slice(mark + 1);
    // A line end decides as any other character does: neither `(` nor `[` may follow on the next line.
    const pending = !after ? growing : after[0] === "(" && !closesDestination(after) || after[0] === "[" && !after.includes("]", 1);
    if (!pending) continue;
    hidden.add(opener).add(mark);
    if (after) cut = mark + 1;
  }
  for (const opener of open) hidden.add(opener);
  if (!hidden.size && cut === source.length) return source;
  let result = "";
  for (let index = 0; index < cut; index++) if (!hidden.has(index)) result += source[index];
  return result;
}

// Whether `(destination…` reaches its balancing `)`.
function closesDestination(destination: string) {
  let depth = 0;
  for (const character of destination) {
    if (character === "(") depth++;
    else if (character === ")" && --depth === 0) return true;
  }
  return false;
}

function closedCodeRanges(source: string) {
  const ranges: Array<[number, number]> = [];
  let opener: { index: number; length: number } | undefined;
  for (const run of source.matchAll(/`+/g)) {
    if (run.index === undefined) continue;
    if (!opener) opener = { index: run.index, length: run[0].length };
    else if (opener.length === run[0].length) {
      ranges.push([opener.index, run.index + run[0].length]);
      opener = undefined;
    }
  }
  return ranges;
}

function lastMarkerIndex(stack: Array<{ marker: string }>, marker: string) {
  for (let index = stack.length - 1; index >= 0; index--) if (stack[index]!.marker === marker) return index;
  return -1;
}

/**
 * Hides the growing line's unmatched emphasis openers until their closer arrives or the line ends. An ended line shows
 * its openers: a closer on a later line turns them into emphasis then (a flash the sent-text rule accepts), but sent
 * text never waits past its line. A lone `~` is text: strikethrough needs `~~`, unless the run ends the line and can grow.
 */
function projectOpenEmphasis(source: string, growing: boolean) {
  if (!growing) return source;
  const lineStart = source.lastIndexOf("\n") + 1;
  const codeRanges = closedCodeRanges(source);
  const stack: Array<{ marker: string; index: number }> = [];
  // Runs and code ranges both ascend, so one cursor keeps the scan linear.
  let range = 0;
  for (const run of source.matchAll(/(?:\*+|_+|~+)/g)) {
    if (run.index === undefined) continue;
    while (range < codeRanges.length && codeRanges[range]![1] <= run.index) range++;
    if (range < codeRanges.length && run.index >= codeRanges[range]![0]) continue;
    const marker = run[0];
    if (source[run.index - 1] === "\\" || marker === "~" && run.index + 1 < source.length) continue;
    const { canOpen, canClose } = delimiterRun(source, run.index, marker.length);
    const match = canClose ? lastMarkerIndex(stack, marker) : -1;
    if (match >= 0) stack.splice(match, 1);
    // A run at the end can still grow into another run, so it stays hidden.
    else if (canOpen || run.index + marker.length === source.length) stack.push({ marker, index: run.index });
  }
  if (!stack.some(({ index }) => index >= lineStart)) return source;
  const pieces: string[] = [];
  let offset = 0;
  for (const { marker, index } of stack.sort((a, b) => a.index - b.index)) {
    if (index < lineStart) continue;
    pieces.push(source.slice(offset, index));
    offset = index + marker.length;
  }
  pieces.push(source.slice(offset));
  return pieces.join("");
}


export const provisionalDelimiterSource = (source: string, growing: boolean) =>
  projectOpenEmphasis(projectOpenLinks(source, growing), growing);
