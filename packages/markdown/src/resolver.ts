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
  readonly pieces: readonly string[];
  readonly length: number;
  readonly scan: Readonly<PendingLineScan>;
};

type MutablePendingLine = {
  pieces: string[];
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
  pieces: [],
  length: 0,
  scan: { indentColumns: 0, marker: "possible" },
  atLineStart: true,
  orderedDigits: 0,
});

function advancePending(scan: MutablePendingLine, delta: string) {
  scan.pieces.push(delta);
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
  private openLeaf?: { kind: "paragraph"; content: string } | { kind: "fence"; marker: string } | { kind: "indented-code" } | { kind: "table" } | { kind: "html"; end: RegExp };
  private pendingLine: MutablePendingLine = freshPending();
  private readonly referenceIndex = new Map<string, ReferenceDefinition>();
  private pendingReferenceTitle?: { label: string };

  get references(): ReadonlyMap<string, ReferenceDefinition> {
    return this.referenceIndex;
  }

  get pending(): PendingLine {
    return { pieces: this.pendingLine.pieces, length: this.pendingLine.length, scan: this.pendingLine.scan };
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
      resolved.push(this.resolveLine(this.pendingLine.pieces.join(""), false));
      this.pendingLine = freshPending();
      offset = newline + 1;
    }
    return resolved;
  }

  finish(): LineResolution | undefined {
    if (!this.pendingLine.length) return undefined;
    const result = this.resolveLine(this.pendingLine.pieces.join(""), true);
    this.pendingLine = freshPending();
    return result;
  }

  resolveLine(line: string, _final: boolean): LineResolution {
    const cursor: Cursor = { line, offset: 0, column: 0 };
    let matchedDepth = 1;
    for (; matchedDepth < this.stack.length; matchedDepth++) {
      const frame = this.stack[matchedDepth]!;
      if (frame.kind === "list") continue;
      if (frame.kind === "quote" ? consumeQuote(cursor) : frame.kind === "item" && (isBlank(cursor.line, cursor.offset) || consumeItemIndent(cursor, frame.contentIndent))) continue;
      break;
    }

    const unmatched = matchedDepth < this.stack.length;
    const blank = isBlank(line, cursor.offset);
    if (!unmatched && this.openLeaf?.kind === "fence") {
      const content = line.slice(cursor.offset);
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
    if (!unmatched && this.openLeaf?.kind === "html") {
      const content = line.slice(cursor.offset);
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
    const probe: Cursor = { ...cursor };
    const startsQuote = consumeQuote(probe);
    const marker = startsQuote ? undefined : listMarker(probe);
    const startsContainer = startsQuote || Boolean(marker);
    const unmatchedContent = line.slice(cursor.offset);
    const startsBlock = startsContainer || /^ {0,3}(?:#{1,6}(?:\s|$)|`{3,}|~{3,}|(?:\*\s*){3,}$|(?:-\s*){3,}$|(?:_\s*){3,}$|<)/.test(unmatchedContent);
    if (!unmatched && this.openLeaf?.kind === "table" && !blank && !startsContainer) {
      return {
        continued: true,
        lazy: false,
        closedToDepth: this.stack.length,
        opened: [],
        leaf: { kind: "table-row", content: line.slice(cursor.offset), path: this.stack.slice() },
      };
    }
    if (this.openLeaf?.kind === "table") this.openLeaf = undefined;
    const lazy = unmatched && this.openLeaf?.kind === "paragraph" && !blank && !startsBlock;
    let closedToDepth = lazy ? this.stack.length : matchedDepth;
    const unmatchedFrame = this.stack[matchedDepth];
    const parent = this.stack[matchedDepth - 1];
    if (!lazy && unmatchedFrame?.kind === "item" && parent?.kind === "list"
      && (!marker || marker.ordered !== parent.ordered)) closedToDepth--;
    if (!lazy) {
      this.stack.length = closedToDepth;
      if (unmatched || blank) this.openLeaf = undefined;
    }

    const opened: OpenedContainer[] = [];
    if (!lazy && !blank) {
      for (;;) {
        if (consumeQuote(cursor)) {
          const frame = { kind: "quote" } as const;
          this.stack.push(frame);
          opened.push(frame);
          continue;
        }
        if (isThematicBreak(cursor.line.slice(cursor.offset))) break;
        const beforeMarker = { ...cursor };
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
        if (cursor.offset === beforeMarker.offset) break;
      }
    }

    const leafPath = () => this.stack.slice();
    if (blank) {
      this.pendingReferenceTitle = undefined;
      return { continued: false, lazy: false, closedToDepth, opened };
    }
    const content = line.slice(cursor.offset);
    if (lazy && this.openLeaf?.kind === "paragraph") {
      this.openLeaf.content += `\n${content}`;
      return {
        continued: true,
        lazy: true,
        closedToDepth,
        opened,
        leaf: { kind: "paragraph", content, path: leafPath() },
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
          leaf: { kind: "reference-title", content, path: leafPath() },
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
        leaf: { kind: "reference-definition", content, path: leafPath() },
      };
    }
    const htmlEnd = htmlBlockEnd(content);
    if (htmlEnd) {
      if (!htmlEnd.test(content.replace(/^.*?(?:<!--|<\?|<!\[CDATA\[|<[a-z][^>]*>)/i, "")))
        this.openLeaf = { kind: "html", end: htmlEnd };
      else this.openLeaf = undefined;
      return {
        continued: false,
        lazy: false,
        closedToDepth,
        opened,
        leaf: { kind: "html-open", content, path: leafPath() },
      };
    }
    const tableDelimiter = opened.length === 0 && this.openLeaf?.kind === "paragraph" && isTableDelimiter(content);
    if (tableDelimiter) {
      this.openLeaf = { kind: "table" };
      return {
        continued: false,
        lazy: false,
        closedToDepth,
        opened,
        leaf: { kind: "table-delimiter", content, path: leafPath() },
      };
    }
    const setext = opened.length === 0 && this.openLeaf?.kind === "paragraph" && /^ {0,3}(=+|-+)\s*$/.exec(content);
    if (setext) {
      this.openLeaf = undefined;
      return {
        continued: false,
        lazy: false,
        closedToDepth,
        opened,
        leaf: { kind: "setext-heading", content: "", level: setext[1]![0] === "=" ? 1 : 2, path: leafPath() },
      };
    }
    if (isThematicBreak(content)) {
      this.openLeaf = undefined;
      return {
        continued: false,
        lazy: false,
        closedToDepth,
        opened,
        leaf: { kind: "thematic-break", content: "", path: leafPath() },
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
        leaf: { kind: "atx-heading", content: (atx[2] ?? "").replace(/[ \t]+#+[ \t]*$/, ""), level: atx[1]!.length, path: leafPath() },
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
        leaf: { kind: "fence-open", content: "", marker: fence[1], language: fence[2]!.trim().split(/\s+/, 1)[0] || undefined, path: leafPath() },
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
        leaf: { kind: "indented-code", content: line.slice(indented.offset), path: leafPath() },
      };
    }
    const previousParagraph = this.openLeaf?.kind === "paragraph" ? this.openLeaf : undefined;
    const continued = Boolean(previousParagraph) && opened.length === 0;
    const paragraphContent = continued ? `${previousParagraph!.content}\n${content}` : content;
    this.openLeaf = { kind: "paragraph", content: paragraphContent };
    return {
      continued,
      lazy,
      closedToDepth,
      opened,
      leaf: { kind: "paragraph", content, path: leafPath() },
    };
  }
}
