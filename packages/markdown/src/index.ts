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
type ParserWork = { frozenParses: number; tailParses: number; scannedCharacters: number };

const scanned = (work: ParserWork | undefined, length: number) => {
  if (work) work.scannedCharacters += length;
};

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

const inlineText = (node: Inline): string => node.type === "text" || node.type === "pending-reference" || node.type === "code"
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

function parseDetailed(source: string, environment: Environment = {}, work?: ParserWork): ParsedBlock[] {
  scanned(work, source.length);
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
  if (/^ {0,3}(?:[-*_]\s*)+$/.test(line)) return source.slice(0, lineStart);
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
function withoutTrailingLookahead(source: string) {
  const backslashes = /\\+$/.exec(source)?.[0].length ?? 0;
  if (backslashes % 2) return source.slice(0, -1);
  const entity = /&(?:#(?:x[0-9a-f]*|[0-9]*)?|[a-z][a-z0-9]*)?$/i.exec(source);
  return entity ? source.slice(0, entity.index) : source;
}

function safeInlineContent(source: string): SafeInlineContent {
  source = withoutTrailingLookahead(withoutOpenEmphasis(withoutOpenLink(withoutOpenAngle(source))));
  const opener = unmatchedCodeSpan(source);
  if (!opener) return { source };
  let content = source.slice(opener.index + opener.length);
  const trailingTicks = /`+$/.exec(content)?.[0];
  if (trailingTicks && trailingTicks.length < opener.length) content = content.slice(0, -trailingTicks.length);
  return { source: source.slice(0, opener.index), openCode: content || undefined };
}

function parseInline(source: string, streaming: boolean, work?: ParserWork) {
  scanned(work, source.length);
  const safe = streaming ? safeInlineContent(source) : { source };
  const tokens = markdown.parseInline(safe.source, {});
  const nodes = inlineNodes(tokens[0]?.children ?? []);
  if (safe.openCode) nodes.push({ type: "code", value: codeSpanValue(safe.openCode) });
  return nodes;
}

function withoutPendingReferenceDefinition(source: string, environment: Environment, work?: ParserWork) {
  const lineStart = source.lastIndexOf("\n") + 1;
  const line = source.slice(lineStart);
  if (!/^ {0,3}\[[^\]\n]+\]:[^\n]*$/.test(line)) return source;
  const probe: Environment = { references: environment.references ? { ...environment.references } : undefined };
  if (parseDetailed(`${line}\n`, probe, work).length === 0 && Object.keys(probe.references ?? {}).length > Object.keys(environment.references ?? {}).length) return source;
  return source.slice(0, lineStart);
}

function parseStreamingMarkdown(source: string, environment: Environment = {}, work?: ParserWork): ParsedBlock[] {
  scanned(work, source.length);
  const fence = openFence(source);
  if (fence) {
    const opener = source.lastIndexOf(fence);
    const contentStart = source.indexOf("\n", opener);
    if (contentStart < 0 || contentStart === source.length - 1) return parseDetailed(source.slice(0, opener), environment, work);
    const parsed = parseDetailed(source, environment, work);
    const last = tailCode(parsed.map(({ block }) => block));
    if (last) {
      last.open = true;
      const partialCloser = new RegExp(`(?:^|\\n) {0,3}${fence[0]}{1,${fence.length - 1}}$`).exec(last.value);
      if (partialCloser) last.value = last.value.slice(0, partialCloser.index + (partialCloser[0].startsWith("\n") ? 1 : 0));
    }
    return parsed;
  }

  source = safeBlockSource(withoutPendingReferenceDefinition(source, environment, work));
  const safe = safeInlineContent(source);
  const parsed = parseDetailed(safe.source, environment, work);
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
  readonly stats: { readonly frozenParses: number; readonly tailParses: number; readonly scannedCharacters: number };
  append(delta: string): void;
  finish(): void;
  render(): readonly Block[];
}

const lineOffset = (source: string, line: number, work?: ParserWork) => {
  let offset = 0;
  for (let current = 0; current < line; current++) {
    const next = source.indexOf("\n", offset);
    if (next < 0) {
      scanned(work, source.length);
      return source.length;
    }
    offset = next + 1;
  }
  scanned(work, offset);
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

class ListItemBuffer {
  readonly view: ListItem[];
  private readonly chunks: ListItem[][] = [];
  private itemCount = 0;

  constructor(items: ListItem[]) {
    const target: ListItem[] = [];
    this.view = new Proxy(target, {
      get: (_target, property, receiver) => {
        if (property === "length") return this.itemCount;
        if (property === "map") return this.map.bind(this);
        if (property === "at") return this.at.bind(this);
        if (property === Symbol.iterator) return this.values.bind(this);
        if (typeof property === "string" && /^\d+$/.test(property)) return this.at(Number(property));
        return Reflect.get(target, property, receiver);
      },
    });
    for (const item of items) this.push(item);
  }

  push(item: ListItem) {
    let chunk = this.chunks.at(-1);
    if (!chunk || chunk.length === BLOCK_CHUNK_SIZE) this.chunks.push(chunk = []);
    chunk.push(item);
    this.itemCount++;
  }

  pop() {
    if (!this.itemCount) return;
    const chunk = this.chunks.at(-1)!;
    const item = chunk.pop();
    this.itemCount--;
    if (!chunk.length) this.chunks.pop();
    return item;
  }

  at(index: number) {
    if (index < 0) index += this.itemCount;
    if (index < 0 || index >= this.itemCount) return undefined;
    return this.chunks[Math.floor(index / BLOCK_CHUNK_SIZE)]![index % BLOCK_CHUNK_SIZE];
  }

  map<Result>(callback: (item: ListItem, index: number, items: ListItem[]) => Result) {
    const result: Result[] = [];
    for (let index = 0; index < this.itemCount; index++) result.push(callback(this.at(index)!, index, this.view));
    return result;
  }

  *values() {
    for (const chunk of this.chunks) yield* chunk;
  }
}

type OpenParagraphState = {
  scannedOffset: number;
  pendingNewline: string;
  text: Extract<Inline, { type: "text" }>;
  block: Extract<Block, { type: "paragraph" }>;
};

type ContainerChild = { document: StreamingDocument; item?: ListItem };

type OpenContainerState = {
  kind: "quote" | "list";
  work: ParserWork;
  scannedOffset: number;
  pending: string;
  previousBlank: boolean;
  children: ContainerChild[];
  block: Extract<Block, { type: "blockquote" }> | ListBlock;
  ordered?: boolean;
  contentIndent?: number;
  items?: ListItemBuffer;
};

type OpenTableState = {
  work: ParserWork;
  header: string;
  delimiter: string;
  scannedOffset: number;
  pending: string;
  hasPendingRow: boolean;
  block: Extract<Block, { type: "table" }>;
};

type OpenFenceState = {
  work: ParserWork;
  marker: string;
  language?: string;
  scannedOffset: number;
  value: string;
  pending: string;
  block: Extract<Block, { type: "code" }>;
};

type OpenBlockState =
  | { kind: "paragraph"; value: OpenParagraphState }
  | { kind: "container"; value: OpenContainerState }
  | { kind: "table"; value: OpenTableState }
  | { kind: "fence"; value: OpenFenceState };

type FrozenReference = { index: number; source: string };

const normalizeReference = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase().toUpperCase();

function unresolvedReferenceLabels(source: string, references: Environment["references"], work?: ParserWork) {
  scanned(work, source.length);
  const labels = new Set<string>();
  for (const match of source.matchAll(/!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
    const label = normalizeReference(match[2] || match[1]!);
    if (!references?.[label]) labels.add(label);
  }
  for (const match of source.matchAll(/(?<!!)\[([^\]\n]+)\](?![\[(])/g)) {
    const label = normalizeReference(match[1]!);
    if (!references?.[label]) labels.add(label);
  }
  return labels;
}

const fenceCloser = (marker: string, line: string) => new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(line);

function markPendingReferences(inlines: Inline[]) {
  for (let index = 0; index < inlines.length; index++) {
    const node = inlines[index]!;
    if ("children" in node) {
      markPendingReferences(node.children);
      continue;
    }
    if (node.type !== "text" || !node.value.includes("[")) continue;
    const replacement: Inline[] = [];
    let offset = 0;
    for (const match of node.value.matchAll(/!?\[([^\]\n]+)\](?:\[([^\]\n]*)\])?/g)) {
      if (match.index === undefined || match.index > 0 && node.value[match.index - 1] === "\\") continue;
      if (match.index > offset) replacement.push({ type: "text", value: node.value.slice(offset, match.index) });
      replacement.push({ type: "pending-reference", value: match[1]! });
      offset = match.index + match[0].length;
    }
    if (!replacement.length) continue;
    if (offset < node.value.length) replacement.push({ type: "text", value: node.value.slice(offset) });
    inlines.splice(index, 1, ...replacement);
    index += replacement.length - 1;
  }
}

function markPendingReferenceBlocks(blocks: Block[]) {
  for (const block of blocks) {
    if (block.type === "paragraph" || block.type === "heading") markPendingReferences(block.children);
    else if (block.type === "blockquote") markPendingReferenceBlocks(block.children);
    else if (block.type === "list") for (const item of block.items) markPendingReferenceBlocks(item.children);
    else if (block.type === "table") {
      for (const cell of block.header) markPendingReferences(cell);
      for (const row of block.rows) for (const cell of row) markPendingReferences(cell);
    }
  }
}

const listMarker = /^( {0,3})([-+*]|\d{1,9}[.)])(\s+)(.*)$/;

function setTight(blocks: readonly Block[]) {
  const first = blocks[0];
  if (first?.type === "paragraph") first.tight = true;
}

function currentContainerChild(state: OpenContainerState) {
  return state.children.at(-1)!;
}

function publishContainerChild(state: OpenContainerState, child: ContainerChild | undefined) {
  if (!child) return;
  const rendered = child.document.render() as Block[];
  if (child.item) {
    setTight(rendered);
    child.item.children = rendered;
  } else if (state.block.type === "blockquote") state.block.children = rendered;
}

function publishContainer(state: OpenContainerState) {
  publishContainerChild(state, state.children.at(-1));
  return state.block;
}

function startListChild(state: OpenContainerState, match: RegExpExecArray) {
  publishContainerChild(state, state.children.at(-1));
  const document = createStreamingDocumentWithWork(state.work);
  let content = match[4]!;
  const task = /^\[([ xX])\]\s+/.exec(content);
  const item: ListItem = { checked: task ? task[1]!.toLowerCase() === "x" : undefined, children: [] };
  if (task) content = content.slice(task[0].length);
  state.contentIndent = match[1]!.length + match[2]!.length + match[3]!.length;
  state.items!.push(item);
  state.children.push({ document, item });
  if (content) document.append(content);
  document.append("\n");
}

function appendContainerLine(state: OpenContainerState, line: string) {
  if (state.kind === "quote") {
    const marker = /^ {0,3}> ?(.*)$/.exec(line);
    if (marker) {
      currentContainerChild(state).document.append(`${marker[1]}\n`);
      state.previousBlank = !marker[1]!.trim();
      return true;
    }
    if (!line.trim() || state.previousBlank) return false;
    currentContainerChild(state).document.append(`${line}\n`);
    return true;
  }

  const marker = listMarker.exec(line);
  if (marker && /^\d/.test(marker[2]!) === state.ordered) {
    startListChild(state, marker);
    state.previousBlank = false;
    return true;
  }
  if (!line.trim()) {
    currentContainerChild(state).document.append("\n");
    state.previousBlank = true;
    return true;
  }
  const indent = state.contentIndent ?? 0;
  if (line.startsWith(" ".repeat(indent))) {
    currentContainerChild(state).document.append(`${line.slice(indent)}\n`);
    state.previousBlank = false;
    return true;
  }
  if (state.previousBlank) return false;
  currentContainerChild(state).document.append(`${line}\n`);
  return true;
}

function appendContainerDelta(state: OpenContainerState, delta: string) {
  scanned(state.work, state.pending.length);
  const lines = `${state.pending}${delta}`.split("\n");
  state.pending = lines.pop()!;
  for (const line of lines) {
    if (!appendContainerLine(state, line)) return false;
    state.scannedOffset += line.length + 1;
  }
  publishContainer(state);
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
    return parseInline(value, streaming, state.work);
  });
}

function appendTableDelta(state: OpenTableState, delta: string) {
  scanned(state.work, state.pending.length);
  if (state.hasPendingRow) {
    state.block.rows.pop();
    state.hasPendingRow = false;
  }
  const previousPendingLength = state.pending.length;
  const lines = `${state.pending}${delta}`.split("\n");
  state.pending = lines.pop()!;
  let consumed = 0;
  for (const line of lines) {
    if (!line.trim()) {
      state.scannedOffset += Math.max(0, Math.min(delta.length, consumed - previousPendingLength));
      return false;
    }
    consumed += line.length + 1;
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
  scanned(state.work, state.pending.length);
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

function createStreamingDocumentWithWork(work: ParserWork): StreamingDocument {
  let source = "";
  let tailSource = "";
  let unrendered = "";
  const blocks = new BlockBuffer();
  const cached = blocks.view;
  let renderedSource = "";
  let countedTailSource = "";
  let finished = false;
  let openState: OpenBlockState | undefined;
  const environment: Environment = {};
  const referenceBlocks = new Map<string, Set<FrozenReference>>();
  const appliedReferences = new Map<string, string>();

  const publishOpen = (open: Block[]): Block[] => {
    blocks.publish(open);
    unrendered = "";
    renderedSource = source;
    return cached as Block[];
  };

  const continueParagraph = (state: OpenParagraphState) => {
    const delta = unrendered;
    const next = state.pendingNewline + delta;
    if (/[\\*_`~[\]<>&!]/.test(delta) || next.includes("\n\n")) return;
    const pendingNewline = next.endsWith("\n") ? "\n" : "";
    const visible = pendingNewline ? next.slice(0, -1) : next;
    if (state.text.value.length + visible.length > 1024) {
      state.text = { type: "text", value: visible };
      state.block.children.push(state.text);
    } else state.text.value += visible;
    state.pendingNewline = pendingNewline;
    state.scannedOffset += delta.length;
    return openSnapshot(state.block);
  };

  const commitOpenPrefix = (requestedOffset: number) => {
    const offset = Math.min(requestedOffset, tailSource.length);
    if (offset <= 0) return;
    const committedEnvironment: Environment = { references: environment.references ? { ...environment.references } : undefined };
    commitFrozen(tailSource, offset, committedEnvironment);
    environment.references = committedEnvironment.references;
    work.frozenParses++;
    scanned(work, offset);
    tailSource = tailSource.slice(offset).replace(/^\n+/, "");
  };

  const commitOpenContainer = (state: OpenContainerState) => {
    const offset = Math.min(state.scannedOffset, tailSource.length);
    if (!offset) return;
    const block = publishContainer(state);
    markPendingReferenceBlocks([block]);
    const record: FrozenReference = { index: blocks.frozen, source: tailSource.slice(0, offset) };
    for (const label of unresolvedReferenceLabels(record.source, environment.references, work)) {
      let records = referenceBlocks.get(label);
      if (!records) referenceBlocks.set(label, records = new Set());
      records.add(record);
    }
    blocks.freeze([block]);
    tailSource = tailSource.slice(offset).replace(/^\n+/, "");
  };

  const continueOpenBlock = () => {
    if (finished || !openState) return;
    const state = openState;
    scanned(work, unrendered.length);
    const continued = state.kind === "paragraph" ? continueParagraph(state.value)
      : state.kind === "container" ? appendContainerDelta(state.value, unrendered) && openSnapshot(publishContainer(state.value))
      : state.kind === "table" ? appendTableDelta(state.value, unrendered) && openSnapshot(state.value.block)
      : appendFenceDelta(state.value, unrendered) && openSnapshot(state.value.block);
    if (continued) return continued;
    if (state.kind === "container") commitOpenContainer(state.value);
    else if (state.kind !== "fence") commitOpenPrefix(state.value.scannedOffset);
    openState = undefined;
  };

  const startQuote = (tail: string) => {
    if (!/^ {0,3}>/.test(tail)) return;
    const child = createStreamingDocumentWithWork(work);
    const block: Extract<Block, { type: "blockquote" }> = { type: "blockquote", children: [] };
    const state: OpenContainerState = {
      kind: "quote",
      work,
      scannedOffset: 0,
      pending: "",
      previousBlank: false,
      children: [{ document: child }],
      block,
    };
    openState = { kind: "container", value: state };
    scanned(work, tail.length);
    if (appendContainerDelta(state, tail)) return openSnapshot(publishContainer(state));
    commitOpenContainer(state);
    openState = undefined;
  };

  const startList = (tail: string) => {
    const firstLine = tail.slice(0, tail.indexOf("\n") < 0 ? tail.length : tail.indexOf("\n"));
    const match = listMarker.exec(firstLine);
    if (!match) return;
    const ordered = /^\d/.test(match[2]!);
    const items = new ListItemBuffer([]);
    const block: ListBlock = { type: "list", ordered, items: items.view };
    const state: OpenContainerState = {
      kind: "list",
      work,
      ordered,
      scannedOffset: 0,
      pending: "",
      previousBlank: false,
      children: [],
      items,
      block,
    };
    openState = { kind: "container", value: state };
    scanned(work, tail.length);
    if (appendContainerDelta(state, tail)) return openSnapshot(publishContainer(state));
    commitOpenContainer(state);
    openState = undefined;
  };

  const startTable = (tail: string) => {
    const match = /^([^\n]*\|[^\n]*)\n(\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*)\n/.exec(tail);
    if (!match) return;
    const initial = parseDetailed(`${match[1]}\n${match[2]}`, {}, work)[0]?.block;
    if (initial?.type !== "table") return;
    const contentOffset = match[0].length;
    const state: OpenTableState = { work, header: match[1]!, delimiter: match[2]!, scannedOffset: contentOffset, pending: "", hasPendingRow: false, block: initial };
    openState = { kind: "table", value: state };
    if (appendTableDelta(state, tailSource.slice(contentOffset))) return openSnapshot(initial);
    commitOpenPrefix(state.scannedOffset);
    openState = undefined;
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
    const state: OpenFenceState = { work, marker: opener[1]!, language: block.language, scannedOffset: contentOffset, value: "", pending: "", block };
    openState = { kind: "fence", value: state };
    if (appendFenceDelta(state, tailSource.slice(contentOffset))) return openSnapshot(block);
    openState = undefined;
  };

  const startParagraph = (tail: string) => {
    const paragraph = tail.replace(/^\n+/, "");
    if (!/\s/.test(paragraph) || /[\n]{2}|[\\*_`~[\]<>&|!]/.test(paragraph) || /^ {0,3}(?:[-*_]\s*)+$/.test(paragraph) || /^ {0,3}(?:#{1,6}|>|[-+*]|\d{1,9}[.)])(?:\s|$)/.test(paragraph)) return;
    const pendingNewline = paragraph.endsWith("\n") ? "\n" : "";
    const text: Extract<Inline, { type: "text" }> = { type: "text", value: pendingNewline ? paragraph.slice(0, -1) : paragraph };
    const block: Extract<Block, { type: "paragraph" }> = { type: "paragraph", children: [text] };
    openState = { kind: "paragraph", value: { scannedOffset: tailSource.length, pendingNewline, text, block } };
    return openSnapshot(block);
  };

  const startOpenBlock = (tail: string) => startQuote(tail) ?? startList(tail) ?? startTable(tail) ?? startFence(tail) ?? startParagraph(tail);

  const updateReferenceBlocks = (references: Environment["references"]) => {
    if (!references) return;
    for (const [label, records] of referenceBlocks) {
      const reference = references[label];
      if (!reference) continue;
      const version = `${reference.href}\n${reference.title}`;
      if (appliedReferences.get(label) === version) continue;
      appliedReferences.set(label, version);
      for (const record of records) {
        const replacement = parseDetailed(record.source, { references: { ...references } }, work)[0]?.block;
        if (replacement) blocks.replace(record.index, replacement);
      }
    }
  };

  const commitFrozen = (tail: string, offset: number, committedEnvironment: Environment) => {
    const prefix = tail.slice(0, offset);
    const details = parseDetailed(prefix, committedEnvironment, work);
    markPendingReferenceBlocks(details.map(({ block }) => block));
    const firstIndex = blocks.frozen;
    details.forEach((detail, index) => {
      const blockSource = prefix.slice(lineOffset(prefix, detail.map[0], work), lineOffset(prefix, detail.map[1], work));
      const record: FrozenReference = { index: firstIndex + index, source: blockSource };
      for (const label of unresolvedReferenceLabels(blockSource, committedEnvironment.references, work)) {
        let records = referenceBlocks.get(label);
        if (!records) referenceBlocks.set(label, records = new Set());
        records.add(record);
      }
    });
    blocks.freeze(details.map(({ block }) => block));
  };

  const parseTail = (tail: string) => {
    const fence = !finished && openFence(tail);
    const parsedEnvironment: Environment = { references: environment.references ? { ...environment.references } : undefined };
    const parsed = finished ? parseDetailed(tail, parsedEnvironment, work) : parseStreamingMarkdown(tail, parsedEnvironment, work);
    if (!finished) markPendingReferenceBlocks(parsed.map(({ block }) => block));
    updateReferenceBlocks(parsedEnvironment.references);
    if (countedTailSource !== source) {
      countedTailSource = source;
      work.tailParses++;
    }
    let freezeCount = finished ? parsed.length : 0;
    if (!finished) for (let index = 0; index < parsed.length - 1; index++) {
      if (parsed[index + 1]!.map[0] > parsed[index]!.map[1]) freezeCount = index + 1;
    }
    const startsContainer = /^\s*(?:>|[-+*]\s|\d{1,9}[.)]\s)/.test(tail);
    const closesContainer = /\n[ \t]*\n(?!(?:[-+*]|\d{1,9}[.)])\s)(?=\S)/.test(tail);
    if (!finished && startsContainer && !closesContainer) freezeCount = 0;
    if (!finished) for (let index = 0; index < freezeCount; index++) {
      const block = parsed[index]!.block;
      if ((block.type === "list" || block.type === "blockquote") && parsed[index + 1] && parsed[index + 1]!.map[0] <= parsed[index]!.map[1]) {
        freezeCount = index;
        break;
      }
    }
    if (!finished && !startsContainer && !fence && parsed.length && parsed.at(-1)!.closed && parsed.at(-1)!.block.type === "code") freezeCount = parsed.length;
    return { parsed, freezeCount, parsedEnvironment };
  };

  const freezeParsed = (tail: string, parsed: ParsedBlock[], freezeCount: number, parsedEnvironment: Environment): Block[] | undefined => {
    if (!freezeCount) return;
    const endLine = parsed[freezeCount - 1]!.map[1];
    const offset = freezeCount === parsed.length ? tail.length : lineOffset(tail, endLine, work);
    if (offset <= 0) return;
    const committedEnvironment: Environment = { references: environment.references ? { ...environment.references } : undefined };
    commitFrozen(tail, offset, committedEnvironment);
    environment.references = committedEnvironment.references;
    work.frozenParses++;
    tailSource = tailSource.slice(offset).replace(/^\n+/, "");
    const open = tailSource;
    if (!open) return [];
    if (!finished) {
      unrendered = open;
      return render();
    }
    return parseDetailed(open, parsedEnvironment, work).map(({ block }) => block);
  };

  const render = (): Block[] => {
    if (source === renderedSource) return cached as Block[];
    const continued = continueOpenBlock();
    if (continued) return publishOpen([continued]);
    const tail = tailSource;
    if (!finished) {
      const started = startOpenBlock(tail);
      if (started) return publishOpen([started]);
      if (tailSource !== tail) {
        unrendered = tailSource;
        return render();
      }
    }
    const { parsed, freezeCount, parsedEnvironment } = parseTail(tail);
    const open = freezeParsed(tail, parsed, freezeCount, parsedEnvironment);
    if (open === blocks.view) return cached as Block[];
    return publishOpen(open ?? parsed.map(({ block }) => block));
  };

  return {
    get source() { return source; },
    get stats() { return work; },
    append(delta) {
      if (finished) throw new Error("cannot append to a finished markdown document");
      source += delta;
      tailSource += delta;
      unrendered += delta;
    },
    finish() {
      finished = true;
      openState = undefined;
      blocks.reset(parseDetailed(source, {}, work).map(({ block }) => block), true);
      tailSource = "";
      unrendered = "";
      renderedSource = source;
    },
    render,
  };
}

export function createStreamingDocument(): StreamingDocument {
  return createStreamingDocumentWithWork({ frozenParses: 0, tailParses: 0, scannedCharacters: 0 });
}
