import type { Highlight } from "@fulcrum/highlight";
import MarkdownIt from "./vendor/markdown-it.mjs";

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

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });

const safeHref = (href: string | null) => {
  if (href === null) return undefined;
  const value = href.trim();
  const normalized = value.replace(/[\u0000-\u0020]/g, "");
  if (/^(https?:|mailto:)/i.test(normalized)) return value;
  if (!/^[a-z][a-z\d+.-]*:/i.test(normalized) && !/^[\\/]{2}/.test(normalized)) return value;
  return undefined;
};

const attr = (token: MarkdownToken, name: string) => token.attrGet(name) ?? undefined;

type InlineContainer = Extract<Inline, { children: Inline[] }>;
type InlineStack = Array<{ node: InlineContainer }>;

const inlineText = (node: Inline): string => node.type === "text" || node.type === "code"
  ? node.value
  : "children" in node ? node.children.map(inlineText).join("") : node.type === "image" ? node.alt : "";

function inlineContainer(token: MarkdownToken): InlineContainer | undefined {
  if (token.type === "em_open") return { type: "emphasis", children: [] };
  if (token.type === "strong_open") return { type: "strong", children: [] };
  if (token.type === "s_open") return { type: "strike", children: [] };
  if (token.type === "link_open") return { type: "link", href: safeHref(attr(token, "href") ?? null), title: attr(token, "title"), children: [] };
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
    target.push({ type: "image", src: safeHref(attr(token, "src") ?? null), title: attr(token, "title"), alt });
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

const codeSpanValue = (value: string) => {
  const normalized = value.replace(/\n/g, " ");
  return normalized.startsWith(" ") && normalized.endsWith(" ") && /[^ ]/.test(normalized)
    ? normalized.slice(1, -1)
    : normalized;
};

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
  const lines = source.split("\n");
  const tableDelimiter = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;
  const cellCount = (line: string) => line.split("|").filter((cell, index, cells) => cell.trim() || index > 0 && index < cells.length - 1).length;
  const delimiterIndex = lines.findIndex((line, index) => index > 0 && tableDelimiter.test(line) && cellCount(line) === cellCount(lines[index - 1]!));
  if (delimiterIndex < 0) {
    source = lines.map((line) => {
      if (!line.includes("|")) return line;
      if (/[:-]/.test(line) && /^\s*\|?\s*:?-*:?[ \t]*(?:\|[ \t]*:?-*:?[ \t]*)*\|?\s*$/.test(line)) return "";
      if (line.trimStart().startsWith("|") || line.split("|").length > 2)
        return line.split("|").map((cell) => cell.trim()).join("");
      return line;
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

function withoutOpenLink(source: string) {
  if (source.endsWith("!") && !source.endsWith("\\!")) source = source.slice(0, -1);
  const image = source.lastIndexOf("![");
  if (image >= 0 && !/\]\([^\n)]*\)/.test(source.slice(image + 1))) return source.slice(0, image);
  const bracket = source.lastIndexOf("[");
  if (bracket < 0) return source;
  const rest = source.slice(bracket + 1);
  const close = rest.indexOf("]");
  if (close < 0) return source.slice(0, bracket) + rest;
  const destination = rest.slice(close + 1);
  if (!destination) return source.slice(0, bracket) + rest.slice(0, close);
  if (!destination.startsWith("(")) return source;
  let depth = 0;
  for (const character of destination) {
    if (character === "(") depth++;
    else if (character === ")" && --depth === 0) return source;
  }
  return source.slice(0, bracket) + rest.slice(0, close);
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
  for (const run of source.matchAll(/(?:\*+|_+|~+)/g)) {
    if (run.index === undefined || codeRanges.some(([start, end]) => run.index! >= start && run.index! < end)) continue;
    const marker = run[0];
    const previous = source[run.index - 1];
    const next = source[run.index + marker.length];
    if (previous === "\\" || marker[0] === "_" && /[\p{L}\p{N}]/u.test(previous ?? "") && /[\p{L}\p{N}]/u.test(next ?? "")) continue;
    if (/\s/.test(next ?? "") && !/\S/.test(previous ?? "")) continue;
    const match = lastMarkerIndex(stack, marker);
    if (match >= 0 && /\S/.test(source.slice(stack[match]!.index + marker.length, run.index))) stack.splice(match, 1);
    else stack.push({ marker, index: run.index });
  }
  for (const { marker, index } of stack.sort((a, b) => b.index - a.index)) source = source.slice(0, index) + source.slice(index + marker.length);
  return source;
}

type SafeInlineContent = { source: string; openCode?: string };

// This is the only entry point for rendering unfinished inline markdown.
function safeInlineContent(source: string): SafeInlineContent {
  source = withoutOpenEmphasis(withoutOpenLink(withoutOpenAngle(source)));
  const opener = unmatchedCodeSpan(source);
  if (!opener) return { source };
  let content = source.slice(opener.index + opener.length);
  const trailingTicks = /`+$/.exec(content)?.[0];
  if (trailingTicks && trailingTicks.length < opener.length) content = content.slice(0, -trailingTicks.length);
  return { source: source.slice(0, opener.index), openCode: content || undefined };
}

function parseInline(source: string, streaming: boolean) {
  const safe = streaming ? safeInlineContent(source) : { source };
  const tokens = markdown.parseInline(safe.source, {});
  const nodes = inlineNodes(tokens[0]?.children ?? []);
  if (safe.openCode) nodes.push({ type: "code", value: codeSpanValue(safe.openCode) });
  return nodes;
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

  source = safeBlockSource(source);
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
  readonly stats: { readonly frozenParses: number; readonly tailParses: number };
  append(delta: string): void;
  finish(): void;
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

  freeze(blocks: Block[]) {
    for (const block of blocks) {
      let chunk = this.chunks.at(-1);
      if (!chunk || chunk.length === BLOCK_CHUNK_SIZE) this.chunks.push(chunk = []);
      chunk.push(block);
      this.frozenLength++;
    }
  }

  publish(blocks: Block[]) { this.open = blocks; }

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

type OpenParagraphState = {
  scannedOffset: number;
  pendingNewline: string;
  text: Extract<Inline, { type: "text" }>;
  block: Extract<Block, { type: "paragraph" }>;
};

type OpenListState = {
  ordered: boolean;
  scannedOffset: number;
  pending: string;
  hasPendingItem: boolean;
  block: ListBlock;
};

type OpenTableState = {
  header: string;
  delimiter: string;
  scannedOffset: number;
  pending: string;
  hasPendingRow: boolean;
  block: Extract<Block, { type: "table" }>;
};

type OpenFenceState = {
  marker: string;
  language?: string;
  scannedOffset: number;
  value: string;
  pending: string;
  block: Extract<Block, { type: "code" }>;
};

const fenceCloser = (marker: string, line: string) => new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(line);

function listItem(state: OpenListState, line: string) {
  const match = /^ {0,3}(?:[-+*]|\d{1,9}[.)])\s+(.+)$/.exec(line);
  if (match && !/[\\*_`~[\]<>!]/.test(match[1]!))
    return { children: [{ type: "paragraph", children: [{ type: "text", value: match[1]! }], tight: true }] } satisfies ListItem;
  const block = parseStreamingMarkdown(line)[0]?.block;
  return block?.type === "list" && block.ordered === state.ordered ? block.items[0] : undefined;
}

function appendListDelta(state: OpenListState, delta: string) {
  if (state.hasPendingItem) {
    state.block.items.pop();
    state.hasPendingItem = false;
  }
  const lines = `${state.pending}${delta}`.split("\n");
  state.pending = lines.pop()!;
  for (const line of lines) {
    if (!line.trim()) return false;
    const item = listItem(state, line);
    if (!item) return false;
    state.block.items.push(item);
  }
  if (state.pending) {
    const item = listItem(state, state.pending);
    if (item) {
      state.block.items.push(item);
      state.hasPendingItem = true;
    }
  }
  state.scannedOffset += delta.length;
  return true;
}

function tableRow(state: OpenTableState, line: string, streaming: boolean) {
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < line.length; index++) {
    const character = line[index]!;
    if (character === "\\" && line[index + 1] === "|") cell += line[++index]!;
    else if (character === "|") { cells.push(cell); cell = ""; }
    else cell += character;
  }
  cells.push(cell);
  if (!cells[0]!.trim()) cells.shift();
  if (!cells.at(-1)!.trim()) cells.pop();
  return Array.from({ length: state.block.header.length }, (_, index) => {
    const value = cells[index]?.trim() ?? "";
    if (!streaming && !/[\\*_`~[\]<>]/.test(value)) return value ? [{ type: "text", value } satisfies Inline] : [];
    return parseInline(value, streaming);
  });
}

function appendTableDelta(state: OpenTableState, delta: string) {
  if (state.hasPendingRow) {
    state.block.rows.pop();
    state.hasPendingRow = false;
  }
  const lines = `${state.pending}${delta}`.split("\n");
  state.pending = lines.pop()!;
  for (const line of lines) {
    if (!line.trim()) return false;
    const row = tableRow(state, line, false);
    if (row) state.block.rows.push(row);
  }
  if (state.pending) {
    const row = tableRow(state, state.pending, true);
    if (row) {
      state.block.rows.push(row);
      state.hasPendingRow = true;
    }
  }
  state.scannedOffset += delta.length;
  return true;
}

function appendFenceDelta(state: OpenFenceState, delta: string) {
  const lines = `${state.pending}${delta}`.split("\n");
  state.pending = lines.pop()!;
  for (const line of lines) {
    if (fenceCloser(state.marker, line)) return false;
    state.value += `${line}\n`;
  }
  if (fenceCloser(state.marker, state.pending)) return false;
  const possibleCloser = new RegExp(`^ {0,3}${state.marker[0]}{1,}\\s*$`).test(state.pending);
  state.block.value = state.value + (possibleCloser ? "" : state.pending);
  state.scannedOffset += delta.length;
  return true;
}

export function createStreamingDocument(): StreamingDocument {
  let source = "";
  let tailSource = "";
  let unrendered = "";
  const blocks = new BlockBuffer();
  const cached = blocks.view;
  let renderedSource = "";
  let finished = false;
  let frozenParses = 0;
  let tailParses = 0;
  let fenceState: OpenFenceState | undefined;
  let tableState: OpenTableState | undefined;
  let listState: OpenListState | undefined;
  let paragraphState: OpenParagraphState | undefined;
  const environment: Environment = {};

  const publishOpen = (open: Block[]) => {
    blocks.publish(open);
    unrendered = "";
    renderedSource = source;
    return cached;
  };

  const continueParagraph = () => {
    if (!paragraphState) return;
    const delta = unrendered;
    const next = paragraphState.pendingNewline + delta;
    if (/[\\*_`~[\]<>&!]/.test(delta) || next.includes("\n\n")) {
      paragraphState = undefined;
      return;
    }
    const pendingNewline = next.endsWith("\n") ? "\n" : "";
    const visible = pendingNewline ? next.slice(0, -1) : next;
    if (paragraphState.text.value.length + visible.length > 1024) {
      paragraphState.text = { type: "text", value: visible };
      paragraphState.block.children.push(paragraphState.text);
    } else paragraphState.text.value += visible;
    paragraphState.pendingNewline = pendingNewline;
    paragraphState.scannedOffset += delta.length;
    return openSnapshot(paragraphState.block);
  };

  const continueOpenBlock = () => {
    if (finished) return;
    const paragraph = continueParagraph();
    if (paragraph) return paragraph;
    if (listState) {
      if (appendListDelta(listState, unrendered)) return openSnapshot(listState.block);
      listState = undefined;
    }
    if (tableState) {
      if (appendTableDelta(tableState, unrendered)) return openSnapshot(tableState.block);
      tableState = undefined;
    }
    if (fenceState) {
      if (appendFenceDelta(fenceState, unrendered)) return openSnapshot(fenceState.block);
      fenceState = undefined;
    }
  };

  const startList = (tail: string) => {
    const match = /^( {0,3}(?:[-+*]|\d{1,9}[.)])\s+[^\n]+\n)/.exec(tail);
    if (!match) return;
    const initial = parseMarkdown(match[1]!)[0];
    if (initial?.type !== "list") return;
    const contentOffset = match[0].length;
    listState = { ordered: initial.ordered, scannedOffset: contentOffset, pending: "", hasPendingItem: false, block: initial };
    if (appendListDelta(listState, tailSource.slice(contentOffset))) return openSnapshot(initial);
    listState = undefined;
  };

  const startTable = (tail: string) => {
    const match = /^([^\n]*\|[^\n]*)\n(\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*)\n/.exec(tail);
    if (!match) return;
    const initial = parseMarkdown(`${match[1]}\n${match[2]}`)[0];
    if (initial?.type !== "table") return;
    const contentOffset = match[0].length;
    tableState = { header: match[1]!, delimiter: match[2]!, scannedOffset: contentOffset, pending: "", hasPendingRow: false, block: initial };
    if (appendTableDelta(tableState, tailSource.slice(contentOffset))) return openSnapshot(initial);
    tableState = undefined;
  };

  const startFence = (tail: string) => {
    const opener = /^ {0,3}(`{3,}|~{3,})([^\n]*)\n/.exec(tail);
    if (!opener) return;
    const contentOffset = opener[0].length;
    const block: Extract<Block, { type: "code" }> = {
      type: "code",
      language: opener[2]!.trim().split(/\s+/)[0] || undefined,
      value: "",
      open: true,
    };
    fenceState = { marker: opener[1]!, language: block.language, scannedOffset: contentOffset, value: "", pending: "", block };
    if (appendFenceDelta(fenceState, tailSource.slice(contentOffset))) return openSnapshot(block);
    fenceState = undefined;
  };

  const startParagraph = (tail: string) => {
    const paragraph = tail.replace(/^\n+/, "");
    if (!/\s/.test(paragraph) || /[\n]{2}|[\\*_`~[\]<>&|!]/.test(paragraph) || /^ {0,3}(?:#{1,6}|>|[-+*]|\d{1,9}[.)])(?:\s|$)/.test(paragraph)) return;
    const pendingNewline = paragraph.endsWith("\n") ? "\n" : "";
    const text: Extract<Inline, { type: "text" }> = { type: "text", value: pendingNewline ? paragraph.slice(0, -1) : paragraph };
    const block: Extract<Block, { type: "paragraph" }> = { type: "paragraph", children: [text] };
    paragraphState = { scannedOffset: tailSource.length, pendingNewline, text, block };
    return openSnapshot(block);
  };

  const startOpenBlock = (tail: string) => startList(tail) ?? startTable(tail) ?? startFence(tail) ?? startParagraph(tail);

  const commitFrozen = (frozen: Block[]) => blocks.freeze(frozen);

  const parseTail = (tail: string) => {
    const fence = !finished && openFence(tail);
    const parsed = finished
      ? parseDetailed(tail, { references: environment.references ? { ...environment.references } : undefined })
      : parseStreamingMarkdown(tail, { references: environment.references ? { ...environment.references } : undefined });
    tailParses++;
    let freezeCount = finished ? parsed.length : 0;
    if (!finished) for (let index = 0; index < parsed.length - 1; index++) {
      if (parsed[index + 1]!.map[0] > parsed[index]!.map[1]) freezeCount = index + 1;
    }
    if (!finished && !fence && parsed.length && parsed.at(-1)!.closed && parsed.at(-1)!.block.type === "code") freezeCount = parsed.length;
    return { parsed, freezeCount };
  };

  const freezeParsed = (tail: string, parsed: ParsedBlock[], freezeCount: number) => {
    if (!freezeCount) return;
    const endLine = parsed[freezeCount - 1]!.map[1];
    const offset = freezeCount === parsed.length ? tail.length : lineOffset(tail, endLine);
    if (offset <= 0) return;
    const committedEnvironment: Environment = { references: environment.references ? { ...environment.references } : undefined };
    const committedBlocks = parseDetailed(tail.slice(0, offset), committedEnvironment).map(({ block }) => block);
    environment.references = committedEnvironment.references;
    commitFrozen(committedBlocks);
    frozenParses++;
    tailSource = tailSource.slice(offset);
    const open = tailSource;
    return open ? (finished ? parseMarkdown(open) : parseStreamingMarkdown(open).map(({ block }) => block)) : [];
  };

  const render = () => {
    if (source === renderedSource) return cached;
    const continued = continueOpenBlock();
    if (continued) return publishOpen([continued]);
    const tail = tailSource;
    if (!finished) {
      const started = startOpenBlock(tail);
      if (started) return publishOpen([started]);
    }
    const { parsed, freezeCount } = parseTail(tail);
    const open = freezeParsed(tail, parsed, freezeCount);
    return publishOpen(open ?? parsed.map(({ block }) => block));
  };

  return {
    get source() { return source; },
    get stats() { return { frozenParses, tailParses }; },
    append(delta) {
      if (finished) throw new Error("cannot append to a finished markdown document");
      source += delta;
      tailSource += delta;
      unrendered += delta;
    },
    finish() { finished = true; renderedSource = ""; },
    render,
  };
}
