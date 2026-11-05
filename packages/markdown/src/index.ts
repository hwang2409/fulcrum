import { safeUrl } from "@fulcrum/core";
import type { Highlight } from "@fulcrum/highlight";
import { delimiterRun } from "./delimiters.js";
import MarkdownIt from "./vendor/markdown-it.mjs";
import { PendingInline } from "./pending-inline.js";
import { MarkdownLineResolver, type LineResolution, type OpenedContainer, type ReferenceDefinition } from "./resolver.js";

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
type PendingInlineState = {
  offset: number;
  lineLength: number;
  continues: boolean;
  tableCandidate: boolean;
  referenceCount: number;
};

const pendingTableCandidate = (line: string, offset: number, continues: boolean, settled: boolean) => {
  if (!continues || settled) return false;
  while (line[offset] === " " || line[offset] === "\t") offset++;
  return line[offset] === "|";
};

const pendingInlineMatches = (state: PendingInlineState | undefined, offset: number, continues: boolean, tableCandidate: boolean, referenceCount: number) =>
  state?.offset === offset && state.continues === continues && state.tableCandidate === tableCandidate && state.referenceCount === referenceCount;

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });

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

const openFence = (source: string) => {
  const lines = source.split("\n");
  let marker: string | undefined;
  for (const line of lines) {
    if (!marker) marker = /^ {0,3}(`{3,}|~{3,})(?!.*`.*`)/.exec(line)?.[1];
    else if (new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(line)) marker = undefined;
  }
  return marker;
};

const unmatchedCodeSpan = (source: string) => {
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

// An open span's edge spaces hide: the closer may strip them, and a space that shows must never disappear.
const codeSpanValue = (value: string) => value.replace(/\n/g, " ").replace(/^ | $/g, "");

function tailInline(blocks: Block[]): Inline[] | undefined {
  const last = blocks.at(-1);
  if (last?.type === "paragraph" || last?.type === "heading") return last.children;
  if (last?.type === "list") return tailInline(last.items.at(-1)?.children ?? []);
  if (last?.type === "blockquote") return tailInline(last.children);
  return undefined;
}

function tailCode(blocks: Block[]): Extract<Block, { type: "code" }> | undefined {
  const last = blocks.at(-1);
  if (last?.type === "code") return last;
  if (last?.type === "list") return tailCode(last.items.at(-1)?.children ?? []);
  if (last?.type === "blockquote") return tailCode(last.children);
  return undefined;
}

function appendOpenCodeSpan(blocks: Block[], value: string) {
  const code: Inline = { type: "code", value: codeSpanValue(value) };
  const inline = tailInline(blocks);
  if (inline) inline.push(code);
  else blocks.push({ type: "paragraph", children: [code] });
}

function safeBlockPass(source: string) {
  const rawLines = source.split("\n");
  let listIndent = 0;
  const lines = rawLines.map((raw) => {
    let prefix = /^ {0,3}(?:> ?)+/.exec(raw)?.[0] ?? "";
    let content = raw.slice(prefix.length);
    if (listIndent && new RegExp(`^ {${listIndent}}`).test(content)) {
      prefix += content.slice(0, listIndent);
      content = content.slice(listIndent);
    }
    const marker = /^ {0,3}(?:[-+*]|\d{1,9}[.)])\s+/.exec(content)?.[0];
    if (marker) {
      prefix += marker;
      content = content.slice(marker.length);
      listIndent += marker.length;
    }
    return { prefix, content };
  });
  const tableDelimiter = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;
  const cellCount = (line: string) => line.split("|").filter((cell, index, cells) => cell.trim() || index > 0 && index < cells.length - 1).length;
  const delimiterIndex = lines.findIndex((line, index) => index > 0 && tableDelimiter.test(line.content) && cellCount(line.content) === cellCount(lines[index - 1]!.content));
  if (delimiterIndex < 0) {
    source = lines.map(({ prefix, content }) => {
      if (!content.includes("|")) return prefix + content;
      if (/[:-]/.test(content) && /^\s*\|?\s*:?-*:?[ \t]*(?:\|[ \t]*:?-*:?[ \t]*)*\|?\s*$/.test(content)) return "";
      if (content.trimStart().startsWith("|") || content.split("|").length > 2)
        return prefix + content.split("|").map((cell) => cell.trim()).join("");
      return prefix + content;
    }).join("\n");
  }
  const lineStart = source.lastIndexOf("\n") + 1;
  const line = source.slice(lineStart);
  if (/^ {0,3}[-+*]\s+\[[ xX]?\]?\s*$/.test(line)) return source.slice(0, lineStart);
  if (/^ {0,3}(?:#{1,6}|>|[-+*]|\d{1,9}[.)]?)\s*$/.test(line)) return source.slice(0, lineStart);
  if (/^ {0,3}(?:`{1,2}(?!`)|~{1,2}(?!~))[^\n]*$/.test(line)) return source.slice(0, lineStart);
  if (/[:-]/.test(line) && /^\s*\|?\s*:?-*:?[ \t]*(?:\|[ \t]*:?-*:?[ \t]*)*\|?\s*$/.test(line)) return source.slice(0, lineStart);
  return source;
}

function safeBlockSource(source: string) {
  for (;;) {
    const next = safeBlockPass(source);
    if (next === source) return source;
    source = next;
  }
}

function withoutOpenAngle(source: string) {
  const angle = source.lastIndexOf("<");
  return angle > source.lastIndexOf(">") && !/[\s\n]/.test(source.slice(angle + 1)) ? source.slice(0, angle) : source;
}

const escaped = (source: string, index: number) => {
  let escapes = 0;
  for (let at = index - 1; at >= 0 && source[at] === "\\"; at--) escapes++;
  return escapes % 2 === 1;
};

// The last `marker` that a backslash does not escape, or -1.
const lastUnescaped = (source: string, marker: string) => {
  let index = source.lastIndexOf(marker);
  while (index >= 0 && escaped(source, index)) index = index === 0 ? -1 : source.lastIndexOf(marker, index - 1);
  return index;
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

function withoutOpenLink(source: string) {
  if (source.endsWith("!") && !escaped(source, source.length - 1)) source = source.slice(0, -1);
  const image = lastUnescaped(source, "![");
  if (image >= 0 && !/\]\([^\n)]*\)/.test(source.slice(image + 1))) return source.slice(0, image);
  const marks = bracketMarks(source);
  let last = marks.length - 1;
  while (last >= 0 && source[marks[last]!] !== "[") last--;
  const bracket = last < 0 ? -1 : marks[last]!;
  if (bracket < 0) return source;
  const rest = source.slice(bracket + 1);
  const close = (marks[last + 1] ?? 0) - bracket - 1;
  // The label of a trailing `[text][label` is never shown; plain open text stays visible.
  const label = source[bracket - 1] === "]";
  if (close < 0) return source.slice(0, bracket) + (label ? "" : rest);
  const destination = rest.slice(close + 1);
  if (!destination) return source.slice(0, bracket) + (label ? "" : rest.slice(0, close));
  return !destination.startsWith("(") || closesDestination(destination) ? source : source.slice(0, bracket) + rest.slice(0, close);
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

function withoutOpenEmphasis(source: string) {
  const codeRanges = closedCodeRanges(source);
  const stack: Array<{ marker: string; index: number }> = [];
  // Runs and code ranges both ascend, so one cursor keeps the scan linear.
  let range = 0;
  for (const run of source.matchAll(/(?:\*+|_+|~+)/g)) {
    if (run.index === undefined) continue;
    while (range < codeRanges.length && codeRanges[range]![1] <= run.index) range++;
    if (range < codeRanges.length && run.index >= codeRanges[range]![0]) continue;
    const marker = run[0];
    if (source[run.index - 1] === "\\") continue;
    const { canOpen, canClose } = delimiterRun(source, run.index, marker.length);
    const match = canClose ? lastMarkerIndex(stack, marker) : -1;
    if (match >= 0) stack.splice(match, 1);
    // A run at the end can still grow into another run, so it stays hidden.
    else if (canOpen || run.index + marker.length === source.length) stack.push({ marker, index: run.index });
  }
  if (!stack.length) return source;
  const pieces: string[] = [];
  let offset = 0;
  for (const { marker, index } of stack.sort((a, b) => a.index - b.index)) {
    pieces.push(source.slice(offset, index));
    offset = index + marker.length;
  }
  pieces.push(source.slice(offset));
  return pieces.join("");
}

type SafeInlineContent = { source: string; openCode?: string };

// This is the only entry point for rendering unfinished inline markdown.
function withoutTrailingLookahead(source: string) {
  const backslashes = /\\+$/.exec(source)?.[0].length ?? 0;
  if (backslashes % 2) return source.slice(0, -1);
  const entity = /&(?:#(?:x[0-9a-f]*|[0-9]*)?|[a-z][a-z0-9]*)?$/i.exec(source);
  return entity ? source.slice(0, entity.index) : source;
}

const withoutOpenSyntax = (source: string) => withoutTrailingLookahead(withoutOpenEmphasis(withoutOpenLink(withoutOpenAngle(source))));

function safeInlineContent(source: string): SafeInlineContent {
  source = withoutOpenSyntax(source);
  const opener = unmatchedCodeSpan(source);
  if (!opener) return { source };
  let content = source.slice(opener.index + opener.length);
  const trailingTicks = /`+$/.exec(content)?.[0];
  if (trailingTicks && trailingTicks.length < opener.length) content = content.slice(0, -trailingTicks.length);
  return { source: source.slice(0, opener.index), openCode: content || undefined };
}

function parseInline(source: string, streaming: boolean, environment: Environment = {}) {
  const safe = streaming ? safeInlineContent(source) : { source };
  const tokens = markdown.parseInline(safe.source, environment);
  const nodes = inlineNodes(tokens[0]?.children ?? []);
  // An unclosed span may stay literal, so its preview shows only the text its content renders as markdown.
  if (safe.openCode) {
    const literal = inlineNodes(markdown.parseInline(withoutOpenSyntax(safe.openCode), environment)[0]?.children ?? []);
    // Its brackets hide: as literal text they may still become a link or a reference.
    nodes.push({ type: "code", value: codeSpanValue(literal.map(inlineText).join("")).replace(/[[\]]/g, "") });
  }
  return nodes;
}

function withoutPendingReferenceDefinition(source: string, environment: Environment) {
  const lineStart = source.lastIndexOf("\n") + 1;
  const line = source.slice(lineStart);
  if (!/^ {0,3}\[[^\]\n]+\]:[^\n]*$/.test(line)) return source;
  const probe: Environment = { references: environment.references ? { ...environment.references } : undefined };
  if (parseDetailed(`${line}\n`, probe).length === 0 && Object.keys(probe.references ?? {}).length > Object.keys(environment.references ?? {}).length) return source;
  return source.slice(0, lineStart);
}

function parseStreamingMarkdown(source: string, environment: Environment = {}): ParsedBlock[] {
  const fence = openFence(source);
  if (fence) {
    const opener = source.lastIndexOf(fence);
    const contentStart = source.indexOf("\n", opener);
    if (contentStart < 0 || contentStart === source.length - 1) return parseDetailed(source.slice(0, opener), environment);
    const parsed = parseDetailed(source, environment);
    const last = tailCode(parsed.map(({ block }) => block));
    if (last) {
      last.open = true;
      const partialCloser = new RegExp(`(?:^|\\n) {0,3}${fence[0]}{1,${fence.length - 1}}$`).exec(last.value);
      if (partialCloser) last.value = last.value.slice(0, partialCloser.index + (partialCloser[0].startsWith("\n") ? 1 : 0));
    }
    return parsed;
  }

  source = safeBlockSource(withoutPendingReferenceDefinition(source, environment));
  const safe = safeInlineContent(source);
  const parsed = parseDetailed(safe.source, environment);
  if (!safe.openCode) return parsed;
  const blocks = parsed.map(({ block }) => block);
  const whitespace = /[ \t]+$/.exec(safe.source)?.[0];
  const inline = tailInline(blocks);
  if (whitespace && inline) inline.push({ type: "text", value: whitespace });
  appendOpenCodeSpan(blocks, safe.openCode);
  return blocks.map((block) => ({ block, map: [0, 0], closed: false }));
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
  /** The last line has pipes that stay hidden only while it is the last line. */
  lastLinePipes?: boolean;
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

const normalizeReferenceLabel = (label: string) => label.trim().replace(/\s+/g, " ").toUpperCase();

// The open paragraph's last line can still become a table header, which turns its pipes into cell borders.
function hideTableCandidatePipes(inlines: Inline[]) {
  for (let index = inlines.length - 1; index >= 0; index--) {
    const inline = inlines[index]!;
    if (inline.type === "break") return;
    if ("children" in inline) hideTableCandidatePipes(inline.children);
    // A header row splits cells before inline parsing, so a pipe inside a code span is a border too.
    if (inline.type === "code") inline.value = inline.value.replace(/\|/g, "");
    if (inline.type !== "text") continue;
    const lineStart = inline.value.lastIndexOf("\n") + 1;
    const line = inline.value.slice(lineStart).replace(/[ \t]*\|[ \t]*/g, "");
    // A last line of only pipes may become a table header, so its line break waits too.
    inline.value = (line || index < inlines.length - 1 ? inline.value.slice(0, lineStart) : inline.value.slice(0, Math.max(0, lineStart - 1))) + line;
    if (lineStart) return;
  }
}

// The text of `value` with each `[label]` that may still become a reference reduced to its link text.
function pendingReferenceParts(value: string, labels?: ReadonlySet<string>): Inline[] {
  const parts: Inline[] = [];
  let offset = 0;
  for (const match of value.matchAll(/!?\[([^[\]\n]+)\](?:\[([^[\]\n]*)\])?/g)) {
    if (match.index > 0 && value[match.index - 1] === "\\") continue;
    if (labels && !labels.has(normalizeReferenceLabel(match[2] || match[1]!))) continue;
    if (match.index > offset) parts.push({ type: "text", value: value.slice(offset, match.index) });
    if (!match[0].startsWith("!")) parts.push({ type: "text", value: match[1]! });
    offset = match.index + match[0].length;
  }
  if (parts.length && offset < value.length) parts.push({ type: "text", value: value.slice(offset) });
  return parts;
}

// `labels`, when given, are the unresolved labels of the parsed source; escaped brackets are not among them.
function markPendingReferences(inlines: Inline[], labels?: ReadonlySet<string>) {
  for (let index = 0; index < inlines.length; index++) {
    const node = inlines[index]!;
    if ("children" in node) markPendingReferences(node.children, labels);
    const parts = node.type === "text" && node.value.includes("[") ? pendingReferenceParts(node.value, labels) : [];
    if (!parts.length) continue;
    inlines.splice(index, 1, ...parts);
    index += parts.length - 1;
  }
}

// Labels of every unescaped `[label]` in `source`; parsed text has lost its escapes, so they are read here.
const bracketLabels = (source: string) => !source.includes("[") ? new Set<string>() : new Set(Array.from(source.matchAll(/(?<!(?<!\\)(?:\\\\)*\\)\[([^[\]\n]+)\]/g), (match) => normalizeReferenceLabel(match[1]!)));

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

function clearTightParagraphs(blocks: Block[]) {
  for (const block of blocks) {
    if (block.type === "paragraph") block.tight = undefined;
    else if (block.type === "blockquote") clearTightParagraphs(block.children);
    else if (block.type === "list") for (const item of block.items) clearTightParagraphs(item.children);
  }
}

function tableCells(line: string) {
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < line.length; index++) {
    if (line[index] === "\\" && line[index + 1] === "|") cell += line[++index]!;
    else if (line[index] === "|") { cells.push(cell); cell = ""; }
    else cell += line[index];
  }
  cells.push(cell);
  if (!cells[0]?.trim()) cells.shift();
  if (!cells.at(-1)?.trim()) cells.pop();
  return cells;
}

function pendingLeafContent(line: string) {
  for (;;) {
    const marker = /^[ \t]*(?:> ?|(?:[-+*]|\d{1,9}[.)])[ \t]+)/.exec(line)?.[0];
    if (!marker) return line;
    line = line.slice(marker.length);
  }
}

const canContinueReferenceTitle = (line: string) => /^ {0,3}\[[^\]\n]+\]:[ \t]*(?:<[^>\n]+>|\S+)[ \t]*$/.test(pendingLeafContent(line));
const hasInlineReferenceTitle = (line: string) => /[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\))[ \t]*$/.test(line);

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

const tableDelimiterLine = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

function safeTableText(value: string) {
  return value.split("\n").filter((line) => !(line.includes("|") && tableDelimiterLine.test(line))).join("\n").replaceAll("|", "");
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
  const row = Array.from({ length: table.header.length }, (_, index) => parseInline(cells[index]?.trim() ?? "", true, references));
  row.forEach((cell) => markPendingReferences(cell));
  table.rows = [...table.rows, row];
  return true;
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

function hideOpenInlineLink(value: string) {
  const match = /(!?)\[([^\]\n]*)\]\(/g;
  let open: RegExpExecArray | null = null;
  for (let next = match.exec(value); next; next = match.exec(value)) open = next;
  if (!open) return value;
  const suffix = value.slice(open.index + open[0].length);
  let depth = 1;
  for (const character of suffix) depth += character === "(" ? 1 : character === ")" ? -1 : 0;
  return depth > 0 ? value.slice(0, open.index) + (open[1] ? "" : open[2]) : value;
}

function containsTable(blocks: readonly Block[]): boolean {
  return blocks.some((block) => block.type === "table"
    || block.type === "blockquote" && containsTable(block.children)
    || block.type === "list" && block.items.some((item) => containsTable(item.children)));
}

function hideTableSyntax(blocks: Block[]) {
  const inline = (nodes: Inline[], table = false) => nodes.forEach((node) => {
    if (node.type === "text") node.value = table ? safeTableText(node.value).replace(/[\[\]]/g, "") : safeTableText(node.value);
    else if ("children" in node) inline(node.children, table);
  });
  const visit = (items: Block[]) => items.forEach((block) => {
    if (block.type === "blockquote") visit(block.children);
    else if (block.type === "list") block.items.forEach((item) => visit(item.children));
    else if (block.type === "table") {
      block.header.forEach((cell) => inline(cell, true));
      block.rows.forEach((row) => row.forEach((cell) => inline(cell, true)));
    }
  });
  visit(blocks);
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
  let referenceCandidateScannedCharacters = 0;
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
  let pendingReferenceApply = false;
  let trailingCarriageReturn = false;
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

  const updateParagraph = (record: ParagraphRecord, streaming = false, pendingReferences = true, committed?: Inline[]) => {
    unregister(record);
    if (committed) {
      record.block.children = committed;
      registerReferences(record);
      tailParses++;
      return;
    }
    const classified = streaming && !record.source.includes("\n") ? resolver.classifyCommitted(record.source) : undefined;
    let inlineSource = classified?.kind === "paragraph" ? classified.content : record.source;
    if (streaming && inlineSource.endsWith("\\")) inlineSource = inlineSource.slice(0, -1);
    record.block.children = /[\\[*_~`<!&]/.test(inlineSource)
      ? parseInline(inlineSource, streaming, environment())
      : [{ type: "text", value: inlineSource }];
    if (pendingReferences) markPendingReferences(record.block.children, bracketLabels(inlineSource));
    if (streaming) hideTableCandidatePipes(record.block.children);
    registerReferences(record);
    tailParses++;
  };

  const createParagraph = (content: string) => {
    const lists = frames.filter((frame): frame is Extract<TreeFrame, { kind: "list" }> => frame.kind === "list");
    const block: Extract<Block, { type: "paragraph" }> = {
      type: "paragraph",
      children: [],
      tight: lists.length && !lists.some((frame) => looseLists.has(frame.block)) || undefined,
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
    const record: ParagraphRecord = { block, source: content, labels: new Set(), lastLinePipes: content.includes("|") };
    // The growing line already holds stable nodes for this text; only its unresolved tail is parsed again.
    updateParagraph(record, true, true, pendingInline?.commit(content));
    paragraphRecords.set(block, record);
    allParagraphRecords.add(record);
    appendBlock(block);
    return record;
  };

  const appendParagraphLine = (record: ParagraphRecord, content: string) => {
    const addition = `\n${content}`;
    record.source += addition;
    const child = record.block.children.length === 1 ? record.block.children[0] : undefined;
    if (child?.type === "text" && !record.lastLinePipes && !/[\\&<>*_~`\[\]|]/.test(content)) child.value += addition;
    else updateParagraph(record, true);
    record.lastLinePipes = content.includes("|");
  };

  const updateTableCell = (record: TableCellRecord) => {
    unregister(record);
    const children = parseInline(record.source, false, environment());
    markPendingReferences(children);
    if (record.header) record.table.header[record.column] = children;
    else record.table.rows[record.row]![record.column] = children;
    registerReferences(record);
    tailParses++;
  };

  const createTableCell = (table: TableBlock, source: string, header: boolean, row: number, column: number) => {
    const record: TableCellRecord = { table, source, header, row, column, labels: new Set() };
    const children = header ? table.header[column] : table.rows[row]?.[column];
    if (children) markPendingReferences(children);
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
        unregister(record);
        const headerCells = tableCells(record.source);
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
        children[children.length - 1] = table;
        const tableRecord: TableRecord = { header: record.source, delimiter: leaf.content, cells: [] };
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
      pendingReferenceApply = !hasInlineReferenceTitle(leaf.content);
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
        if (pendingReferenceDefinition(leaf.content, false))
          openParagraph.block.children = [{ type: "pending-reference", value: "" }];
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

  const parsePending = (source: string, streaming: boolean) => {
    const nodes = parseInline(source, streaming, environment());
    markPendingReferences(nodes, bracketLabels(source));
    hideTableCandidatePipes(nodes);
    return nodes.filter((node) => node.type !== "text" || node.value);
  };

  // A definition-shaped line is held until its line ending decides whether it is metadata or prose.
  type ReferenceCandidateState = {
    prefixLength: number;
    position: number;
    labelLength: number;
    escaped: boolean;
    phase: "start" | "label" | "after-label" | "held";
    candidate: boolean;
  };
  let referenceCandidateState: ReferenceCandidateState | undefined;
  const pendingReferenceCandidate = (line: string, continues: boolean) => {
    if (continues) return false;
    const content = pendingLeafContent(line);
    const prefixLength = line.length - content.length;
    let state = referenceCandidateState;
    if (!state || state.prefixLength !== prefixLength || state.position > content.length) {
      state = referenceCandidateState = {
        prefixLength,
        position: 0,
        labelLength: 0,
        escaped: false,
        phase: "start",
        candidate: true,
      };
    }
    if (!state.candidate) return false;
    while (state.position < content.length) {
      if (state.phase === "held") return true;
      const character = content[state.position++]!;
      referenceCandidateScannedCharacters++;
      if (state.phase === "start") {
        if (/\s/.test(character)) continue;
        if (character !== "[") return state.candidate = false;
        state.phase = "label";
        continue;
      }
      if (state.phase === "label") {
        if (state.escaped) {
          state.escaped = false;
          if (++state.labelLength > 999) return state.candidate = false;
        } else if (character === "\\") state.escaped = true;
        else if (character === "]") state.phase = "after-label";
        else if (++state.labelLength > 999) return state.candidate = false;
        continue;
      }
      if (character !== ":") return state.candidate = false;
      state.phase = "held";
      return true;
    }
    return true;
  };
  const pendingReferenceDefinition = (line: string, continues: boolean) =>
    pendingReferenceCandidate(line, continues) && /^\s*\[(?:\\.|[^\\\]\n])+\]:/.test(pendingLeafContent(line));

  const startPendingInline = (classification: Readonly<ReturnType<MarkdownLineResolver["classifyPending"]>>, continues: boolean, tableCandidate: boolean) => {
    // A code span an earlier line left open may close on this line, as the paragraph parse will pair it.
    const open = continues && openParagraph ? unmatchedCodeSpan(openParagraph.source) : undefined;
    const after = open && openParagraph!.source[open.index + open.length];
    const prefix = continues && openParagraph
      ? [...openParagraph.block.children, { type: tableCandidate ? "pending-reference" as const : "text" as const, value: "\n" }]
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
      tableCandidate,
      referenceCount: resolver.references.size,
    };
  };

  const pendingPreview = (classification: Readonly<ReturnType<MarkdownLineResolver["classifyPending"]>>, continues: boolean): Inline[] => {
    const line = resolver.pending.content;
    if (classification.kind !== "paragraph") return [];
    const tableCandidate = pendingTableCandidate(line, classification.offset, continues, resolver.pendingStartsWithSettledProse);
    const startsInline = !pendingInline || !pendingInlineMatches(pendingInlineState, classification.offset, continues, tableCandidate, resolver.references.size);
    if (startsInline) startPendingInline(classification, continues, tableCandidate);
    const inline = pendingInline!;
    const copied = inline.copiedCharacters;
    const state = pendingInlineState!;
    const lineLength = line.length - state.offset;
    previewScannedCharacters += lineLength - state.lineLength;
    if (startsInline) inline.extend(line.slice(state.offset));
    else inline.append(line.slice(state.offset + state.lineLength));
    state.lineLength = lineLength;
    copiedCharacters += inline.copiedCharacters - copied;
    return inline.nodes;
  };

  const normalizeDelta = (delta: string) => {
    if (trailingCarriageReturn) {
      delta = delta.startsWith("\n") ? delta : `\n${delta}`;
      trailingCarriageReturn = false;
    }
    if (delta.endsWith("\r")) {
      delta = delta.slice(0, -1);
      trailingCarriageReturn = true;
    }
    return delta.replace(/\r\n?/g, "\n");
  };

  return {
    get source() { return source; },
    get stats() { return { frozenParses, tailParses, scannedCharacters, previewScannedCharacters, copiedCharacters, referenceCandidateScannedCharacters }; },
    append(delta) {
      if (finished || !delta) return;
      const normalized = normalizeDelta(delta);
      if (normalized) appendNormalized(normalized);
    },
    finish() {
      if (finished) return;
      if (trailingCarriageReturn) {
        trailingCarriageReturn = false;
        appendNormalized("\n");
      }
      const resolution = resolver.finish();
      if (resolution) apply(resolution);
      if (openCode) openCode.open = false;
      if (pendingReferenceApply) applyReferences();
      for (const record of allParagraphRecords) updateParagraph(record, false, false);
      freezeRoots();
      blocks.reset(parseMarkdown(source), true);
      finished = true;
    },
    render() {
      if (finished || pendingReferenceApply || !resolver.pending.length && !resolver.hasPendingLookahead) return blocks.view;
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
        const startsBlock = openParagraph ? !continuesParagraph : /^[ \t]*(?:> ?|(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)|#{1,6}(?:[ \t]+|$)|`{3,}|~{3,}|<)/.test(pending);
        if (!(openTable && !startsBlock && classification.kind === "paragraph" && classification.offset < pending.length && appendPendingTableRow(overlay, resolver.pendingLeafContent, environment())))
          appendPendingParagraph(overlay, pendingReferenceCandidate(pending, continuesParagraph) ? [] : pendingPreview(classification, continuesParagraph), continuesParagraph);
      }
      previewSource = source;
      previewBlocks = [...Array.from(blocks.values()).slice(0, blocks.frozen), ...overlay];
      return previewBlocks;
    },
  };
}
