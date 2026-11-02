export const tokenTypes = [
  "keyword", "string", "number", "comment", "function", "type", "variable",
  "constant", "operator", "punctuation", "tag", "attribute", "regexp", "inserted", "deleted",
] as const;

export type TokenType = (typeof tokenTypes)[number];
export type Token = { type?: TokenType; content: string };
export type HighlightContext = { id: string; version: number; state?: unknown };
export type HighlightResult = Token[] | { tokens: Token[]; state?: unknown } | null;
export type Highlighter = (
  code: string,
  lang: string | undefined,
  context?: HighlightContext,
) => HighlightResult | Promise<HighlightResult>;

export type Inline =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "break" }
  | { type: "emphasis" | "strong" | "strike"; children: Inline[] }
  | { type: "link"; href?: string; children: Inline[] }
  | { type: "image"; src?: string; alt: string };

export type ListItem = { checked?: boolean; children: Inline[]; nested?: ListBlock };
export type ListBlock = { type: "list"; ordered: boolean; start?: number; items: ListItem[] };
export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "code"; language?: string; value: string; open?: boolean }
  | ListBlock
  | { type: "blockquote"; children: Block[] }
  | { type: "table"; header: Inline[][]; rows: Inline[][][]; align: Array<"left" | "center" | "right" | undefined> }
  | { type: "rule" };

const safeHref = (href: string) => {
  const value = href.trim();
  const normalized = value.replace(/[\u0000-\u0020]/g, "");
  if (/^(https?:|mailto:)/i.test(normalized)) return value;
  if (!/^[a-z][a-z\d+.-]*:/i.test(normalized) && !/^[\\/]{2}/.test(normalized)) return value;
  return undefined;
};

const decodeEntities = (value: string) => value.replace(
  /&(?:#(x[\da-f]+|\d+)|amp|lt|gt|quot|apos);/gi,
  (entity, numeric: string | undefined) => numeric
    ? String.fromCodePoint(Number.parseInt(numeric.replace(/^x/i, ""), /^x/i.test(numeric) ? 16 : 10))
    : ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'" }[entity.toLowerCase()] ?? entity),
);

const pushText = (nodes: Inline[], value: string) => {
  if (!value) return;
  const decoded = decodeEntities(value);
  const last = nodes.at(-1);
  if (last?.type === "text") last.value += decoded;
  else nodes.push({ type: "text", value: decoded });
};

type References = Map<string, string>;
const referenceKey = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

export function parseInline(source: string, references: References = new Map()): Inline[] {
  const nodes: Inline[] = [];
  let index = 0;
  while (index < source.length) {
    if (source[index] === "\\" && index + 1 < source.length) {
      pushText(nodes, source[index + 1]!);
      index += 2;
      continue;
    }
    if (source.startsWith("  \n", index)) {
      nodes.push({ type: "break" });
      index += 3;
      continue;
    }
    if (source[index] === "\n") {
      pushText(nodes, "\n");
      index++;
      continue;
    }
    if (source[index] === "`") {
      const run = /^`+/.exec(source.slice(index))![0];
      const end = source.indexOf(run, index + run.length);
      if (end >= 0) {
        let value = source.slice(index + run.length, end).replace(/\n/g, " ");
        if (/^ .* $/.test(value) && !/^ +$/.test(value)) value = value.slice(1, -1);
        nodes.push({ type: "code", value });
        index = end + run.length;
        continue;
      }
    }
    const marker = source.startsWith("**", index)
      ? "**"
      : source.startsWith("__", index)
        ? "__"
        : source.startsWith("~~", index)
          ? "~~"
          : source[index] === "*" || source[index] === "_"
            ? source[index]!
            : undefined;
    if (marker) {
      const end = source.indexOf(marker, index + marker.length);
      if (end > index + marker.length) {
        nodes.push({
          type: marker === "~~" ? "strike" : marker.length === 2 ? "strong" : "emphasis",
          children: parseInline(source.slice(index + marker.length, end), references),
        });
        index = end + marker.length;
        continue;
      }
    }
    const image = source[index] === "!" && source[index + 1] === "[";
    if (source[index] === "[" || image) {
      const labelStart = index + (image ? 2 : 1);
      const labelEnd = source.indexOf("]", labelStart);
      if (labelEnd >= 0 && source[labelEnd + 1] === "(") {
        const hrefEnd = source.indexOf(")", labelEnd + 2);
        if (hrefEnd >= 0) {
          const destination = source.slice(labelEnd + 2, hrefEnd).trim().replace(/^<|>$/g, "").split(/\s+[\"']/)[0]!;
          const label = source.slice(labelStart, labelEnd);
          if (image) nodes.push({ type: "image", src: safeHref(destination), alt: label });
          else nodes.push({ type: "link", href: safeHref(destination), children: parseInline(label, references) });
          index = hrefEnd + 1;
          continue;
        }
      }
      if (!image && labelEnd >= 0) {
        const full = /^\[([^\]]*)\]/.exec(source.slice(labelEnd + 1));
        const label = source.slice(labelStart, labelEnd);
        const key = referenceKey(full ? full[1] || label : label);
        const href = references.get(key);
        if (href) {
          nodes.push({ type: "link", href, children: parseInline(label, references) });
          index = labelEnd + 1 + (full?.[0].length ?? 0);
          continue;
        }
      }
    }
    if (source[index] === "<") {
      const end = source.indexOf(">", index + 1);
      if (end >= 0) {
        const value = source.slice(index + 1, end);
        const href = /^(?:https?:\/\/|mailto:)/i.test(value)
          ? safeHref(value)
          : /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)
            ? `mailto:${value}`
            : undefined;
        if (href) {
          nodes.push({ type: "link", href, children: [{ type: "text", value: value.replace(/^mailto:/i, "") }] });
          index = end + 1;
          continue;
        }
      }
    }
    const entity = /^&(?:#(?:x[\da-f]+|\d+)|amp|lt|gt|quot|apos);/i.exec(source.slice(index));
    if (entity) {
      pushText(nodes, entity[0]);
      index += entity[0].length;
      continue;
    }
    const literal = /^(https?:\/\/[^\s<>]+|www\.[^\s<>]+|[\w.!#$%&'*+/=?^`{|}~-]+@[\w](?:[\w-]*[\w])?(?:\.[\w](?:[\w-]*[\w])?)+)/i.exec(source.slice(index));
    if (literal) {
      const value = literal[0].replace(/[.,!?;:]+$/, "");
      const href = value.startsWith("www.") ? `http://${value}` : value.includes("@") && !value.includes("://") ? `mailto:${value}` : value;
      nodes.push({ type: "link", href, children: [{ type: "text", value }] });
      index += value.length;
      continue;
    }
    pushText(nodes, source[index]!);
    index++;
  }
  return nodes;
}

const tableCells = (line: string, references: References) => {
  const source = line.trim().replace(/^\||\|$/g, "");
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\\" && source[index + 1] === "|") { cell += "|"; index++; }
    else if (source[index] === "|") { cells.push(cell); cell = ""; }
    else cell += source[index];
  }
  cells.push(cell);
  return cells.map((value) => parseInline(value.trim(), references));
};

const beginsBlock = (lines: string[], index: number) => {
  const line = lines[index] ?? "";
  return /^(?: {0,3}(?:#{1,6}\s|>|```|~~~|(?:[-+*]|\d+[.)])\s)| {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(line) ||
    (line.includes("|") && /^\s*\|?\s*:?-{1,}:?/.test(lines[index + 1] ?? ""));
};

function parseList(lines: string[], start: number, references: References): [ListBlock, number] {
  const first = /^(\s*)([-+*]|\d+[.)])\s+(.*)$/.exec(lines[start]!)!;
  const indent = first[1]!.length;
  const ordered = /^\d/.test(first[2]!);
  const block: ListBlock = {
    type: "list",
    ordered,
    start: ordered ? Number.parseInt(first[2]!, 10) : undefined,
    items: [],
  };
  let index = start;
  while (index < lines.length) {
    const match = /^(\s*)([-+*]|\d+[.)])\s+(.*)$/.exec(lines[index]!);
    if (!match || match[1]!.length !== indent || /^\d/.test(match[2]!) !== ordered) break;
    let text = match[3]!;
    const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
    const continuation: string[] = [];
    while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1]!) && !/^\s*(?:[-+*]|\d+[.)])\s+/.test(lines[index + 1]!)) continuation.push(lines[++index]!.trim());
    if (continuation.length) text += `\n${continuation.join("\n")}`;
    const item: ListItem = { children: parseInline(task ? `${task[2]}${continuation.length ? `\n${continuation.join("\n")}` : ""}` : text, references) };
    if (task) item.checked = task[1]!.toLowerCase() === "x";
    index++;
    const nested = /^(\s*)([-+*]|\d+[.)])\s+/.exec(lines[index] ?? "");
    if (nested && nested[1]!.length > indent) {
      [item.nested, index] = parseList(lines, index, references);
    }
    block.items.push(item);
  }
  return [block, index];
}

export function parseMarkdown(source: string, inheritedReferences?: References): Block[] {
  const references = inheritedReferences ?? new Map<string, string>();
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const definition = /^ {0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))(?:\s+(?:[\"'(].*)?)?$/.exec(lines[index]!);
    if (definition) {
      const href = safeHref(definition[2] ?? definition[3]!);
      if (href) references.set(referenceKey(definition[1]!), href);
      lines[index] = "";
    }
  }
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) { index++; continue; }
    const fence = /^ {0,3}(```+|~~~+)\s*([^\s`]*)?.*$/.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const code: string[] = [];
      index++;
      while (index < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[index]!)) code.push(lines[index++]!);
      const open = index === lines.length;
      if (!open) index++;
      blocks.push({ type: "code", language: fence[2] || undefined, value: code.join("\n"), open });
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+\s*)?$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length, children: parseInline(heading[2]!, references) });
      index++;
      continue;
    }
    const setext = /^ {0,3}(=+|-+)\s*$/.exec(lines[index + 1] ?? "");
    if (setext) {
      blocks.push({ type: "heading", level: setext[1]![0] === "=" ? 1 : 2, children: parseInline(line.trim(), references) });
      index += 2;
      continue;
    }
    if (/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      blocks.push({ type: "rule" }); index++; continue;
    }
    if (/^(?: {4}|\t)/.test(line)) {
      const code: string[] = [];
      while (index < lines.length && (/^(?: {4}|\t)/.test(lines[index]!) || !lines[index]!.trim())) code.push(lines[index++]!.replace(/^(?: {4}|\t)/, ""));
      while (!code.at(-1)?.trim()) code.pop();
      blocks.push({ type: "code", value: code.join("\n"), open: false });
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index]!)) quote.push(lines[index++]!.replace(/^ {0,3}> ?/, ""));
      blocks.push({ type: "blockquote", children: parseMarkdown(quote.join("\n"), references) });
      continue;
    }
    if (/^\s*(?:[-+*]|\d+[.)])\s+/.test(line)) {
      const [list, next] = parseList(lines, index, references);
      blocks.push(list); index = next; continue;
    }
    if (line.includes("|") && /^\s*\|?\s*:?-{1,}:?(?:\s*\|\s*:?-{1,}:?)+\s*\|?\s*$/.test(lines[index + 1] ?? "")) {
      const header = tableCells(line, references);
      const align = (lines[index + 1]!.trim().replace(/^\||\|$/g, "").split("|")).map((cell) => {
        const value = cell.trim();
        return value.startsWith(":") && value.endsWith(":") ? "center" : value.endsWith(":") ? "right" : value.startsWith(":") ? "left" : undefined;
      });
      index += 2;
      const rows: Inline[][][] = [];
      while (index < lines.length && lines[index]!.trim() && lines[index]!.includes("|")) rows.push(tableCells(lines[index++]!, references));
      blocks.push({ type: "table", header, rows, align });
      continue;
    }
    const paragraph = [line];
    index++;
    while (index < lines.length && lines[index]!.trim() && !beginsBlock(lines, index)) paragraph.push(lines[index++]!);
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n"), references) });
  }
  return blocks;
}

const unescapedCount = (source: string, marker: string) => {
  let count = 0;
  for (let index = 0; index <= source.length - marker.length; index++) {
    if (source.startsWith(marker, index) && source[index - 1] !== "\\") { count++; index += marker.length - 1; }
  }
  return count;
};

const unclosedFence = (source: string) => {
  const lines = source.split("\n");
  const fence = lines.find((line) => /^ {0,3}(```+|~~~+)/.test(line));
  if (!fence) return undefined;
  const marker = /^ {0,3}(```+|~~~+)/.exec(fence)![1]!;
  const count = lines.filter((line) => new RegExp(`^ {0,3}${marker[0]}{${marker.length},}`).test(line)).length;
  return count % 2 ? marker : undefined;
};

/** Returns a render-only completion. The original stream is never changed. */
export function repairMarkdown(source: string): string {
  const marker = unclosedFence(source);
  if (marker) return `${source}\n${marker}`;
  let repaired = source;
  const tickRuns = [...repaired.matchAll(/(?<!\\)(`+)/g)];
  let openTicks: RegExpMatchArray | undefined;
  for (const run of tickRuns) {
    if (!openTicks) openTicks = run;
    else if (openTicks[1]!.length === run[1]!.length) openTicks = undefined;
  }
  if (openTicks) repaired += openTicks[1];
  const openLink = repaired.lastIndexOf("](");
  if (openLink > repaired.lastIndexOf(")")) repaired += ")";
  else if (repaired.lastIndexOf("[") > repaired.lastIndexOf("]")) repaired += "]()";
  for (const marker of ["**", "__", "~~", "*", "_"])
    if (unescapedCount(repaired, marker) % 2) repaired += marker;
  return repaired;
}

export interface StreamingDocument {
  readonly source: string;
  readonly stats: Readonly<{ frozenParses: number; tailParses: number }>;
  append(delta: string): void;
  finish(): void;
  render(): readonly Block[];
}

export function createStreamingDocument(): StreamingDocument {
  let source = "";
  let tail = "";
  let finished = false;
  const frozen: Block[] = [];
  const stats = { frozenParses: 0, tailParses: 0 };
  let revision = 0;
  let renderedRevision = -1;
  let rendered: readonly Block[] = [];

  const freeze = (all = false) => {
    let end = all ? tail.length : tail.lastIndexOf("\n\n");
    if (end < 0) return;
    if (!all) end += 2;
    const complete = tail.slice(0, end);
    const parsed = parseMarkdown(complete);
    frozen.push(...(all ? parsed.map((block) => block.type === "code" ? { ...block, open: false } : block) : parsed));
    stats.frozenParses += parsed.length;
    tail = tail.slice(end);
  };

  return {
    get source() { return source; },
    get stats() { return stats; },
    append(delta) {
      if (finished) throw new Error("cannot append to a finished markdown document");
      if (!delta) return;
      source += delta;
      tail += delta;
      freeze();
      revision++;
    },
    finish() { if (!finished) { finished = true; freeze(true); revision++; } },
    render() {
      if (renderedRevision === revision) return rendered;
      const open = tail ? parseMarkdown(finished ? tail : repairMarkdown(tail)) : [];
      if (!finished && unclosedFence(tail)) {
        const code = open.at(-1);
        if (code?.type === "code") open[open.length - 1] = { ...code, open: true };
      }
      if (tail) stats.tailParses++;
      rendered = [...frozen, ...open];
      renderedRevision = revision;
      return rendered;
    },
  };
}
