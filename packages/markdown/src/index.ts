import { safeUrl } from "@fulcrum/core";
import type { Highlight } from "@fulcrum/highlight";
import { delimiterRun } from "./delimiters.js";
import MarkdownIt from "./vendor/markdown-it.mjs";
import { normalizeReferenceLabel, normalizeReferenceLeafLine, ReferenceDefinitionParser, type ReferenceDisposition } from "./reference-definition.js";
import { literalBrackets, PendingInline } from "./pending-inline.js";
import { MarkdownLineResolver, pendingMarkerLine, tableCells, type LineResolution, type OpenedContainer, type ReferenceDefinition } from "./resolver.js";

type MarkdownToken = {
  type: string;
  tag: string;
  nesting: number;
  map: [number, number] | null;
  markup: string;
  info: string;
  content: string;
  hidden: boolean;
  children: MarkdownToken[] | null;
  attrGet(name: string): string | null;
};

export type { Highlight as Highlighter, HighlightContext, Token, TokenType } from "@fulcrum/highlight";
export type HighlightResult = ReturnType<Highlight>;

export type Inline =
  | { type: "text"; value: string }
  | { type: "pending-reference"; value: string }
  | { type: "code"; value: string }
  | { type: "break" }
  | { type: "emphasis"; children: Inline[] }
  | { type: "strong"; children: Inline[] }
  | { type: "strike"; children: Inline[] }
  | { type: "link"; href?: string; title?: string; children: Inline[] }
  | { type: "image"; src?: string; title?: string; alt: string };

export type ListItem = { checked?: boolean; children: Block[] };
export type ListBlock = { type: "list"; ordered: boolean; start?: number; items: ListItem[] };
export type Block =
  | { type: "paragraph"; children: Inline[]; tight?: boolean }
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "code"; language?: string; value: string; open?: boolean }
  | ListBlock
  | { type: "blockquote"; children: Block[] }
  | { type: "table"; header: Inline[][]; rows: Inline[][][]; align: Array<"left" | "center" | "right" | undefined> }
  | { type: "rule" };

type ParsedBlock = { block: Block; map: [number, number]; closed: boolean };
type Environment = { references?: Record<string, { href: string; title: string }> };
type ExactCodeCloserScanner = {
  position: number;
  run?: { start: number; length: number };
  resolvedEnd?: number;
};

type ResolvedCodeSuffix = {
  prefix: Inline[];
  start: number;
  nodes: Inline[];
  pending?: PendingInline;
};

type PendingInlineState = {
  offset: number;
  lineLength: number;
  continues: boolean;
  referenceCount: number;
  openCode?: { source: string; index: number; length: number };
  closer?: ExactCodeCloserScanner;
  resolvedSuffix?: ResolvedCodeSuffix;
};

const pendingInlineMatches = (state: PendingInlineState | undefined, offset: number, continues: boolean, referenceCount: number) =>
  state?.offset === offset && state.continues === continues && state.referenceCount === referenceCount;

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
const block = (markdown as any).block;

function referenceContinuation(state: any, line: number) {
  if (line >= state.lineMax || state.isEmpty(line)) return false;
  if (state.sCount[line] - state.blkIndent > 3 || state.sCount[line] < 0) return true;
  const rules = state.md.block.ruler.getRules("reference");
  const parent = state.parentType;
  state.parentType = "reference";
  const terminates = rules.some((rule: any) => rule(state, line, state.lineMax, true));
  state.parentType = parent;
  return !terminates;
}

function storeReference(state: any, result: Extract<ReferenceDisposition, { kind: "definition" }>, nextLine: number, silent: boolean) {
  const href = state.md.normalizeLink(result.definition.href);
  if (!state.md.validateLink(href)) return false;
  if (silent) return true;
  state.env.references ??= {};
  state.env.references[result.definition.label] ??= { href, title: result.definition.title };
  // The spec appendix keeps paragraph remainder after definitions in the same container.
  if (state.sCount[nextLine] < state.blkIndent && referenceContinuation(state, nextLine))
    state.sCount[nextLine] = state.blkIndent;
  state.line = nextLine;
  return true;
}

function parseReferenceBlock(state: any, startLine: number) {
  const parser = new ReferenceDefinitionParser();
  for (let line = startLine; line < state.lineMax; line++) {
    const content = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
    const appended = parser.append(normalizeReferenceLeafLine(content));
    if (appended.kind === "definition") return appended;
    if (appended.kind === "rejected" || appended.kind === "ineligible") return undefined;
    const continuation = referenceContinuation(state, line + 1);
    const ended = parser.endLine({ continuation });
    if (ended.kind === "definition") return ended;
    if (ended.kind === "rejected" || !continuation) return undefined;
  }
}

function referenceRule(state: any, startLine: number, _endLine: number, silent: boolean) {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4 || state.src[start] !== "[") return false;
  const result = parseReferenceBlock(state, startLine);
  return result ? storeReference(state, result, startLine + result.consumedLines, silent) : false;
}

block.ruler.at("reference", referenceRule);

const attr = (token: MarkdownToken, name: string) => token.attrGet(name) ?? undefined;

type InlineContainer = Extract<Inline, { children: Inline[] }>;
type InlineStack = Array<{ node: InlineContainer }>;

const inlineText = (node: Inline): string => node.type === "text" || node.type === "pending-reference" || node.type === "code"
  ? node.value
  : "children" in node ? node.children.map(inlineText).join("") : node.type === "image" ? node.alt : "";

function inlineContainer(token: MarkdownToken): InlineContainer | undefined {
  if (token.type === "em_open") return { type: "emphasis", children: [] };
  if (token.type === "strong_open") return { type: "strong", children: [] };
  if (token.type === "s_open") return { type: "strike", children: [] };
  if (token.type === "link_open") return { type: "link", href: safeUrl(attr(token, "href")), title: attr(token, "title"), children: [] };
}

function appendInlineToken(token: MarkdownToken, root: Inline[], stack: InlineStack) {
  const target = stack.at(-1)?.node.children ?? root;
  if (token.type === "text" || token.type === "html_inline" || token.type === "softbreak") {
    const value = token.type === "softbreak" ? "\n" : token.content;
    const last = target.at(-1);
    if (last?.type === "text") last.value += value;
    else if (value) target.push({ type: "text", value });
    return;
  }
  if (token.type === "hardbreak") target.push({ type: "break" });
  else if (token.type === "code_inline") target.push({ type: "code", value: token.content });
  else if (token.type === "image") {
    const alt = inlineNodes(token.children ?? []).map(inlineText).join("") || token.content;
    target.push({ type: "image", src: safeUrl(attr(token, "src"), "image"), title: attr(token, "title"), alt });
  } else if (token.nesting === 1) {
    const node = inlineContainer(token);
    if (node) {
      target.push(node);
      stack.push({ node });
    }
  } else if (token.nesting === -1 && stack.length) stack.pop();
}

function inlineNodes(tokens: MarkdownToken[]): Inline[] {
  const root: Inline[] = [];
  const stack: InlineStack = [];
  for (const token of tokens) appendInlineToken(token, root, stack);
  return root;
}

const tokenMap = (token: MarkdownToken): [number, number] => token.map ?? [0, 0];

function convertLeaf(tokens: MarkdownToken[], index: number): [ParsedBlock, number] | undefined {
  const token = tokens[index]!;
  if (token.type === "paragraph_open" || token.type === "heading_open") {
    const inline = tokens[index + 1]!;
    const block: Block = token.type === "paragraph_open"
      ? { type: "paragraph", children: inlineNodes(inline.children ?? []), tight: token.hidden || undefined }
      : { type: "heading", level: Number(token.tag.slice(1)), children: inlineNodes(inline.children ?? []) };
    return [{ block, map: tokenMap(token), closed: true }, index + 3];
  }
  if (token.type === "fence" || token.type === "code_block") {
    const language = token.type === "fence" ? token.info.trim().split(/\s+/)[0] || undefined : undefined;
    const lines = token.map?.[1] ?? 0;
    const closed = token.type === "code_block" || lines > 0 && token.markup.length > 0 && token.content.endsWith("\n") && token.map !== null;
    return [{ block: { type: "code", language, value: token.content, open: !closed }, map: tokenMap(token), closed }, index + 1];
  }
  if (token.type === "hr") return [{ block: { type: "rule" }, map: tokenMap(token), closed: true }, index + 1];
  return undefined;
}

function convertList(tokens: MarkdownToken[], index: number): [ParsedBlock, number] {
  const token = tokens[index]!;
  const close = token.type === "bullet_list_open" ? "bullet_list_close" : "ordered_list_close";
  const items: ListItem[] = [];
  index++;
  while (index < tokens.length && tokens[index]!.type !== close) {
    if (tokens[index]!.type !== "list_item_open") { index++; continue; }
    const [children, next] = convertBlocks(tokens, index + 1, "list_item_close");
    index = next;
    const item: ListItem = { children: children.map(({ block }) => block) };
    const first = item.children[0];
    if (first?.type === "paragraph" && first.children[0]?.type === "text") {
      const task = /^\[([ xX])\]\s+/.exec(first.children[0].value);
      if (task) {
        item.checked = task[1]!.toLowerCase() === "x";
        first.children[0].value = first.children[0].value.slice(task[0].length);
      }
    }
    items.push(item);
  }
  const ordered = token.type === "ordered_list_open";
  const startValue = ordered ? Number(attr(token, "start") ?? "1") : undefined;
  return [{ block: { type: "list", ordered, start: startValue, items }, map: tokenMap(token), closed: true }, index + 1];
}

type TableState = {
  header: Inline[][];
  rows: Inline[][][];
  align: Array<"left" | "center" | "right" | undefined>;
  row?: Inline[][];
  inHeader: boolean;
};

function tableAlignment(token: MarkdownToken): "left" | "center" | "right" | undefined {
  const style = attr(token, "style") ?? "";
  if (style.includes("center")) return "center";
  if (style.includes("right")) return "right";
  if (style.includes("left")) return "left";
}

function appendTableToken(state: TableState, token: MarkdownToken, inline?: MarkdownToken) {
  if (token.type === "thead_open") state.inHeader = true;
  else if (token.type === "thead_close") state.inHeader = false;
  else if (token.type === "tr_open") state.row = [];
  else if (token.type === "tr_close" && state.row) {
    if (state.inHeader) state.header.push(...state.row);
    else state.rows.push(state.row);
    state.row = undefined;
  } else if ((token.type === "th_open" || token.type === "td_open") && state.row) {
    state.row.push(inline?.type === "inline" ? inlineNodes(inline.children ?? []) : []);
    if (token.type === "th_open") state.align.push(tableAlignment(token));
  }
}

function convertTable(tokens: MarkdownToken[], index: number): [ParsedBlock, number] {
  const token = tokens[index]!;
  const state: TableState = { header: [], rows: [], align: [], inHeader: false };
  index++;
  while (index < tokens.length && tokens[index]!.type !== "table_close") {
    appendTableToken(state, tokens[index]!, tokens[index + 1]);
    index++;
  }
  return [{ block: { type: "table", header: state.header, rows: state.rows, align: state.align }, map: tokenMap(token), closed: true }, index + 1];
}

function convertBlocks(tokens: MarkdownToken[], start = 0, stop?: string): [ParsedBlock[], number] {
  const blocks: ParsedBlock[] = [];
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (stop && token.type === stop) return [blocks, index + 1];
    const leaf = convertLeaf(tokens, index);
    if (leaf) {
      blocks.push(leaf[0]);
      index = leaf[1];
    } else if (token.type === "blockquote_open") {
      const [children, next] = convertBlocks(tokens, index + 1, "blockquote_close");
      blocks.push({ block: { type: "blockquote", children: children.map(({ block }) => block) }, map: tokenMap(token), closed: true });
      index = next;
    } else if (token.type === "bullet_list_open" || token.type === "ordered_list_open") {
      const [list, next] = convertList(tokens, index);
      blocks.push(list);
      index = next;
    } else if (token.type === "table_open") {
      const [table, next] = convertTable(tokens, index);
      blocks.push(table);
      index = next;
    } else index++;
  }
  return [blocks, index];
}

function parseDetailed(source: string, environment: Environment = {}): ParsedBlock[] {
  const tokens = markdown.parse(source.replace(/\r\n?/g, "\n"), environment);
  return convertBlocks(tokens)[0];
}

export function parseMarkdown(source: string): Block[] {
  return parseDetailed(source).map(({ block }) => block);
}

const escaped = (source: string, index: number) => {
  let escapes = 0;
  for (let at = index - 1; at >= 0 && source[at] === "\\"; at--) escapes++;
  return escapes % 2 === 1;
};

const unmatchedCodeSpan = (source: string) => {
  let opener: { index: number; length: number } | undefined;
  for (const run of source.matchAll(/`+/g)) {
    if (run.index === undefined) continue;
    if (escaped(source, run.index)) continue;
    if (!opener) opener = { index: run.index, length: run[0].length };
    else if (opener.length === run[0].length) opener = undefined;
  }
  return opener;
};

function appendResolvedCodeSuffix(state: ResolvedCodeSuffix, delta: string, source: () => string, parse: (source: string, streaming: boolean, growing?: boolean) => Inline[]) {
  if (state.pending) {
    const copied = state.pending.copiedCharacters;
    state.pending.append(delta);
    return state.pending.copiedCharacters - copied;
  }
  if (/^[\p{L}\p{N} ]*$/u.test(delta)) {
    const last = state.nodes.at(-1);
    if (last?.type === "text" && state.nodes.length > state.prefix.length) last.value += delta;
    else if (last?.type === "text" && delta) state.nodes[state.nodes.length - 1] = { type: "text", value: last.value + delta };
    else if (delta) state.nodes.push({ type: "text", value: delta });
    return delta.length;
  }
  state.pending = new PendingInline(parse, undefined, state.prefix);
  state.pending.append(source());
  state.nodes = state.pending.nodes;
  return state.pending.copiedCharacters;
}

function scanExactCodeCloser(scanner: ExactCodeCloserScanner, source: string, markerLength: number, priorLength: number) {
  let scanned = 0;
  while (scanner.position < source.length && scanner.resolvedEnd === undefined) {
    const character = source[scanner.position]!;
    if (scanner.run) {
      if (character === "`") {
        scanner.run.length++;
        scanner.position++;
        scanned++;
        continue;
      }
      scanned++;
      if (scanner.run.length === markerLength && !escaped(source, scanner.run.start)) {
        scanner.resolvedEnd = scanner.run.start + scanner.run.length;
        break;
      }
      scanner.run = undefined;
      continue;
    }
    if (character === "`") {
      scanner.run = { start: scanner.position, length: 0 };
      continue;
    }
    scanner.position++;
    scanned++;
  }
  if (scanner.resolvedEnd === undefined && scanner.run && scanner.position === source.length
    && scanner.run.length === markerLength && scanner.run.start > priorLength && !escaped(source, scanner.run.start))
    scanner.resolvedEnd = scanner.position;
  return scanned;
}

// An open span's edge spaces hide: the closer may strip them, and a space that shows must never disappear.
const codeSpanValue = (value: string) => value.replace(/\n/g, " ").replace(/^ | $/g, "");

function tailCode(blocks: Block[]): Extract<Block, { type: "code" }> | undefined {
  const last = blocks.at(-1);
  if (last?.type === "code") return last;
  if (last?.type === "list") return tailCode(last.items.at(-1)?.children ?? []);
  if (last?.type === "blockquote") return tailCode(last.children);
  return undefined;
}

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
function withoutOpenLink(source: string, growing: boolean) {
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
function withoutOpenEmphasis(source: string, growing: boolean) {
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

type SafeInlineContent = { source: string; openCode?: string };

// This is the only entry point for rendering unfinished inline markdown. An open `<` and a trailing entity wait only
// on a growing line (`growing`): neither continues past a line end, so on an ended line they are decided text. A last
// backslash waits one character on any line: after a line end, that character decides a hard break or text.
function withoutTrailingLookahead(source: string, growing: boolean) {
  const backslashes = /\\+$/.exec(source)?.[0].length ?? 0;
  if (growing && backslashes % 2) return source.slice(0, -1);
  if (!growing) return source;
  // The longest named entity has 31 characters after `&`, a numeric one at most 7 digits or 6 hex digits.
  const entity = /&(?:#(?:x[0-9a-f]{0,6}|[0-9]{0,7})?|[a-z][a-z0-9]{0,31})?$/i.exec(source);
  return entity ? source.slice(0, entity.index) : source;
}

const withoutOpenSyntax = (source: string, growing: boolean) =>
  withoutTrailingLookahead(withoutOpenEmphasis(withoutOpenLink(growing ? withoutOpenAngle(source) : source, growing), growing), growing);

function safeInlineContent(source: string, growing: boolean): SafeInlineContent {
  source = withoutOpenSyntax(source, growing);
  // Only the growing line's open code span previews as code; an ended line shows its backticks as sent.
  const opener = growing ? unmatchedCodeSpan(source) : undefined;
  if (!opener || opener.index < source.lastIndexOf("\n")) return { source };
  let content = source.slice(opener.index + opener.length);
  const trailingTicks = /`+$/.exec(content)?.[0];
  if (trailingTicks && trailingTicks.length < opener.length) content = content.slice(0, -trailingTicks.length);
  return { source: source.slice(0, opener.index), openCode: content || undefined };
}

/** `growing`: the source's last line may still grow; a streaming paragraph's ended lines pass false. */
function parseInline(source: string, streaming: boolean, environment: Environment = {}, growing = streaming) {
  const safe = streaming ? safeInlineContent(source, growing) : { source };
  // CommonMark decides trailing spaces and backslashes only when another line starts. A committed streaming line needs
  // that decision now, so parse one harmless continuation and remove only it and its soft break afterward.
  const committed = streaming && !growing;
  const tokens = markdown.parseInline(committed ? `${safe.source}\na` : safe.source, environment);
  const nodes = inlineNodes(tokens[0]?.children ?? []);
  if (committed) {
    const last = nodes.at(-1);
    if (last?.type === "text" && last.value.endsWith("a")) {
      last.value = last.value.slice(0, -1).replace(/\n$/, "");
      if (!last.value) nodes.pop();
    }
  }
  // An unclosed span may stay literal, so its preview shows only the text its content renders as markdown.
  if (safe.openCode) {
    const literal = inlineNodes(markdown.parseInline(withoutOpenSyntax(literalBrackets(safe.openCode), growing), environment)[0]?.children ?? []);
    nodes.push({ type: "code", value: codeSpanValue(literal.map(inlineText).join("")) });
  }
  return nodes;
}

function inspectReferenceLine(line: string) {
  const parser = new ReferenceDefinitionParser();
  let metadata = false;
  let disposition: ReferenceDisposition = { kind: "ineligible" };
  for (const character of line) {
    disposition = parser.append(character);
    if (disposition.kind === "metadata") metadata = true;
    if (disposition.kind === "ineligible" || disposition.kind === "rejected") break;
  }
  return { disposition: parser.finish(), metadata };
}

export interface StreamingDocument {
  readonly source: string;
  readonly stats: { readonly frozenParses: number; readonly tailParses: number; readonly scannedCharacters: number; readonly previewScannedCharacters: number; readonly copiedCharacters: number };
  append(delta: string): void;
  finish(): void;
  /**
   * The document so far. Blocks of an earlier frame are not snapshots: the growing paragraph's node list is updated
   * in place by later appends, so diff frames by copying them first.
   */
  render(): readonly Block[];
}

const lineOffset = (source: string, line: number) => {
  let offset = 0;
  for (let current = 0; current < line; current++) {
    const next = source.indexOf("\n", offset);
    if (next < 0) return source.length;
    offset = next + 1;
  }
  return offset;
};

const openSnapshot = <BlockType extends Block>(block: BlockType): BlockType => ({ ...block });

const BLOCK_CHUNK_SIZE = 64;

class BlockBuffer {
  readonly view: readonly Block[];
  private readonly chunks: Block[][] = [];
  private open: Block[] = [];
  private frozenLength = 0;

  constructor() {
    const target: Block[] = [];
    this.view = new Proxy(target, {
      get: (_target, property, receiver) => {
        if (property === "length") return this.length;
        if (property === "map") return this.map.bind(this);
        if (property === "at") return this.at.bind(this);
        if (property === Symbol.iterator) return this.values.bind(this);
        if (typeof property === "string" && /^\d+$/.test(property)) return this.at(Number(property));
        return Reflect.get(target, property, receiver);
      },
    });
  }

  get length() { return this.frozenLength + this.open.length; }
  get frozen() { return this.frozenLength; }

  freeze(blocks: Block[]) {
    for (const block of blocks) {
      let chunk = this.chunks.at(-1);
      if (!chunk || chunk.length === BLOCK_CHUNK_SIZE) this.chunks.push(chunk = []);
      chunk.push(block);
      this.frozenLength++;
    }
  }

  publish(blocks: Block[]) { this.open = blocks; }

  replace(index: number, block: Block) {
    if (index < 0 || index >= this.frozenLength) throw new RangeError("only frozen markdown blocks can be replaced");
    this.chunks[Math.floor(index / BLOCK_CHUNK_SIZE)]![index % BLOCK_CHUNK_SIZE] = block;
  }

  reset(blocks: Block[], preserveEqual = false) {
    const previous = preserveEqual ? Array.from(this.values()) : [];
    this.chunks.length = 0;
    this.open = [];
    this.frozenLength = 0;
    this.freeze(blocks.map((block, index) => previous[index] && JSON.stringify(previous[index]) === JSON.stringify(block) ? previous[index]! : block));
  }

  at(index: number) {
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    if (index >= this.frozenLength) return this.open[index - this.frozenLength];
    return this.chunks[Math.floor(index / BLOCK_CHUNK_SIZE)]![index % BLOCK_CHUNK_SIZE];
  }

  map<Result>(callback: (block: Block, index: number, blocks: readonly Block[]) => Result) {
    const result: Result[] = [];
    for (let index = 0; index < this.length; index++) result.push(callback(this.at(index)!, index, this.view));
    return result;
  }

  *values() {
    for (let index = 0; index < this.length; index++) yield this.at(index)!;
  }
}

type TreeFrame =
  | { kind: "document"; children: Block[] }
  | { kind: "quote"; block: Extract<Block, { type: "blockquote" }>; children: Block[] }
  | { kind: "list"; block: ListBlock }
  | { kind: "item"; item: ListItem; children: Block[] };

type ParagraphRecord = {
  block: Extract<Block, { type: "paragraph" }>;
  source: string;
  labels: Set<string>;
};

type TableBlock = Extract<Block, { type: "table" }>;
type TableCellRecord = {
  table: TableBlock;
  row: number;
  column: number;
  header: boolean;
  source: string;
  labels: Set<string>;
};
type ReferenceUser = ParagraphRecord | TableCellRecord;
type TableRecord = { header: string; delimiter: string; cells: TableCellRecord[] };

// The text of `value` with each `[label]` that may still become a reference reduced to its link text.
function unresolvedReferenceLabels(source: string, references: Environment["references"]) {
  const labels = new Set<string>();
  // A `[` after an odd number of backslashes is escaped and can never start a reference.
  for (const match of source.matchAll(/(?<!(?<!\\)(?:\\\\)*\\)!?\[([^\]\n]+)\]\[([^[\]\n]*)\]/g)) {
    const label = normalizeReferenceLabel(match[2] || match[1]!);
    if (!references?.[label]) labels.add(label);
  }
  for (const match of source.matchAll(/(?<!!|(?<!\\)(?:\\\\)*\\)\[([^[\]\n]+)\](?![\[(])/g)) {
    const label = normalizeReferenceLabel(match[1]!);
    if (!references?.[label]) labels.add(label);
  }
  return labels;
}

const referenceEnvironment = (references: ReadonlyMap<string, ReferenceDefinition>): Environment => {
  if (!references.size) return {};
  return { references: Object.fromEntries(references) };
};

function currentChildren(frames: TreeFrame[]) {
  const frame = frames.at(-1)!;
  if (frame.kind === "list") throw new Error("markdown list content must belong to an item");
  return frame.children;
}

// An open `<` may still become an autolink, which drops it, so only the `<` waits; the text after it shows, escaped
// so it stays raw as it is inside an autolink. A last backslash waits as it does everywhere.
function withoutOpenAngle(source: string) {
  const angle = source.lastIndexOf("<");
  if (angle <= source.lastIndexOf(">") || /\s/.test(source.slice(angle + 1))) return source;
  const body = source.slice(angle + 1);
  const trailing = /\\+$/.exec(body)?.[0].length ?? 0;
  return source.slice(0, angle) + body.slice(0, body.length - (trailing % 2)).replace(/[!-/:-@[-`{-~]/g, "\\$&");
}

function clearTightParagraphs(blocks: Block[]) {
  for (const block of blocks) {
    if (block.type === "paragraph") block.tight = undefined;
    else if (block.type === "blockquote") clearTightParagraphs(block.children);
    else if (block.type === "list") for (const item of block.items) clearTightParagraphs(item.children);
  }
}

function closeOpenCode(blocks: Block[]): boolean {
  const code = tailCode(blocks);
  if (!code?.open) return false;
  code.open = false;
  return true;
}

function appendOpenCode(blocks: Block[], content: string): boolean {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]!;
    if (block.type === "code" && block.open) {
      block.value += content;
      return true;
    }
    if (block.type === "blockquote" && appendOpenCode(block.children, content)) return true;
    if (block.type === "list")
      for (let item = block.items.length - 1; item >= 0; item--)
        if (appendOpenCode(block.items[item]!.children, content)) return true;
  }
  return false;
}

function cloneOpenPath(blocks: readonly Block[], cloneLeaf = true): Block[] {
  const copy = blocks.slice();
  const index = copy.length - 1;
  const block = copy[index];
  if (!block) return copy;
  if (block.type === "blockquote") copy[index] = { ...block, children: cloneOpenPath(block.children, cloneLeaf) };
  else if (block.type === "list") {
    const items = block.items.slice();
    const item = items.at(-1);
    if (item) items[items.length - 1] = { ...item, children: cloneOpenPath(item.children, cloneLeaf) };
    copy[index] = { ...block, items };
  } else if (cloneLeaf && block.type === "paragraph") copy[index] = { ...block };
  else if (cloneLeaf && block.type === "code") copy[index] = { ...block };
  else if (cloneLeaf && block.type === "table") copy[index] = { ...block, rows: block.rows.slice() };
  return copy;
}

function tailTable(blocks: Block[]): Extract<Block, { type: "table" }> | undefined {
  const block = blocks.at(-1);
  if (block?.type === "table") return block;
  if (block?.type === "blockquote") return tailTable(block.children);
  if (block?.type === "list") return tailTable(block.items.at(-1)?.children ?? []);
}

function tailParagraph(blocks: Block[]): Extract<Block, { type: "paragraph" }> | undefined {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]!;
    if (block.type === "paragraph") return block;
    if (block.type === "blockquote") {
      const paragraph = tailParagraph(block.children);
      if (paragraph) return paragraph;
    } else if (block.type === "list") {
      for (let item = block.items.length - 1; item >= 0; item--) {
        const paragraph = tailParagraph(block.items[item]!.children);
        if (paragraph) return paragraph;
      }
    }
  }
}

function appendPendingTableRow(blocks: Block[], source: string, references: Environment) {
  const table = tailTable(blocks);
  if (!table) return false;
  const cells = tableCells(source);
  // A pipe after a cell ends it, so only a last cell with no border after it may still grow (an open code span in it
  // waits for its closer); every other cell shows its final form, as GFM splits cells before inline parsing.
  const growing = /(?:^|[^\\])\|[ \t]*$/.test(source) ? -1 : cells.length - 1;
  const row = Array.from({ length: table.header.length }, (_, index) => parseInline(cells[index]?.trim() ?? "", index === growing, references));
  table.rows = [...table.rows, row];
  return true;
}

// The children of the first `depth` open containers in `blocks` (a cloned open path), where a new growing paragraph goes.
function openChildren(blocks: Block[], frames: readonly TreeFrame[], depth: number) {
  let children = blocks;
  for (const frame of frames.slice(1, depth)) {
    const last = children.at(-1);
    if (frame.kind === "quote" && last?.type === "blockquote") children = last.children;
    else if (frame.kind === "item" && last?.type === "list") children = last.items.at(-1)?.children ?? children;
  }
  return children;
}

function appendPendingParagraph(blocks: Block[], pending: Inline[], continuesParagraph: boolean) {
  if (!pending.length) return;
  const paragraph = continuesParagraph ? tailParagraph(blocks) : undefined;
  if (paragraph) {
    paragraph.children = pending;
    return paragraph;
  }
  // `pending` is the growing line's live node list; each frame gets a new block object around it.
  const block = { type: "paragraph" as const, children: pending };
  blocks.push(block);
  return block;
}

function reconcileBlocks(committed: readonly Block[], preview: Block[]): Block[] {
  return preview.map((block, index) => {
    const prior = committed[index];
    if (!prior || prior.type !== block.type) return block;
    if (JSON.stringify(prior) === JSON.stringify(block)) return prior;
    if (prior.type === "blockquote" && block.type === "blockquote")
      return { ...block, children: reconcileBlocks(prior.children, block.children) };
    if (prior.type === "list" && block.type === "list") {
      return {
        ...block,
        items: block.items.map((item, itemIndex) => ({
          ...item,
          children: reconcileBlocks(prior.items[itemIndex]?.children ?? [], item.children),
        })),
      };
    }
    return block;
  });
}

export function createStreamingDocument(): StreamingDocument {
  let source = "";
  let finished = false;
  let frozenParses = 0;
  let tailParses = 0;
  let scannedCharacters = 0;
  let previewScannedCharacters = 0;
  let copiedCharacters = 0;
  const resolver = new MarkdownLineResolver();
  const blocks = new BlockBuffer();
  let openRoots: Block[] = [];
  const frames: TreeFrame[] = [{ kind: "document", children: openRoots }];
  const paragraphRecords = new WeakMap<Block, ParagraphRecord>();
  const allParagraphRecords = new Set<ParagraphRecord>();
  const referenceUsers = new Map<string, Set<ReferenceUser>>();
  const tables = new WeakMap<Block, TableRecord>();
  let openCode: Extract<Block, { type: "code" }> | undefined;
  let openIndentedCode = false;
  let openParagraph: ParagraphRecord | undefined;
  let openTable: Extract<Block, { type: "table" }> | undefined;
  let previewSource = "";
  let previewBlocks: readonly Block[] | undefined;
  let viewSource = "";
  let pendingReferenceApply = false;
  let afterCarriageReturn = false;
  // The growing line's inline nodes and the identity used to reuse them.
  let pendingInline: PendingInline | undefined;
  let pendingInlineState: PendingInlineState | undefined;
  const pendingLooseLists = new Set<ListBlock>();
  const looseLists = new WeakSet<ListBlock>();

  const environment = () => referenceEnvironment(resolver.references);

  const publish = () => blocks.publish(openRoots);

  // A closed paragraph can never continue, so it shows its final inline form from here on.
  const closeParagraph = () => {
    if (openParagraph) updateParagraph(openParagraph);
    openParagraph = undefined;
  };

  const freezeRoots = () => {
    if (!openRoots.length) return;
    closeParagraph();
    if (openCode) openCode.open = false;
    openCode = undefined;
    openIndentedCode = false;
    blocks.freeze(openRoots);
    openRoots = [];
    frames[0] = { kind: "document", children: openRoots };
    frozenParses++;
  };

  const closeTo = (depth: number) => {
    if (depth >= frames.length) return;
    if (depth <= 1) freezeRoots();
    closeParagraph();
    frames.length = Math.max(1, depth);
    openCode = undefined;
    openIndentedCode = false;
    openTable = undefined;
  };

  const appendBlock = (block: Block) => {
    currentChildren(frames).push(block);
  };

  const openContainer = (container: OpenedContainer) => {
    if (container.kind === "quote") {
      const block: Extract<Block, { type: "blockquote" }> = { type: "blockquote", children: [] };
      appendBlock(block);
      frames.push({ kind: "quote", block, children: block.children });
      return;
    }
    if (container.kind === "list") {
      const block: ListBlock = { type: "list", ordered: container.ordered, start: container.ordered ? Number.parseInt(container.marker, 10) : undefined, items: [] };
      appendBlock(block);
      frames.push({ kind: "list", block });
      return;
    }
    const list = frames.at(-1);
    if (container.kind === "item" && list?.kind === "list") {
      const item: ListItem = { children: [] };
      list.block.items.push(item);
      frames.push({ kind: "item", item, children: item.children });
    }
  };

  const unregister = (record: ReferenceUser) => {
    for (const label of record.labels) referenceUsers.get(label)?.delete(record);
    record.labels.clear();
  };

  const registerReferences = (record: ReferenceUser) => {
    for (const label of unresolvedReferenceLabels(record.source, environment().references)) {
      record.labels.add(label);
      let users = referenceUsers.get(label);
      if (!users) referenceUsers.set(label, users = new Set());
      users.add(record);
    }
  };

  const updateParagraph = (record: ParagraphRecord, streaming = false, committed?: Inline[]) => {
    unregister(record);
    if (committed) {
      record.block.children = committed;
      registerReferences(record);
      tailParses++;
      return;
    }
    const classified = streaming && !record.source.includes("\n") ? resolver.classifyCommitted(record.source) : undefined;
    let inlineSource = classified?.kind === "paragraph" ? classified.content : record.source;
    if (classified?.kind === "paragraph") {
      const inspected = inspectReferenceLine(inlineSource);
      if (inspected.metadata && inspected.disposition.kind !== "definition") inlineSource = inlineSource.replace("[", "\\[");
    }
    record.block.children = /[\\[*_~`<!&]/.test(inlineSource)
      ? parseInline(inlineSource, streaming, environment(), false)
      : [{ type: "text", value: inlineSource }];
    registerReferences(record);
    tailParses++;
  };

  const createParagraph = (content: string) => {
    const lists = frames.filter((frame): frame is Extract<TreeFrame, { kind: "list" }> => frame.kind === "list");
    const block: Extract<Block, { type: "paragraph" }> = {
      type: "paragraph",
      children: [],
      tight: frames.at(-1)?.kind === "item" && !lists.some((frame) => looseLists.has(frame.block)) || undefined,
    };
    let item: ListItem | undefined;
    for (let index = frames.length - 1; index >= 0; index--) {
      const frame = frames[index]!;
      if (frame.kind === "item") { item = frame.item; break; }
    }
    const task = item && /^\[([ xX])\]\s+/.exec(content);
    if (item && task) {
      item.checked = task[1]!.toLowerCase() === "x";
      content = content.slice(task[0].length);
    }
    const record: ParagraphRecord = { block, source: content, labels: new Set() };
    // The growing line already holds stable nodes for this text; only its unresolved tail is parsed again.
    updateParagraph(record, true, pendingInline?.commit(content));
    paragraphRecords.set(block, record);
    allParagraphRecords.add(record);
    appendBlock(block);
    return record;
  };

  const appendParagraphLine = (record: ParagraphRecord, content: string) => {
    const addition = `\n${content}`;
    record.source += addition;
    const child = record.block.children.length === 1 ? record.block.children[0] : undefined;
    if (child?.type === "text" && !/[\\&<>*_~`\[\]]/.test(content)) child.value += addition;
    else updateParagraph(record, true);
  };

  const updateTableCell = (record: TableCellRecord) => {
    unregister(record);
    const children = parseInline(record.source, false, environment());
    if (record.header) record.table.header[record.column] = children;
    else record.table.rows[record.row]![record.column] = children;
    registerReferences(record);
    tailParses++;
  };

  const createTableCell = (table: TableBlock, source: string, header: boolean, row: number, column: number) => {
    const record: TableCellRecord = { table, source, header, row, column, labels: new Set() };
    registerReferences(record);
    return record;
  };

  // A frozen paragraph gets a new block object so memoized views see the change.
  const refreshUser = (user: ReferenceUser) => {
    if (!("block" in user)) return updateTableCell(user);
    let frozenIndex = -1;
    for (let index = 0; index < blocks.frozen; index++) if (blocks.at(index) === user.block) { frozenIndex = index; break; }
    updateParagraph(user);
    if (frozenIndex < 0) return;
    const prior = user.block;
    user.block = { ...prior, children: [...prior.children] };
    paragraphRecords.delete(prior);
    paragraphRecords.set(user.block, user);
    blocks.replace(frozenIndex, user.block);
  };

  // `retainUsers` keeps users registered while a title on the next line can still change the definition.
  const applyReferences = (retainUsers = false) => {
    for (const [label, users] of referenceUsers) {
      if (!resolver.references.has(label)) continue;
      const retained = retainUsers ? [...users] : [];
      for (const user of [...users]) refreshUser(user);
      if (retainUsers) {
        for (const user of retained) user.labels.add(label);
        referenceUsers.set(label, new Set(retained));
      } else referenceUsers.delete(label);
    }
  };

  const applyHeadingOrRule = (leaf: NonNullable<LineResolution["leaf"]>) => {
    if (leaf.kind === "atx-heading") {
      appendBlock({ type: "heading", level: leaf.level!, children: parseInline(leaf.content, false, environment()) });
    } else if (leaf.kind === "setext-heading") {
      const children = currentChildren(frames);
      const paragraph = children.at(-1);
      if (paragraph?.type === "paragraph") {
        unregister(paragraphRecords.get(paragraph)!);
        children[children.length - 1] = { type: "heading", level: leaf.level!, children: paragraph.children };
      }
    } else if (leaf.kind === "thematic-break") appendBlock({ type: "rule" });
    else return false;
    return true;
  };

  const applyCodeLeaf = (resolution: LineResolution) => {
    const leaf = resolution.leaf!;
    if (leaf.kind === "fence-open") {
      openCode = { type: "code", language: leaf.language, value: "", open: true };
      openIndentedCode = false;
      appendBlock(openCode);
    } else if (leaf.kind === "fence-line" && openCode) openCode.value += `${leaf.content}\n`;
    else if (leaf.kind === "fence-close" && openCode) {
      openCode.open = false;
      openCode = undefined;
      openIndentedCode = false;
    } else if (leaf.kind === "indented-code") {
      if (!resolution.continued || !openCode) {
        openCode = { type: "code", language: undefined, value: "", open: true };
        openIndentedCode = true;
        appendBlock(openCode);
      }
      openCode.value += `${leaf.content}\n`;
    } else return false;
    return true;
  };

  const applyTableLeaf = (leaf: NonNullable<LineResolution["leaf"]>) => {
    if (leaf.kind === "table-delimiter") {
      const children = currentChildren(frames);
      const paragraph = children.at(-1);
      if (paragraph?.type === "paragraph") {
        const record = paragraphRecords.get(paragraph)!;
        // GFM: the header is only the line directly above the delimiter; earlier lines stay a paragraph above the table.
        const split = record.source.lastIndexOf("\n");
        const header = record.source.slice(split + 1);
        if (split >= 0) {
          record.source = record.source.slice(0, split);
          updateParagraph(record);
        } else unregister(record);
        const headerCells = tableCells(header);
        const delimiterCells = tableCells(leaf.content);
        const table: TableBlock = {
          type: "table",
          header: headerCells.map((cell) => parseInline(cell.trim(), false, environment())),
          rows: [],
          align: delimiterCells.map((cell) => {
            const value = cell.trim();
            return value.startsWith(":") && value.endsWith(":") ? "center"
              : value.endsWith(":") ? "right" : value.startsWith(":") ? "left" : undefined;
          }),
        };
        if (split >= 0) children.push(table);
        else children[children.length - 1] = table;
        const tableRecord: TableRecord = { header, delimiter: leaf.content, cells: [] };
        for (let column = 0; column < headerCells.length; column++)
          tableRecord.cells.push(createTableCell(table, headerCells[column]!.trim(), true, 0, column));
        tables.set(table, tableRecord);
        openTable = table;
      }
    } else if (leaf.kind === "table-row" && openTable) {
      const cells = tableCells(leaf.content);
      const row = openTable.rows.length;
      openTable.rows.push(Array.from({ length: openTable.header.length }, (_, index) => parseInline(cells[index]?.trim() ?? "", false, environment())));
      const tableRecord = tables.get(openTable)!;
      for (let column = 0; column < openTable.header.length; column++)
        tableRecord.cells.push(createTableCell(openTable, cells[column]?.trim() ?? "", false, row, column));
    } else return false;
    return true;
  };

  const applyMetadataLeaf = (leaf: NonNullable<LineResolution["leaf"]>) => {
    if (leaf.kind === "html-open") openParagraph = createParagraph(leaf.content);
    else if ((leaf.kind === "html-line" || leaf.kind === "html-close") && openParagraph) {
      appendParagraphLine(openParagraph, leaf.content);
      if (leaf.kind === "html-close") closeParagraph();
    } else if (leaf.kind === "reference-definition") {
      pendingReferenceApply = true;
      applyReferences(pendingReferenceApply);
    } else if (leaf.kind === "reference-title") {
      applyReferences();
      pendingReferenceApply = false;
    } else return false;
    return true;
  };

  const applyLeaf = (resolution: LineResolution) => {
    const leaf = resolution.leaf;
    if (pendingReferenceApply && (!leaf || leaf.kind !== "reference-definition" && leaf.kind !== "reference-title")) {
      applyReferences();
      pendingReferenceApply = false;
    }
    if (!leaf) {
      for (const frame of frames) if (frame.kind === "list") pendingLooseLists.add(frame.block);
      closeParagraph();
      if (frames.length === 1) freezeRoots();
      return;
    }
    if (leaf.kind === "paragraph") {
      if (resolution.continued && openParagraph) appendParagraphLine(openParagraph, leaf.content);
      else {
        closeParagraph();
        openParagraph = createParagraph(leaf.content);
      }
      openCode = undefined;
      openIndentedCode = false;
      openTable = undefined;
      return;
    }
    // A table delimiter turns the open paragraph into the header; every other leaf except HTML lines ends it.
    if (leaf.kind === "table-delimiter") openParagraph = undefined;
    else if (leaf.kind !== "html-line" && leaf.kind !== "html-close") closeParagraph();
    applyHeadingOrRule(leaf) || applyCodeLeaf(resolution) || applyTableLeaf(leaf) || applyMetadataLeaf(leaf);
  };

  const apply = (resolution: LineResolution) => {
    scannedCharacters += resolution.leaf?.path.length ?? resolution.closedToDepth;
    closeTo(resolution.closedToDepth);
    if (resolution.opened.length) {
      closeParagraph();
      openTable = undefined;
    }
    for (const container of resolution.opened) openContainer(container);
    if (resolution.leaf) {
      for (const list of pendingLooseLists) {
        if (frames.some((frame) => frame.kind === "list" && frame.block === list)) {
          looseLists.add(list);
          clearTightParagraphs([list]);
        }
      }
      pendingLooseLists.clear();
    }
    applyLeaf(resolution);
    publish();
  };

  const appendNormalized = (delta: string) => {
    source += delta;
    previewBlocks = undefined;
    scannedCharacters += delta.length * 3;
    for (const piece of delta.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      for (const resolution of resolver.append(piece)) apply(resolution);
      if (piece.endsWith("\n")) {
        pendingInline = undefined;
        pendingInlineState = undefined;
      }
    }
  };

  const parsePending = (source: string, streaming: boolean, growing = streaming) => {
    return parseInline(source, streaming, environment(), growing).filter((node) => node.type !== "text" || node.value);
  };

  const pendingPreview = (classification: Readonly<ReturnType<MarkdownLineResolver["classifyPending"]>>, continues: boolean): Inline[] => {
    const line = resolver.pending.content;
    if (classification.kind !== "paragraph") return [];
    const startsInline = !pendingInline || !pendingInlineMatches(pendingInlineState, classification.offset, continues, resolver.references.size);
    if (startsInline) {
      // A code span an earlier line left open may close on this line, as the paragraph parse will pair it; the earlier
      // line itself shows its backticks as sent (an ended line hides nothing).
      const open = continues && openParagraph ? unmatchedCodeSpan(openParagraph.source) : undefined;
      const after = open && openParagraph!.source[open.index + open.length];
      const prior = openParagraph?.block.children;
      const prefix = continues && prior
        ? [...prior, ...(prior.at(-1)?.type === "break" ? [] : [{ type: "text" as const, value: "\n" }])]
        : undefined;
      pendingInline = new PendingInline(
        parsePending,
        open && { marker: "`".repeat(open.length), leadingSpace: after === undefined || /\s/.test(after) },
        prefix,
      );
      pendingInlineState = {
        offset: classification.offset,
        lineLength: 0,
        continues,
        referenceCount: resolver.references.size,
        openCode: open && { source: openParagraph!.source, ...open },
        closer: open && { position: 0 },
      };
    }
    const state = pendingInlineState!;
    const currentLine = line.slice(state.offset);
    const lineLength = currentLine.length;
    let resolvedNow = false;
    const closer = state.closer;
    if (state.openCode && closer && closer.resolvedEnd === undefined) {
      const resolvedLine = resolver.pendingLeafContent;
      previewScannedCharacters += resolvedLine.length;
      const priorLength = resolvedLine.length - (currentLine.length - state.lineLength);
      previewScannedCharacters += scanExactCodeCloser(closer, resolvedLine, state.openCode.length, priorLength);
      if (closer.resolvedEnd !== undefined) {
        const end = closer.resolvedEnd;
        const resolvedPrefix = resolvedLine.slice(0, end);
        previewScannedCharacters += resolvedPrefix.length;
        const prefix = parsePending(`${state.openCode.source}\n${resolvedPrefix}`, true, true);
        state.resolvedSuffix = { prefix, start: end, nodes: prefix.slice() };
        const suffix = resolvedLine.slice(end);
        previewScannedCharacters += suffix.length;
        copiedCharacters += appendResolvedCodeSuffix(state.resolvedSuffix, suffix, () => suffix, parsePending);
        resolvedNow = true;
      }
    }
    previewScannedCharacters += lineLength - state.lineLength;
    if (state.resolvedSuffix) {
      if (!resolvedNow) {
        copiedCharacters += appendResolvedCodeSuffix(
          state.resolvedSuffix,
          currentLine.slice(state.lineLength),
          () => {
            const resolvedLine = resolver.pendingLeafContent;
            previewScannedCharacters += resolvedLine.length;
            const suffix = resolvedLine.slice(state.resolvedSuffix!.start);
            previewScannedCharacters += suffix.length;
            return suffix;
          },
          parsePending,
        );
      }
      state.lineLength = lineLength;
      return state.resolvedSuffix.nodes;
    }
    const inline = pendingInline!;
    const copied = inline.copiedCharacters;
    if (startsInline) inline.extend(currentLine);
    else inline.append(currentLine.slice(state.lineLength));
    state.lineLength = lineLength;
    copiedCharacters += inline.copiedCharacters - copied;
    return inline.nodes;
  };

  // A `\r` ends its line at once (alone or before `\n`, CommonMark treats both as a line end), so the line shows as
  // ended in the same frame; a `\n` that opens the next delta belongs to it and is dropped.
  const normalizeDelta = (delta: string) => {
    if (afterCarriageReturn && delta.startsWith("\n")) delta = delta.slice(1);
    afterCarriageReturn = delta.endsWith("\r");
    return delta.replace(/\r\n?/g, "\n");
  };

  return {
    get source() { return source; },
    get stats() { return { frozenParses, tailParses, scannedCharacters, previewScannedCharacters, copiedCharacters }; },
    append(delta) {
      if (finished || !delta) return;
      const normalized = normalizeDelta(delta);
      if (normalized) appendNormalized(normalized);
    },
    finish() {
      if (finished) return;
      const resolution = resolver.finish();
      if (resolution) apply(resolution);
      if (openCode) openCode.open = false;
      if (pendingReferenceApply) applyReferences();
      for (const record of allParagraphRecords) updateParagraph(record);
      freezeRoots();
      blocks.reset(parseMarkdown(source), true);
      finished = true;
    },
    render() {
      if (finished || pendingReferenceApply) return blocks.view;
      if (!resolver.pending.length && !resolver.hasPendingLookahead) {
        // A whole line grows the open blocks in place (a table row, a paragraph line, a list item), so the open path is
        // copied once per new text: a memoized view sees a new object for each block that changed.
        if (viewSource !== source) {
          viewSource = source;
          blocks.publish(cloneOpenPath(openRoots));
        }
        return blocks.view;
      }
      if (previewBlocks && previewSource === source) return previewBlocks;
      const pending = resolver.pending.content;
      const classification = resolver.classifyPending(pending);
      const overlay = cloneOpenPath(openRoots, Boolean(openParagraph || openCode || openTable));
      if (classification.kind === "fence" && openCode && !openIndentedCode) {
        const disposition = resolver.pendingFenceDisposition;
        if (disposition === "closes") closeOpenCode(overlay);
        else if (disposition === "none" && classification.offset < pending.length) appendOpenCode(overlay, classification.content);
      } else {
        const continuesParagraph = Boolean(openParagraph) && resolver.pendingContinuesParagraph(pending);
        // A backslash that ends the open paragraph waits while the next line is blank or only block markers: a line
        // that continues the paragraph makes it a hard break; any other line closes the paragraph, so it is text now.
        if (openParagraph && !continuesParagraph && !pendingMarkerLine(pending) && /(?<!\\)(?:\\\\)*\\$/.test(openParagraph.source)) {
          const paragraph = tailParagraph(overlay)!;
          const children = paragraph.children.at(-1)?.type === "break" ? paragraph.children.slice(0, -1) : paragraph.children;
          paragraph.children = [...children, { type: "text", value: "\\" }];
        }
        // Every growing line shows as sent: as the open table's next row, or as paragraph text inside the containers it
        // continues. A pipe in it is text until a delimiter row ends below it (the resolver's one table rule).
        const row = openTable && classification.kind === "paragraph" ? resolver.pendingTableRow : undefined;
        if (row === undefined || !appendPendingTableRow(overlay, row, environment())) {
          const parent = continuesParagraph || frames.length === 1 ? overlay : openChildren(overlay, frames, resolver.pendingContainerDepth);
          appendPendingParagraph(parent, pendingPreview(classification, continuesParagraph), continuesParagraph);
        }
      }
      previewSource = source;
      previewBlocks = [...Array.from(blocks.values()).slice(0, blocks.frozen), ...overlay];
      return previewBlocks;
    },
  };
}
