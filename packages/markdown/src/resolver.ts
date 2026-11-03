export type ContainerKind = "document" | "quote" | "list" | "item";

export type ContainerFrame =
  | { kind: "document" }
  | { kind: "quote" }
  | { kind: "list"; ordered: boolean; marker: string }
  | { kind: "item"; contentIndent: number };

export type OpenedContainer = Exclude<ContainerFrame, { kind: "document" }>;

export type ResolvedLeaf = {
  kind: "paragraph" | "fence-open" | "fence-line" | "fence-close" | "indented-code" | "atx-heading" | "setext-heading" | "thematic-break" | "table-delimiter" | "table-row" | "html-open" | "html-line" | "html-close" | "reference-definition" | "reference-title";
  content: string;
  path: readonly ContainerFrame[];
  marker?: string;
  language?: string;
  level?: number;
};

export type LineResolution = {
  continued: boolean;
  lazy: boolean;
  closedToDepth: number;
  opened: readonly OpenedContainer[];
  leaf?: ResolvedLeaf;
};

export type PendingLineScan = {
  indentColumns: number;
  marker: "none" | "possible" | "quote" | "bullet" | "ordered";
};

export type PendingLine = {
  readonly content: string;
  readonly length: number;
  readonly scan: Readonly<PendingLineScan>;
};

export type PendingClassification = {
  readonly content: string;
  readonly kind: "empty" | "fence" | "paragraph";
  /** Where `content` starts in the classified line; only set for growing paragraph lines. */
  readonly offset: number;
};

const EMPTY: PendingClassification = { content: "", kind: "empty", offset: 0 };
const FENCE: PendingClassification = { content: "", kind: "fence", offset: 0 };

type MutablePendingLine = {
  content: string;
  length: number;
  scan: PendingLineScan;
  atLineStart: boolean;
  orderedDigits: number;
};

type Cursor = { line: string; offset: number; column: number };

export type ReferenceDefinition = { href: string; title: string };

type Marker = {
  ordered: boolean;
  marker: string;
  contentIndent: number;
};

const freshPending = (): MutablePendingLine => ({
  content: "",
  length: 0,
  scan: { indentColumns: 0, marker: "possible" },
  atLineStart: true,
  orderedDigits: 0,
});

function advancePending(scan: MutablePendingLine, delta: string) {
  scan.content += delta;
  scan.length += delta.length;
  for (const character of delta) {
    if (!scan.atLineStart) continue;
    if (character === " " && scan.scan.indentColumns < 4) {
      scan.scan.indentColumns++;
      continue;
    }
    if (character === ">") scan.scan.marker = "quote";
    else if (character === "-" || character === "+" || character === "*") scan.scan.marker = "bullet";
    else if (/\d/.test(character) && scan.orderedDigits < 9) {
      scan.orderedDigits++;
      scan.scan.marker = "possible";
      continue;
    } else if ((character === "." || character === ")") && scan.orderedDigits) scan.scan.marker = "ordered";
    else scan.scan.marker = "none";
    scan.atLineStart = false;
  }
}

function consumeIndent(cursor: Cursor, maximum: number) {
  let columns = 0;
  while (cursor.offset < cursor.line.length && columns < maximum) {
    const character = cursor.line[cursor.offset];
    if (character === " ") columns++;
    else if (character === "\t") columns += 4 - columns % 4;
    else break;
    cursor.offset++;
  }
  cursor.column += columns;
  return columns;
}

function consumeQuote(cursor: Cursor) {
  const start = { ...cursor };
  consumeIndent(cursor, 3);
  if (cursor.line[cursor.offset] !== ">") {
    Object.assign(cursor, start);
    return false;
  }
  cursor.offset++;
  cursor.column++;
  if (cursor.line[cursor.offset] === " " || cursor.line[cursor.offset] === "\t") {
    cursor.offset++;
    cursor.column++;
  }
  return true;
}

function listMarker(cursor: Cursor): Marker | undefined {
  const start = { ...cursor };
  consumeIndent(cursor, 3);
  const rest = cursor.line.slice(cursor.offset);
  const match = /^(?:([-+*])|(\d{1,9})([.)]))([ \t]+)/.exec(rest);
  if (!match) {
    Object.assign(cursor, start);
    return undefined;
  }
  const marker = match[1] ?? `${match[2]}${match[3]}`;
  const markerWidth = marker.length;
  const whitespace = match[4]!;
  const padding = whitespace.includes("\t") || whitespace.length > 4 ? 1 : whitespace.length;
  cursor.offset += markerWidth + padding;
  cursor.column += markerWidth + padding;
  return { ordered: !match[1], marker, contentIndent: markerWidth + padding };
}

function consumeItemIndent(cursor: Cursor, width: number) {
  const start = { ...cursor };
  const consumed = consumeIndent(cursor, width);
  if (consumed >= width) return true;
  Object.assign(cursor, start);
  return false;
}

const isBlank = (line: string, offset = 0) => /^[ \t]*$/.test(line.slice(offset));
const isTableDelimiter = (line: string) => /^ {0,3}\|[ \t]*:?-+:?[ \t]*\|[ \t]*$/.test(line)
  || /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/.test(line);
const isThematicBreak = (line: string) => /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(line);
const normalizeReference = (label: string) => label.trim().replace(/\s+/g, " ").toUpperCase();

function stripPendingContainers(line: string) {
  for (;;) {
    const marker = /^[ \t]*(?:> ?|(?:[-+*]|\d{1,9}[.)])[ \t]+)/.exec(line)?.[0];
    if (!marker) return line;
    line = line.slice(marker.length);
  }
}

function classifyLeaf(line: string, growing: boolean): PendingClassification {
  let content = stripPendingContainers(line);
  if (!content.trim()) return EMPTY;
  const heading = /^#{1,6}[ \t]+/.exec(content);
  if (heading) content = content.slice(heading[0].length);
  const task = /^\[([ xX])\][ \t]+/.exec(content);
  if (/^[ \t]*\[[^\]\n]+\]:/.test(content)) return EMPTY;
  if (task) content = content.slice(task[0].length);
  else if (/^\[[ xX]?\]?[ \t]*$/.test(content)) return EMPTY;
  if (/^[ \t]*(?:`{3,}|~{3,})/.test(content)) return FENCE;
  if (/[:-]/.test(content) && /^\s*\|?\s*:?-*:?[ \t]*(?:\|[ \t]*:?-*:?[ \t]*)*\|?\s*$/.test(content))
    return EMPTY;
  if (/^[ \t]*(?:[|<\]]|#+|[+*=_-]+|\d{1,9}[.)]?|`{1,}|~{1,})[ \t]*$/.test(content))
    return EMPTY;
  // A growing `[label]` at the line start can still become a definition; labels end within 999 characters.
  if (growing) return /^[ \t]*\[[^\]]{0,999}\]?[ \t]*$/.test(content) ? EMPTY : { content, kind: "paragraph", offset: line.length - content.length };
  // An open `[` may still close on a later line.
  const openBracket = content.lastIndexOf("[");
  if (openBracket > content.lastIndexOf("]")) content = content.slice(0, openBracket);
  const visibleContent = content.includes("|")
    ? content.split("|").map((cell) => cell.trim()).join("")
    : content;
  return { content: visibleContent, kind: "paragraph", offset: 0 };
}

function referenceDefinition(line: string) {
  const match = /^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>\n]+)>|(\S+))(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/.exec(line);
  if (!match) return undefined;
  return {
    label: normalizeReference(match[1]!),
    value: { href: match[2] ?? match[3]!, title: match[4] ?? match[5] ?? match[6] ?? "" },
    canContinueTitle: match[4] === undefined && match[5] === undefined && match[6] === undefined,
  };
}

function referenceTitle(line: string) {
  return /^ {0,3}(?:"([^"]*)"|'([^']*)'|\(([^)]*)\))[ \t]*$/.exec(line)?.slice(1).find((value) => value !== undefined);
}

function htmlBlockEnd(line: string) {
  if (/^ {0,3}<!--/.test(line)) return /-->/;
  if (/^ {0,3}<\?/.test(line)) return /\?>/;
  if (/^ {0,3}<!\[CDATA\[/.test(line)) return /\]\]>/;
  const tag = /^ {0,3}<(address|article|aside|base|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t/>]|$)/i.exec(line)?.[1];
  return tag ? new RegExp(`</${tag}>`, "i") : undefined;
}

const frameEqual = (left: ContainerFrame, right: ContainerFrame) => left.kind === right.kind
  && (left.kind !== "list" || right.kind === "list" && left.ordered === right.ordered);

export class MarkdownLineResolver {
  private stack: ContainerFrame[] = [{ kind: "document" }];
  private openLeaf?: { kind: "paragraph"; content: string; tableEligible: boolean } | { kind: "fence"; marker: string } | { kind: "indented-code" } | { kind: "table" } | { kind: "html"; end: RegExp };
  private pendingLine: MutablePendingLine = freshPending();
  private readonly referenceIndex = new Map<string, ReferenceDefinition>();
  private pendingReferenceTitle?: { label: string };
  private previousContainerOnly = false;

  get references(): ReadonlyMap<string, ReferenceDefinition> {
    return this.referenceIndex;
  }

  get pending(): PendingLine {
    return { content: this.pendingLine.content, length: this.pendingLine.length, scan: this.pendingLine.scan };
  }

  get pendingLeafContent() {
    const cursor: Cursor = { line: this.pendingLine.content, offset: 0, column: 0 };
    for (const frame of this.stack.slice(1)) {
      if (frame.kind === "quote") {
        if (!consumeQuote(cursor)) break;
      } else if (frame.kind === "item" && !consumeItemIndent(cursor, frame.contentIndent)) break;
    }
    return cursor.line.slice(cursor.offset);
  }

  classifyPending(line = this.pendingLine.content): Readonly<PendingClassification> {
    const { cursor, unmatched } = this.matchContinuations(line);
    if (!unmatched && this.openLeaf?.kind === "fence") {
      const content = line.slice(cursor.offset);
      const marker = this.openLeaf.marker;
      if (new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(content))
        return FENCE;
      return { content, kind: "fence", offset: cursor.offset };
    }
    return classifyLeaf(line, true);
  }

  /** Classifies a line that already ended, so only lines after it can change its meaning. */
  classifyCommitted(line: string): Readonly<PendingClassification> {
    return classifyLeaf(line, false);
  }

  get hasPendingLookahead() {
    return this.openLeaf?.kind === "paragraph" && this.openLeaf.tableEligible;
  }

  get pendingFenceDisposition(): "none" | "possible" | "closes" {
    if (this.openLeaf?.kind !== "fence") return "none";
    const marker = this.openLeaf.marker;
    const content = this.pendingLeafContent;
    if (new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(content)) return "closes";
    return /^ {0,3}$/.test(content) || new RegExp(`^ {0,3}${marker[0]}+\\s*$`).test(content) ? "possible" : "none";
  }

  append(delta: string): LineResolution[] {
    const resolved: LineResolution[] = [];
    let offset = 0;
    while (offset < delta.length) {
      const newline = delta.indexOf("\n", offset);
      if (newline < 0) {
        advancePending(this.pendingLine, delta.slice(offset));
        break;
      }
      advancePending(this.pendingLine, delta.slice(offset, newline));
      resolved.push(this.resolveLine(this.pendingLine.content, false));
      this.pendingLine = freshPending();
      offset = newline + 1;
    }
    return resolved;
  }

  finish(): LineResolution | undefined {
    if (!this.pendingLine.length) return undefined;
    const result = this.resolveLine(this.pendingLine.content, true);
    this.pendingLine = freshPending();
    return result;
  }

  resolveLine(line: string, _final: boolean): LineResolution {
    const followsContainerOnly = this.previousContainerOnly;
    this.previousContainerOnly = false;
    const { cursor, matchedDepth, unmatched, blank } = this.matchContinuations(line);
    const continuedLeaf = this.continueOpenLeaf(cursor, unmatched);
    if (continuedLeaf) return continuedLeaf;
    const probe: Cursor = { ...cursor };
    const startsQuote = consumeQuote(probe);
    const marker = startsQuote ? undefined : listMarker(probe);
    const startsContainer = startsQuote || Boolean(marker);
    const startsInterruptingContainer = startsQuote || Boolean(marker && (!marker.ordered || /^1[.)]$/.test(marker.marker) || unmatched && this.stack.length > 1 || this.stack.some((frame) => frame.kind === "list" && frame.ordered)));
    const unmatchedContent = line.slice(cursor.offset);
    const startsBlock = startsInterruptingContainer || this.openLeaf?.kind === "paragraph" && (this.openLeaf.tableEligible && this.openLeaf.content.includes("|") && isTableDelimiter(unmatchedContent) || this.openLeaf.tableEligible && /^ {0,3}(?:=+|-+)\s*$/.test(unmatchedContent)) || /^ {0,3}(?:#{1,6}(?:\s|$)|`{3,}|~{3,}|(?:\*\s*){3,}$|(?:-\s*){3,}$|(?:_\s*){3,}$)/.test(unmatchedContent);
    if (!unmatched && this.openLeaf?.kind === "table" && !blank && !startsContainer && !startsBlock) {
      return {
        continued: true,
        lazy: false,
        closedToDepth: this.stack.length,
        opened: [],
        leaf: { kind: "table-row", content: line.slice(cursor.offset), path: this.stack.slice() },
      };
    }
    if (this.openLeaf?.kind === "table") this.openLeaf = undefined;
    const { continuesParagraph, lazy } = this.lazyContinuation(blank, startsBlock, unmatched);
    const closedToDepth = this.closeToDepth(matchedDepth, continuesParagraph, unmatched, blank, unmatchedContent, marker);

    const opened = continuesParagraph || blank ? [] : this.openContainers(cursor);

    if (blank || isBlank(line, cursor.offset)) {
      this.pendingReferenceTitle = undefined;
      this.previousContainerOnly = !blank && opened.length > 0;
      return { continued: false, lazy: false, closedToDepth, opened };
    }
    if (followsContainerOnly && /^ {4}/.test(line))
      return { continued: false, lazy: false, closedToDepth, opened };
    const content = line.slice(cursor.offset);
    return this.resolveLeaf(content, line, cursor, closedToDepth, opened, continuesParagraph, lazy);
  }

  private lazyContinuation(blank: boolean, startsBlock: boolean, unmatched: boolean) {
    const continuesParagraph = this.openLeaf?.kind === "paragraph" && !blank && !startsBlock;
    return { continuesParagraph, lazy: unmatched && continuesParagraph };
  }

  private closeToDepth(
    matchedDepth: number,
    continuesParagraph: boolean,
    unmatched: boolean,
    blank: boolean,
    content: string,
    marker: Marker | undefined,
  ) {
    let depth = continuesParagraph ? this.stack.length : matchedDepth;
    const unmatchedFrame = this.stack[matchedDepth];
    const parent = this.stack[matchedDepth - 1];
    if (!continuesParagraph && unmatchedFrame?.kind === "item" && parent?.kind === "list"
      && (isThematicBreak(content) || !marker || marker.ordered !== parent.ordered)) depth--;
    if (!continuesParagraph) {
      this.stack.length = depth;
      if (unmatched || blank) this.openLeaf = undefined;
    }
    return depth;
  }

  private matchContinuations(line: string) {
    const cursor: Cursor = { line, offset: 0, column: 0 };
    let matchedDepth = 1;
    for (; matchedDepth < this.stack.length; matchedDepth++) {
      const frame = this.stack[matchedDepth]!;
      if (frame.kind === "list") continue;
      const matched = frame.kind === "quote"
        ? consumeQuote(cursor)
        : frame.kind === "item" && (isBlank(cursor.line, cursor.offset) || consumeItemIndent(cursor, frame.contentIndent));
      if (!matched) break;
    }
    return {
      cursor,
      matchedDepth,
      unmatched: matchedDepth < this.stack.length,
      blank: isBlank(line, cursor.offset),
    };
  }

  private continueOpenLeaf(cursor: Cursor, unmatched: boolean): LineResolution | undefined {
    if (unmatched || this.openLeaf?.kind !== "fence" && this.openLeaf?.kind !== "html") return undefined;
    const content = cursor.line.slice(cursor.offset);
    if (this.openLeaf.kind === "fence") {
      const marker = this.openLeaf.marker;
      const closes = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(content);
      if (closes) this.openLeaf = undefined;
      return {
        continued: !closes,
        lazy: false,
        closedToDepth: this.stack.length,
        opened: [],
        leaf: { kind: closes ? "fence-close" : "fence-line", content, marker, path: this.stack.slice() },
      };
    }
    const closes = this.openLeaf.end.test(content);
    if (closes) this.openLeaf = undefined;
    return {
      continued: !closes,
      lazy: false,
      closedToDepth: this.stack.length,
      opened: [],
      leaf: { kind: closes ? "html-close" : "html-line", content, path: this.stack.slice() },
    };
  }

  private openContainers(cursor: Cursor): OpenedContainer[] {
    const opened: OpenedContainer[] = [];
    for (;;) {
      if (consumeQuote(cursor)) {
        const frame = { kind: "quote" } as const;
        this.stack.push(frame);
        opened.push(frame);
        continue;
      }
      if (isThematicBreak(cursor.line.slice(cursor.offset))) break;
      const marker = listMarker(cursor);
      if (!marker) break;
      const existing = this.stack.at(-1);
      const list = { kind: "list", ordered: marker.ordered, marker: marker.marker } as const;
      if (!existing || !frameEqual(existing, list)) {
        this.stack.push(list);
        opened.push(list);
      }
      const item = { kind: "item", contentIndent: marker.contentIndent } as const;
      this.stack.push(item);
      opened.push(item);
    }
    return opened;
  }

  private resolveLeaf(
    content: string,
    line: string,
    cursor: Cursor,
    closedToDepth: number,
    opened: OpenedContainer[],
    continuesParagraph: boolean,
    lazy: boolean,
  ): LineResolution {
    const path = this.stack.slice();
    if (continuesParagraph && this.openLeaf?.kind === "paragraph") {
      this.openLeaf.content += `\n${content}`;
      if (lazy) this.openLeaf.tableEligible = false;
      return {
        continued: true,
        lazy: true,
        closedToDepth,
        opened,
        leaf: { kind: "paragraph", content, path: path },
      };
    }
    if (this.pendingReferenceTitle) {
      const title = referenceTitle(content);
      if (title !== undefined) {
        const reference = this.referenceIndex.get(this.pendingReferenceTitle.label)!;
        reference.title = title;
        this.pendingReferenceTitle = undefined;
        this.openLeaf = undefined;
        return {
          continued: false,
          lazy: false,
          closedToDepth,
          opened,
          leaf: { kind: "reference-title", content, path: path },
        };
      }
      this.pendingReferenceTitle = undefined;
    }
    const definition = referenceDefinition(content);
    if (definition) {
      this.referenceIndex.set(definition.label, definition.value);
      if (definition.canContinueTitle) this.pendingReferenceTitle = { label: definition.label };
      this.openLeaf = undefined;
      return {
        continued: false,
        lazy: false,
        closedToDepth,
        opened,
        leaf: { kind: "reference-definition", content, path: path },
      };
    }
    const htmlEnd = htmlBlockEnd(content);
    if (htmlEnd) {
      if (!htmlEnd.test(content.replace(/^.*?(?:<!--|<\?|<!\[CDATA\[|<[a-z][^>]*>)/i, "")))
        this.openLeaf = { kind: "html", end: htmlEnd };
      else this.openLeaf = { kind: "paragraph", content, tableEligible: true };
      return {
        continued: false,
        lazy: false,
        closedToDepth,
        opened,
        leaf: { kind: "html-open", content, path: path },
      };
    }
    const tableDelimiter = opened.length === 0 && this.openLeaf?.kind === "paragraph" && this.openLeaf.tableEligible
      && this.openLeaf.content.split("|").some((cell) => cell.trim()) && isTableDelimiter(content);
    if (tableDelimiter) {
      this.openLeaf = { kind: "table" };
      return {
        continued: false,
        lazy: false,
        closedToDepth,
        opened,
        leaf: { kind: "table-delimiter", content, path: path },
      };
    }
    const setext = opened.length === 0 && this.openLeaf?.kind === "paragraph" && this.openLeaf.tableEligible && /^ {0,3}(=+|-+)\s*$/.exec(content);
    if (setext) {
      this.openLeaf = undefined;
      return {
        continued: false,
        lazy: false,
        closedToDepth,
        opened,
        leaf: { kind: "setext-heading", content: "", level: setext[1]![0] === "=" ? 1 : 2, path: path },
      };
    }
    if (isThematicBreak(content)) {
      this.openLeaf = undefined;
      return {
        continued: false,
        lazy: false,
        closedToDepth,
        opened,
        leaf: { kind: "thematic-break", content: "", path: path },
      };
    }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)[ \t]*|[ \t]*)$/.exec(content);
    if (atx) {
      this.openLeaf = undefined;
      return {
        continued: false,
        lazy: false,
        closedToDepth,
        opened,
        leaf: { kind: "atx-heading", content: (atx[2] ?? "").replace(/[ \t]+#+[ \t]*$/, ""), level: atx[1]!.length, path: path },
      };
    }
    const fence = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(content);
    if (fence && (fence[1]![0] !== "`" || !fence[2]!.includes("`"))) {
      this.openLeaf = { kind: "fence", marker: fence[1]! };
      return {
        continued: false,
        lazy: false,
        closedToDepth,
        opened,
        leaf: { kind: "fence-open", content: "", marker: fence[1], language: fence[2]!.trim().split(/\s+/, 1)[0] || undefined, path: path },
      };
    }
    const indented = { ...cursor };
    if (consumeIndent(indented, 4) >= 4) {
      const continued = this.openLeaf?.kind === "indented-code";
      this.openLeaf = { kind: "indented-code" };
      return {
        continued,
        lazy: false,
        closedToDepth,
        opened,
        leaf: { kind: "indented-code", content: line.slice(indented.offset), path: path },
      };
    }
    const previousParagraph = this.openLeaf?.kind === "paragraph" ? this.openLeaf : undefined;
    const continued = Boolean(previousParagraph) && opened.length === 0;
    const paragraphContent = continued ? `${previousParagraph!.content}\n${content}` : content;
    this.openLeaf = { kind: "paragraph", content: paragraphContent, tableEligible: true };
    return {
      continued,
      lazy,
      closedToDepth,
      opened,
      leaf: { kind: "paragraph", content, path: path },
    };
  }
}
