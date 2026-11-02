import MarkdownIt, { type MarkdownToken } from "./vendor/markdown-it.mjs";

export const tokenTypes = [
  "keyword", "string", "number", "comment", "function", "type", "variable",
  "constant", "operator", "punctuation", "tag", "attribute", "regexp", "inserted", "deleted",
] as const;

export type TokenType = (typeof tokenTypes)[number];
export type Token = { text: string; type?: TokenType };
export type HighlightContext = { id: string; version: number; state: "streaming" | "done" };
export type HighlightResult = Token[] | null;
export type Highlighter = (
  code: string,
  lang: string | undefined,
  context?: HighlightContext,
) => HighlightResult | Promise<HighlightResult>;

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

function inlineNodes(tokens: MarkdownToken[]): Inline[] {
  const root: Inline[] = [];
  const stack: Array<{ kind: "emphasis" | "strong" | "strike" | "link"; node: Inline & { children: Inline[] } }> = [];
  const target = () => stack.at(-1)?.node.children ?? root;
  const pushText = (value: string) => {
    if (!value) return;
    const last = target().at(-1);
    if (last?.type === "text") last.value += value;
    else target().push({ type: "text", value });
  };

  for (const token of tokens) {
    if (token.type === "text" || token.type === "html_inline") pushText(token.content);
    else if (token.type === "softbreak") pushText("\n");
    else if (token.type === "hardbreak") target().push({ type: "break" });
    else if (token.type === "code_inline") target().push({ type: "code", value: token.content });
    else if (token.type === "image") {
      const text = (node: Inline): string => node.type === "text" || node.type === "code" ? node.value : "children" in node ? node.children.map(text).join("") : node.type === "image" ? node.alt : "";
      const alt = inlineNodes(token.children ?? []).map(text).join("") || token.content;
      target().push({ type: "image", src: safeHref(attr(token, "src") ?? null), title: attr(token, "title"), alt });
    }
    else if (token.nesting === 1 && ["em_open", "strong_open", "s_open", "link_open"].includes(token.type)) {
      const kind = token.type === "em_open" ? "emphasis" : token.type === "strong_open" ? "strong" : token.type === "s_open" ? "strike" : "link";
      const node: Inline & { children: Inline[] } = kind === "link"
        ? { type: "link", href: safeHref(attr(token, "href") ?? null), title: attr(token, "title"), children: [] }
        : kind === "emphasis" ? { type: "emphasis", children: [] }
          : kind === "strong" ? { type: "strong", children: [] }
            : { type: "strike", children: [] };
      target().push(node);
      stack.push({ kind, node });
    } else if (token.nesting === -1 && stack.length) stack.pop();
  }
  return root;
}

const tokenMap = (token: MarkdownToken): [number, number] => token.map ?? [0, 0];

function convertBlocks(tokens: MarkdownToken[], start = 0, stop?: string): [ParsedBlock[], number] {
  const blocks: ParsedBlock[] = [];
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (stop && token.type === stop) return [blocks, index + 1];

    if (token.type === "paragraph_open" || token.type === "heading_open") {
      const inline = tokens[index + 1]!;
      const block: Block = token.type === "paragraph_open"
        ? { type: "paragraph", children: inlineNodes(inline.children ?? []), tight: token.hidden || undefined }
        : { type: "heading", level: Number(token.tag.slice(1)), children: inlineNodes(inline.children ?? []) };
      blocks.push({ block, map: tokenMap(token), closed: true });
      index += 3;
      continue;
    }
    if (token.type === "fence" || token.type === "code_block") {
      const language = token.type === "fence" ? token.info.trim().split(/\s+/)[0] || undefined : undefined;
      const lines = token.map?.[1] ?? 0;
      const closed = token.type === "code_block" || lines > 0 && token.markup.length > 0 && token.content.endsWith("\n") && token.map !== null;
      blocks.push({ block: { type: "code", language, value: token.content, open: !closed }, map: tokenMap(token), closed });
      index++;
      continue;
    }
    if (token.type === "hr") {
      blocks.push({ block: { type: "rule" }, map: tokenMap(token), closed: true });
      index++;
      continue;
    }
    if (token.type === "blockquote_open") {
      const [children, next] = convertBlocks(tokens, index + 1, "blockquote_close");
      blocks.push({ block: { type: "blockquote", children: children.map(({ block }) => block) }, map: tokenMap(token), closed: true });
      index = next;
      continue;
    }
    if (token.type === "bullet_list_open" || token.type === "ordered_list_open") {
      const close = token.type === "bullet_list_open" ? "bullet_list_close" : "ordered_list_close";
      const items: ListItem[] = [];
      index++;
      while (index < tokens.length && tokens[index]!.type !== close) {
        if (tokens[index]!.type !== "list_item_open") { index++; continue; }
        const itemOpen = tokens[index++]!;
        const [children, next] = convertBlocks(tokens, index, "list_item_close");
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
        void itemOpen;
      }
      index++;
      const ordered = token.type === "ordered_list_open";
      const startValue = ordered ? Number(attr(token, "start") ?? "1") : undefined;
      blocks.push({ block: { type: "list", ordered, start: startValue, items }, map: tokenMap(token), closed: true });
      continue;
    }
    if (token.type === "table_open") {
      const tableMap = tokenMap(token);
      const header: Inline[][] = [];
      const rows: Inline[][][] = [];
      const align: Array<"left" | "center" | "right" | undefined> = [];
      let row: Inline[][] | undefined;
      let inHeader = false;
      index++;
      while (index < tokens.length && tokens[index]!.type !== "table_close") {
        const current = tokens[index]!;
        if (current.type === "thead_open") inHeader = true;
        else if (current.type === "thead_close") inHeader = false;
        else if (current.type === "tr_open") row = [];
        else if (current.type === "tr_close" && row) {
          if (inHeader) header.push(...row);
          else rows.push(row);
          row = undefined;
        } else if ((current.type === "th_open" || current.type === "td_open") && row) {
          const inline = tokens[index + 1];
          row.push(inline?.type === "inline" ? inlineNodes(inline.children ?? []) : []);
          if (current.type === "th_open") {
            const style = attr(current, "style") ?? "";
            align.push(style.includes("center") ? "center" : style.includes("right") ? "right" : style.includes("left") ? "left" : undefined);
          }
        }
        index++;
      }
      index++;
      blocks.push({ block: { type: "table", header, rows, align }, map: tableMap, closed: true });
      continue;
    }
    index++;
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

export function repairMarkdown(source: string): string {
  const fence = openFence(source);
  if (fence) {
    const opener = source.lastIndexOf(fence);
    const contentStart = source.indexOf("\n", opener);
    return contentStart < 0 || contentStart === source.length - 1 ? source.slice(0, opener) : source;
  }
  const runs = [...source.matchAll(/`+/g)];
  const tick = runs.find((run, index) => !runs.slice(index + 1).some((later) => later[0].length === run[0].length));
  if (tick?.index !== undefined) {
    const content = source.slice(tick.index + tick[0].length);
    if (!content) return source.slice(0, tick.index);
    return `${source}${tick[0]}`;
  }
  const marker = /(\*\*|__|~~|\*|_)<?([^\n]*)$/.exec(source);
  if (marker && !marker[2]) return source.slice(0, marker.index);
  if (marker && marker[2] && !marker[2].includes(marker[1]!)) return `${source}${marker[1]}`;
  if (/\[$/.test(source)) return source.slice(0, -1);
  const link = /\[([^\]]+)\]\(([^)\s]+)$/.exec(source);
  if (link) return `${source})`;
  return source;
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

export function createStreamingDocument(): StreamingDocument {
  let source = "";
  let tailOffset = 0;
  let frozen: Block[] = [];
  let cached: readonly Block[] = [];
  let renderedSource = "";
  let finished = false;
  let frozenParses = 0;
  let tailParses = 0;
  const environment: Environment = {};

  const render = () => {
    if (source === renderedSource) return cached;
    const tail = source.slice(tailOffset);
    const fence = !finished && openFence(tail);
    const parsed = parseDetailed(finished ? tail : repairMarkdown(tail), { references: environment.references ? { ...environment.references } : undefined });
    const last = parsed.at(-1)?.block;
    if (fence && last?.type === "code") last.open = true;
    tailParses++;

    let freezeCount = finished ? parsed.length : 0;
    if (!finished) {
      for (let index = 0; index < parsed.length - 1; index++) {
        if (parsed[index + 1]!.map[0] > parsed[index]!.map[1]) freezeCount = index + 1;
      }
    }
    if (!finished && !fence && parsed.length && parsed.at(-1)!.closed && parsed.at(-1)!.block.type === "code") freezeCount = parsed.length;
    if (freezeCount) {
      const endLine = parsed[freezeCount - 1]!.map[1];
      const offset = freezeCount === parsed.length ? tail.length : lineOffset(tail, endLine);
      if (offset > 0) {
        const committed = tail.slice(0, offset);
        const committedEnvironment: Environment = { references: environment.references ? { ...environment.references } : undefined };
        const committedBlocks = parseDetailed(committed, committedEnvironment).map(({ block }) => block);
        environment.references = committedEnvironment.references;
        frozen = [...frozen, ...committedBlocks];
        frozenParses++;
        tailOffset += offset;
        const open = source.slice(tailOffset);
        const openBlocks = open ? parseMarkdown(finished ? open : repairMarkdown(open)) : [];
        cached = [...frozen, ...openBlocks];
        renderedSource = source;
        return cached;
      }
    }
    cached = [...frozen, ...parsed.map(({ block }) => block)];
    renderedSource = source;
    return cached;
  };

  return {
    get source() { return source; },
    get stats() { return { frozenParses, tailParses }; },
    append(delta) { if (finished) throw new Error("cannot append to a finished markdown document"); source += delta; },
    finish() { finished = true; renderedSource = ""; },
    render,
  };
}
