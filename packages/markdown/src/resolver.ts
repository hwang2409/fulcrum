import { normalizeReferenceLeafLine, ReferenceDefinitionParser, type ReferenceDisposition } from "./reference-definition.js";

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
  blank: boolean;
  settledProseStart: boolean;
};

type Cursor = { line: string; offset: number; column: number; partialTab: number };

export type ReferenceDefinition = { href: string; title: string };

type Marker = {
  ordered: boolean;
  marker: string;
  contentIndent: number;
};

type ReferenceReplay = {
  line: string;
  cursor: Cursor;
  closedToDepth: number;
  opened: OpenedContainer[];
  continuesParagraph: boolean;
  lazy: boolean;
  path: readonly ContainerFrame[];
};

const freshPending = (): MutablePendingLine => ({
  content: "",
  length: 0,
  scan: { indentColumns: 0, marker: "possible" },
  atLineStart: true,
  orderedDigits: 0,
  blank: true,
  settledProseStart: false,
});

function advancePending(scan: MutablePendingLine, delta: string) {
  scan.content += delta;
  scan.length += delta.length;
  for (const character of delta) {
    if (character !== " " && character !== "\t") scan.blank = false;
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
    else {
      scan.scan.marker = "none";
      scan.settledProseStart = scan.scan.indentColumns < 4 && !"#`~*-_=|:<>[".includes(character);
    }
    scan.atLineStart = false;
  }
}

function consumeIndent(cursor: Cursor, maximum: number) {
  let columns = 0;
  while (columns < maximum) {
    if (cursor.partialTab) {
      const consumed = Math.min(cursor.partialTab, maximum - columns);
      cursor.partialTab -= consumed;
      cursor.column += consumed;
      columns += consumed;
      continue;
    }
    const character = cursor.line[cursor.offset];
    if (character !== " " && character !== "\t") break;
    const width = character === " " ? 1 : 4 - cursor.column % 4;
    const consumed = Math.min(width, maximum - columns);
    cursor.offset++;
    cursor.column += consumed;
    columns += consumed;
    cursor.partialTab = width - consumed;
  }
  return columns;
}

function cursorContent(cursor: Cursor) {
  let offset = cursor.offset;
  let column = cursor.column + cursor.partialTab;
  let leading = " ".repeat(cursor.partialTab);
  while (offset < cursor.line.length) {
    const character = cursor.line[offset];
    if (character === " ") {
      leading += " ";
      column++;
    } else if (character === "\t") {
      const width = 4 - column % 4;
      leading += " ".repeat(width);
      column += width;
    } else break;
    offset++;
  }
  return leading + cursor.line.slice(offset);
}

function consumeQuote(cursor: Cursor) {
  const start = { ...cursor };
  consumeIndent(cursor, 3);
  if (cursor.partialTab || cursor.line[cursor.offset] !== ">") {
    Object.assign(cursor, start);
    return false;
  }
  cursor.offset++;
  cursor.column++;
  if (cursor.line[cursor.offset] === " " || cursor.line[cursor.offset] === "\t") consumeIndent(cursor, 1);
  return true;
}

function listMarker(cursor: Cursor): Marker | undefined {
  const start = { ...cursor };
  consumeIndent(cursor, 3);
  if (cursor.partialTab) {
    Object.assign(cursor, start);
    return undefined;
  }
  const match = /^(?:([-+*])|(\d{1,9})([.)]))/.exec(cursor.line.slice(cursor.offset, cursor.offset + 11));
  if (!match) {
    Object.assign(cursor, start);
    return undefined;
  }
  const marker = match[1] ?? `${match[2]}${match[3]}`;
  const markerWidth = marker.length;
  cursor.offset += markerWidth;
  cursor.column += markerWidth;
  if (cursor.line[cursor.offset] !== " " && cursor.line[cursor.offset] !== "\t") {
    Object.assign(cursor, start);
    return undefined;
  }
  const whitespace = { ...cursor };
  const whitespaceColumns = consumeIndent(whitespace, 5);
  const padding = whitespaceColumns <= 4 && !isBlank(whitespace.line, whitespace.offset) ? whitespaceColumns : 1;
  consumeIndent(cursor, padding);
  return { ordered: !match[1], marker, contentIndent: markerWidth + padding };
}

function consumeItemIndent(cursor: Cursor, width: number) {
  const start = { ...cursor };
  const consumed = consumeIndent(cursor, width);
  if (consumed >= width) return true;
  Object.assign(cursor, start);
  return false;
}

const isBlank = (line: string, offset = 0) => {
  for (; offset < line.length; offset++) if (line[offset] !== " " && line[offset] !== "\t") return false;
  return true;
};
const isTableDelimiter = (line: string) => /^ {0,3}\|[ \t]*:?-+:?[ \t]*\|[ \t]*$/.test(line)
  || /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/.test(line);
const isThematicBreak = (line: string) => /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(line);
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
  const reference = new ReferenceDefinitionParser();
  const disposition = reference.append(content.trimStart());
  const finished = growing ? disposition : reference.finish();
  if (finished.kind === "candidate" || finished.kind === "metadata" || finished.kind === "definition") return EMPTY;
  if (task) content = content.slice(task[0].length);
  else if (/^\[[ xX]?\]?[ \t]*$/.test(content)) return EMPTY;
  if (/^[ \t]*(?:`{3,}|~{3,})/.test(content)) return FENCE;
  // The anchored row test fails on the first prose character, so the whole-line `[:-]` scan rarely runs.
  if (/^\s*\|?\s*:?-*:?[ \t]*(?:\|[ \t]*:?-*:?[ \t]*)*\|?\s*$/.test(content) && /[:-]/.test(content))
    return EMPTY;
  if (/^[ \t]*(?:[|<\]]|#+|[+*=_-]+|\d{1,9}[.)]?|`{1,}|~{1,})[ \t]*$/.test(content))
    return EMPTY;
  if (growing) return { content, kind: "paragraph", offset: line.length - content.length };
  // An open `[` may still close on a later line.
  const openBracket = content.lastIndexOf("[");
  if (openBracket > content.lastIndexOf("]")) content = content.slice(0, openBracket);
  const visibleContent = content.includes("|")
    ? content.split("|").map((cell) => cell.trim()).join("")
    : content;
  return { content: visibleContent, kind: "paragraph", offset: 0 };
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
  private pendingClassification?: { length: number; value: PendingClassification };
  private readonly referenceIndex = new Map<string, ReferenceDefinition>();
  private activeReference?: {
    parser: ReferenceDefinitionParser;
    lines: string[];
    replay: ReferenceReplay[];
    openLeaf: MarkdownLineResolver["openLeaf"];
    first: Omit<LineResolution, "leaf">;
    path: readonly ContainerFrame[];
    published?: { label: string; update: boolean; consumedLines: number };
  };
  private previousContainerOnly = false;

  get references(): ReadonlyMap<string, ReferenceDefinition> {
    return this.referenceIndex;
  }

  get pending(): PendingLine {
    return { content: this.pendingLine.content, length: this.pendingLine.length, scan: this.pendingLine.scan };
  }

  get pendingLeafContent() {
    const cursor: Cursor = { line: this.pendingLine.content, offset: 0, column: 0, partialTab: 0 };
    for (const frame of this.stack.slice(1)) {
      if (frame.kind === "quote") {
        if (!consumeQuote(cursor)) break;
      } else if (frame.kind === "item" && !consumeItemIndent(cursor, frame.contentIndent)) break;
    }
    return cursorContent(cursor);
  }

  classifyPending(line = this.pendingLine.content): Readonly<PendingClassification> {
    const cached = this.pendingClassification;
    if (line === this.pendingLine.content && cached && line.length === cached.length) return cached.value;
    const { cursor, unmatched } = this.matchContinuations(line);
    if (!unmatched && this.openLeaf?.kind === "fence") {
      const content = cursorContent(cursor);
      const marker = this.openLeaf.marker;
      if (new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(content))
        return FENCE;
      return { content, kind: "fence", offset: cursor.offset };
    }
    const value = classifyLeaf(line, true);
    if (line !== this.pendingLine.content) return value;
    if (value.kind !== "paragraph") {
      this.pendingClassification = { length: line.length, value };
      return value;
    }
    const owner = this;
    const liveValue: PendingClassification = {
      kind: "paragraph",
      offset: value.offset,
      get content() { return owner.pendingLine.content.slice(value.offset); },
    };
    this.pendingClassification = { length: line.length, value: liveValue };
    return liveValue;
  }

  /** Classifies a line that already ended, so only lines after it can change its meaning. */
  classifyCommitted(line: string): Readonly<PendingClassification> {
    return classifyLeaf(line, false);
  }

  get pendingStartsWithSettledProse() {
    return this.pendingLine.settledProseStart;
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

  private appendPartial(delta: string) {
    advancePending(this.pendingLine, delta);
    if (this.pendingClassification?.value.kind === "paragraph" && this.pendingLine.settledProseStart)
      this.pendingClassification.length += delta.length;
    else this.pendingClassification = undefined;
  }

  private consumePendingLine() {
    const results = this.resolveLine(this.pendingLine.content, false);
    this.pendingLine = freshPending();
    this.pendingClassification = undefined;
    return results;
  }

  append(delta: string): LineResolution[] {
    const resolved: LineResolution[] = [];
    let offset = 0;
    while (offset < delta.length) {
      const newline = delta.indexOf("\n", offset);
      if (newline < 0) {
        this.appendPartial(delta.slice(offset));
        break;
      }
      advancePending(this.pendingLine, delta.slice(offset, newline));
      resolved.push(...this.consumePendingLine());
      offset = newline + 1;
    }
    return resolved;
  }

  finish(): LineResolution | undefined {
    const results = this.pendingLine.length
      ? this.resolveLine(this.pendingLine.content, true)
      : this.finishReference();
    this.pendingLine = freshPending();
    this.pendingClassification = undefined;
    return results.at(-1);
  }

  private resolveLine(line: string, final: boolean): LineResolution[] {
    const followsContainerOnly = this.previousContainerOnly;
    this.previousContainerOnly = false;
    const { cursor, matchedDepth, unmatched, blank } = this.matchContinuations(line);
    const continuedLeaf = this.continueOpenLeaf(cursor, unmatched);
    if (continuedLeaf) return [continuedLeaf];
    const { marker, startsContainer, startsBlock } = this.lineStart(cursor, unmatched);
    const unmatchedContent = cursorContent(cursor);
    const tableRow = this.continueTableRow(line, cursor, unmatched, blank, startsContainer, startsBlock);
    if (tableRow) return [tableRow];
    if (this.openLeaf?.kind === "table") this.openLeaf = undefined;
    let { continuesParagraph, lazy } = this.lazyContinuation(blank, startsBlock, unmatched);
    const referenceContinuesLazily = Boolean(this.activeReference) && unmatched && !blank && !startsBlock;
    if (referenceContinuesLazily) {
      continuesParagraph = true;
      lazy = true;
    }
    if (followsContainerOnly && this.isReferenceStart(unmatchedContent)) {
      continuesParagraph = false;
      lazy = false;
    }
    const closedToDepth = this.closeToDepth(matchedDepth, continuesParagraph, unmatched, blank, unmatchedContent, marker);

    const opened = continuesParagraph || blank ? [] : this.openContainers(cursor);

    if (blank || isBlank(line, cursor.offset)) {
      const reference = this.finishReference();
      this.previousContainerOnly = !blank && opened.length > 0;
      return [...reference, { continued: false, lazy: false, closedToDepth, opened }];
    }
    if (followsContainerOnly && /^ {4}/.test(line))
      return [{ continued: false, lazy: false, closedToDepth, opened }];
    const content = cursorContent(cursor);
    const interruptedReference = Boolean(this.activeReference) && !referenceContinuesLazily && (unmatched || startsContainer || startsBlock);
    const reference = this.resolveReference(line, cursor, content, final, closedToDepth, opened, continuesParagraph, lazy, interruptedReference);
    if (reference.handled) return reference.results;
    return [...reference.results, this.resolveLeaf(content, line, cursor, closedToDepth, opened, continuesParagraph, lazy)];
  }

  private continueTableRow(
    line: string,
    cursor: Cursor,
    unmatched: boolean,
    blank: boolean,
    startsContainer: boolean,
    startsBlock: boolean,
  ): LineResolution | undefined {
    if (unmatched || this.openLeaf?.kind !== "table" || blank || startsContainer || startsBlock) return undefined;
    return {
      continued: true,
      lazy: false,
      closedToDepth: this.stack.length,
      opened: [],
      leaf: { kind: "table-row", content: cursorContent(cursor), path: this.stack.slice() },
    };
  }

  private isReferenceStart(content: string) {
    const parser = new ReferenceDefinitionParser();
    const result = parser.append(content);
    return result.kind === "candidate" || result.kind === "metadata" || result.kind === "definition";
  }

  private resolveReference(
    line: string,
    cursor: Cursor,
    content: string,
    final: boolean,
    closedToDepth: number,
    opened: OpenedContainer[],
    continuesParagraph: boolean,
    lazy: boolean,
    interrupted: boolean,
  ): { handled: boolean; results: LineResolution[] } {
    const results = interrupted ? this.finishReference() : [];
    const replay = { line, cursor: { ...cursor }, closedToDepth, opened, continuesParagraph, lazy, path: this.stack.slice() };
    if (this.activeReference) return this.continueReference(content, final, replay, results);
    if (continuesParagraph || lazy) return { handled: false, results };
    return this.startReference(content, final, replay, results);
  }

  private continueReference(
    content: string,
    final: boolean,
    replay: ReferenceReplay,
    results: LineResolution[],
  ) {
    const active = this.activeReference!;
    const appended = active.parser.append(normalizeReferenceLeafLine(content));
    if (appended.kind === "definition") {
      results.push(...this.completeReference(appended));
      return { handled: false, results };
    }
    active.lines.push(content);
    active.replay.push(replay);
    const ended = final ? active.parser.finish() : active.parser.endLine({ continuation: true });
    if (ended.kind === "definition" || ended.kind === "rejected") results.push(...this.completeReference(ended));
    else results.push(...this.publishPendingReference());
    return { handled: true, results };
  }

  private startReference(
    content: string,
    final: boolean,
    replay: ReferenceReplay,
    results: LineResolution[],
  ) {
    const parser = new ReferenceDefinitionParser();
    const appended = parser.append(content);
    if (appended.kind !== "candidate" && appended.kind !== "metadata") return { handled: false, results };
    this.activeReference = {
      parser,
      lines: [content],
      replay: [replay],
      openLeaf: this.openLeaf,
      first: { continued: false, lazy: false, closedToDepth: replay.closedToDepth, opened: replay.opened },
      path: this.stack.slice(),
    };
    const ended = final ? parser.finish() : parser.endLine({ continuation: true });
    if (ended.kind === "definition" || ended.kind === "rejected") results.push(...this.completeReference(ended));
    else results.push(...this.publishPendingReference());
    return { handled: true, results };
  }

  private finishReference() {
    if (!this.activeReference) return [];
    return this.completeReference(this.activeReference.parser.finish());
  }

  private publishPendingReference(): LineResolution[] {
    const active = this.activeReference;
    const pending = active?.parser.pendingDefinition();
    if (!active || !pending || active.published) return [];
    const { label, href, title } = pending.definition;
    const update = !this.referenceIndex.has(label);
    if (update) this.referenceIndex.set(label, { href, title });
    active.published = { label, update, consumedLines: pending.consumedLines };
    return [{
      ...active.first,
      leaf: {
        kind: "reference-definition",
        content: active.lines.slice(0, pending.consumedLines).join("\n"),
        path: active.path,
      },
    }];
  }

  private completeReference(result: ReferenceDisposition): LineResolution[] {
    const active = this.activeReference;
    this.activeReference = undefined;
    if (!active) return [];
    if (result.kind !== "definition") {
      if (active.published?.update) this.referenceIndex.delete(active.published.label);
      this.openLeaf = active.openLeaf;
      return active.replay.map((replay, index) => this.resolveLeaf(
        cursorContent(replay.cursor),
        replay.line,
        { ...replay.cursor },
        replay.closedToDepth,
        replay.opened,
        index > 0 && this.openLeaf?.kind === "paragraph",
        replay.lazy,
        replay.path,
      ));
    }
    const { label, href, title } = result.definition;
    const firstDefinition = !this.referenceIndex.has(label);
    if (firstDefinition) this.referenceIndex.set(label, { href, title });
    if (active.published?.update) this.referenceIndex.get(active.published.label)!.title = title;
    const consumed = active.lines.slice(0, result.consumedLines).join("\n");
    const resolutions: LineResolution[] = active.published ? [] : [{
      ...active.first,
      leaf: { kind: "reference-definition", content: consumed, path: active.path },
    }];
    if (active.published && result.consumedLines > active.published.consumedLines) resolutions.push({
      continued: false,
      lazy: false,
      closedToDepth: this.stack.length,
      opened: [],
      leaf: {
        kind: "reference-title",
        content: active.lines.slice(active.published.consumedLines, result.consumedLines).join("\n"),
        path: active.path,
      },
    });
    const remainder = active.lines.slice(result.consumedLines).join("\n");
    if (remainder) {
      this.openLeaf = { kind: "paragraph", content: remainder, tableEligible: true };
      resolutions.push({
        continued: false,
        lazy: false,
        closedToDepth: this.stack.length,
        opened: [],
        leaf: { kind: "paragraph", content: remainder, path: active.path },
      });
    } else {
      this.openLeaf = undefined;
    }
    return resolutions;
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

  /** Whether the pending line, once it ends, continues the open paragraph: the read-only part of `resolveLine`. */
  pendingContinuesParagraph(line = this.pendingLine.content) {
    if (this.openLeaf?.kind !== "paragraph") return false;
    if (line === this.pendingLine.content && this.stack.length === 1 && this.pendingLine.settledProseStart) return true;
    const { cursor, unmatched, blank } = this.matchContinuations(line);
    return !blank && !this.lineStart(cursor, unmatched).startsBlock;
  }

  /** The container or block that a line starts after its matched continuation markers. */
  private lineStart(cursor: Cursor, unmatched: boolean) {
    const probe: Cursor = { ...cursor };
    const startsQuote = consumeQuote(probe);
    const marker = startsQuote ? undefined : listMarker(probe);
    const startsContainer = startsQuote || Boolean(marker);
    const startsInterruptingContainer = startsQuote || Boolean(marker && (!marker.ordered || /^1[.)]$/.test(marker.marker) || unmatched && this.stack.length > 1 || this.stack.some((frame) => frame.kind === "list" && frame.ordered)));
    const startsBlock = startsInterruptingContainer || this.startsLeafBlock(cursor);
    return { marker, startsContainer, startsBlock };
  }

  /**
   * Whether the unmatched content starts a heading, fence, thematic break, setext underline, or table delimiter.
   * Every one of these begins with a character from a small set after the indent, so the first character is read
   * before any regex runs: the growing line is checked on every delta, and a whole-line regex would make each
   * continuation line quadratic.
   */
  private startsLeafBlock(cursor: Cursor) {
    const unmatchedContent = cursorContent(cursor);
    let first = 0;
    while (unmatchedContent.charCodeAt(first) === 32 || unmatchedContent.charCodeAt(first) === 9) first++;
    const lead = unmatchedContent[first];
    if (lead === undefined || !"#`~*-_=|:".includes(lead)) return false;
    const leaf = this.openLeaf;
    if (leaf?.kind === "paragraph" && leaf.tableEligible) {
      if ("|-:".includes(lead) && leaf.content.includes("|") && isTableDelimiter(unmatchedContent)) return true;
      if ("=-".includes(lead) && /^ {0,3}(?:=+|-+)\s*$/.test(unmatchedContent)) return true;
    }
    return /^ {0,3}(?:#{1,6}(?:\s|$)|`{3,}|~{3,}|(?:\*\s*){3,}$|(?:-\s*){3,}$|(?:_\s*){3,}$)/.test(unmatchedContent);
  }

  private matchContinuations(line: string) {
    const cursor: Cursor = { line, offset: 0, column: 0, partialTab: 0 };
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
      blank: line === this.pendingLine.content && cursor.offset === 0 ? this.pendingLine.blank : isBlank(line, cursor.offset),
    };
  }

  private continueOpenLeaf(cursor: Cursor, unmatched: boolean): LineResolution | undefined {
    if (unmatched || this.openLeaf?.kind !== "fence" && this.openLeaf?.kind !== "html") return undefined;
    const content = cursorContent(cursor);
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
      if (isThematicBreak(cursorContent(cursor))) break;
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
    resolvedPath?: readonly ContainerFrame[],
  ): LineResolution {
    const path = resolvedPath ?? this.stack.slice();
    if (continuesParagraph && this.openLeaf?.kind === "paragraph") {
      const paragraphCursor = { ...cursor };
      consumeIndent(paragraphCursor, 4);
      const paragraphLine = cursorContent(paragraphCursor);
      this.openLeaf.content += `\n${paragraphLine}`;
      if (lazy) this.openLeaf.tableEligible = false;
      return {
        continued: true,
        lazy: true,
        closedToDepth,
        opened,
        leaf: { kind: "paragraph", content: paragraphLine, path: path },
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
        leaf: { kind: "indented-code", content: cursorContent(indented), path: path },
      };
    }
    const previousParagraph = this.openLeaf?.kind === "paragraph" ? this.openLeaf : undefined;
    const continued = Boolean(previousParagraph) && opened.length === 0;
    const paragraphCursor = { ...cursor };
    consumeIndent(paragraphCursor, previousParagraph ? 4 : 3);
    const paragraphLine = cursorContent(paragraphCursor);
    const paragraphContent = continued ? `${previousParagraph!.content}\n${paragraphLine}` : paragraphLine;
    this.openLeaf = { kind: "paragraph", content: paragraphContent, tableEligible: true };
    return {
      continued,
      lazy,
      closedToDepth,
      opened,
      leaf: { kind: "paragraph", content: paragraphLine, path: path },
    };
  }
}
