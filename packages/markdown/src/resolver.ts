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

export const PENDING_INLINE_SUFFIX_BUDGET = 256;

export type PendingInlineOwner = {
  readonly index: number;
  readonly marker: string;
  readonly closer?: string;
};

export type PendingClassification = {
  readonly content: string;
  readonly kind: "empty" | "fence" | "paragraph";
  readonly provisional: boolean;
  readonly stableEnd: number;
  readonly stable: string;
  readonly suffix: string;
  readonly owner?: Readonly<PendingInlineOwner>;
  readonly incremental: boolean;
};

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

const pendingClassification = (
  content: string,
  kind: PendingClassification["kind"],
  owner?: PendingInlineOwner,
  provisional = false,
  incremental = false,
): PendingClassification => {
  let stableEnd = Math.max(0, content.length - PENDING_INLINE_SUFFIX_BUDGET);
  if (owner && owner.index < stableEnd) stableEnd = Math.max(0, content.length - (PENDING_INLINE_SUFFIX_BUDGET - owner.marker.length));
  return { content, kind, provisional, stableEnd, stable: content.slice(0, stableEnd), suffix: content.slice(stableEnd), owner, incremental };
};

function unresolvedInlineOwner(source: string): PendingInlineOwner | undefined {
  const owners: PendingInlineOwner[] = [];
  const brackets: number[] = [];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "[" && source[index - 1] !== "\\") brackets.push(index);
    else if (source[index] === "]" && source[index - 1] !== "\\" && brackets.length) {
      const opener = brackets.pop()!;
      if (source[index + 1] === "(" && source.indexOf(")", index + 2) < 0)
        owners.push({ index: opener, marker: "[", closer: ")" });
    }
  }
  if (brackets.length) owners.push({ index: brackets[0]!, marker: "[" });
  const angle = source.lastIndexOf("<");
  if (angle > source.lastIndexOf(">") && !/[\s\n]/.test(source.slice(angle + 1)))
    owners.push({ index: angle, marker: "<" });
  const entity = /&(?:#(?:x[0-9a-f]*|[0-9]*)?|[a-z][a-z0-9]*)?$/i.exec(source);
  if (entity?.index !== undefined) owners.push({ index: entity.index, marker: "&", closer: ";" });

  let code: { index: number; marker: string } | undefined;
  for (const match of source.matchAll(/`+/g)) {
    if (match.index === undefined) continue;
    if (!code) code = { index: match.index, marker: match[0] };
    else if (code.marker.length === match[0].length) code = undefined;
  }
  if (code) owners.push(code);

  const emphasis: PendingInlineOwner[] = [];
  for (const match of source.matchAll(/(?:\*+|_+|~+)/g)) {
    if (match.index === undefined || source[match.index - 1] === "\\") continue;
    const marker = match[0];
    let open = emphasis.length - 1;
    while (open >= 0 && emphasis[open]!.marker !== marker) open--;
    if (open >= 0 && /\S/.test(source.slice(emphasis[open]!.index + marker.length, match.index))) emphasis.splice(open, 1);
    else emphasis.push({ index: match.index, marker });
  }
  owners.push(...emphasis);
  return owners.sort((left, right) => left.index - right.index)[0];
}

function classifyLeaf(line: string): PendingClassification {
  let content = stripPendingContainers(line);
  if (!content.trim()) return pendingClassification("", "empty");
  if (/^(?: {4}|\t)/.test(content)) content = content[0] === "\t" ? content.slice(1) : content.slice(4);
  const heading = /^#{1,6}[ \t]+/.exec(content);
  if (heading) content = content.slice(heading[0].length);
  const task = /^\[([ xX])\][ \t]+/.exec(content);
  if (/^[ \t]*\[[^\]\n]+\]:/.test(content)) return pendingClassification("", "empty");
  if (task) content = content.slice(task[0].length);
  else if (/^\[[ xX]?\]?[ \t]*$/.test(content)) return pendingClassification("", "empty");
  if (/^[ \t]*(?:`{3,}|~{3,})/.test(content)) return pendingClassification("", "fence");
  const possibleBlock = /[:-]/.test(content) && /^\s*\|?\s*:?-*:?[ \t]*(?:\|[ \t]*:?-*:?[ \t]*)*\|?\s*$/.test(content)
    || /^[ \t]*(?:[|<\]]|#+|[+*=_-]+|\d{1,9}[.)]?|`{1,}|~{1,})[ \t]*$/.test(content);
  if (possibleBlock && content.length <= PENDING_INLINE_SUFFIX_BUDGET) return pendingClassification("", "empty");
  if (content.length <= PENDING_INLINE_SUFFIX_BUDGET
    && (/^[ \t]*\[[^\]\n]*$/.test(content) || /^[ \t]*\[[^\]\n]+\][ \t]*$/.test(content)))
    return pendingClassification("", "empty");
  if (content.length <= PENDING_INLINE_SUFFIX_BUDGET) content = content.trimEnd();
  const inlineOwner = unresolvedInlineOwner(content);
  if (content.length <= PENDING_INLINE_SUFFIX_BUDGET && inlineOwner && content[inlineOwner.index - 1] === "]")
    content = content.slice(0, inlineOwner.index);
  else if (content.length <= PENDING_INLINE_SUFFIX_BUDGET && /\]\[[^\]\n]*\][ \t]*$/.test(content))
    content = content.slice(0, content.lastIndexOf("["));
  const visibleContent = content.includes("|")
    ? content.split("|").map((cell) => cell.trim()).join("")
    : content;
  return pendingClassification(visibleContent, "paragraph", unresolvedInlineOwner(visibleContent));
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
  private classifiedPendingSource = "";
  private classifiedPending?: PendingClassification;
  private classifiedContentOffset = -1;

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

  classifyPending(line?: string): Readonly<PendingClassification> {
    if (line !== undefined) return this.classifyLine(line);
    line = this.pendingLine.content;
    const prior = this.classifiedPending;
    if (prior && prior.content.length > PENDING_INLINE_SUFFIX_BUDGET && this.classifiedContentOffset >= 0
      && line.length >= this.classifiedPendingSource.length && prior.kind === "paragraph") {
      const delta = line.slice(this.classifiedPendingSource.length);
      const prefixLength = this.classifiedContentOffset;
      const closesOwner = prior.owner && delta.includes(prior.owner.closer
        ?? (prior.owner.marker === "[" ? "]" : prior.owner.marker === "<" ? ">" : prior.owner.marker));
      if (!closesOwner && !delta.includes("|") && prefixLength >= 0) {
        const content = prior.content + delta;
        const tailStart = prior.stableEnd;
        const tail = prior.suffix + delta;
        const found = prior.owner ?? unresolvedInlineOwner(tail);
        const owner = found && !prior.owner ? { ...found, index: found.index + tailStart } : found;
        let stableEnd = Math.max(0, content.length - PENDING_INLINE_SUFFIX_BUDGET);
        if (owner && owner.index < stableEnd) stableEnd = Math.max(0, content.length - (PENDING_INLINE_SUFFIX_BUDGET - owner.marker.length));
        const stableLength = stableEnd - prior.stableEnd;
        this.classifiedPendingSource = line;
        return this.classifiedPending = {
          content,
          kind: "paragraph",
          provisional: false,
          stableEnd,
          stable: tail.slice(0, stableLength),
          suffix: tail.slice(stableLength),
          owner,
          incremental: true,
        };
      }
    }
    this.classifiedPendingSource = line;
    this.classifiedPending = this.classifyLine(line);
    this.classifiedContentOffset = line.endsWith(this.classifiedPending.content)
      ? line.length - this.classifiedPending.content.length : -1;
    return this.classifiedPending;
  }

  private classifyLine(line: string): PendingClassification {
    const { cursor, unmatched } = this.matchContinuations(line);
    if (!unmatched && this.openLeaf?.kind === "fence") {
      const content = line.slice(cursor.offset);
      const marker = this.openLeaf.marker;
      if (new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(content))
        return pendingClassification("", "fence");
      return pendingClassification(content, "fence");
    }
    return classifyLeaf(line);
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
      this.classifiedPendingSource = "";
      this.classifiedPending = undefined;
      this.classifiedContentOffset = -1;
      offset = newline + 1;
    }
    return resolved;
  }

  finish(): LineResolution | undefined {
    if (!this.pendingLine.length) return undefined;
    const result = this.resolveLine(this.pendingLine.content, true);
    this.pendingLine = freshPending();
    this.classifiedPendingSource = "";
    this.classifiedPending = undefined;
    this.classifiedContentOffset = -1;
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
