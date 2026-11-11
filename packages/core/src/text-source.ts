import type {
  ContentBlock,
  StoredResultBlock,
  StoredToolResult,
  StoredToolView,
  TextChunk,
  TextOmission,
  TextSourceSnapshot,
  ToolResult,
  ToolView,
} from "./events.js";
import { appendText } from "./stream.js";

export const DEFAULT_TOOL_OUTPUT_ITEM_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TOOL_OUTPUT_RUN_BYTES = 10 * 1024 * 1024;
export const PROTECTED_COMPLETED_TOOLS = 3;
const CHUNK_BYTES = 32 * 1024;
const encoder = new TextEncoder();

const utf8Bytes = (text: string) => encoder.encode(text).byteLength;
const lineCount = (text: string) => text === "" ? 0 : 1 + (text.match(/\n/g)?.length ?? 0) - Number(text.endsWith("\n"));
const canonical = (text: string) => text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\ufffd");
const ansiBoundary = (text: string, at: number, direction: "left" | "right") => {
  let start = -1, mode: "csi" | "osc" | "escape" | null = null;
  for (let index = 0; index < at; index++) {
    const code = text.charCodeAt(index);
    if (!mode && code === 0x1b) start = index, mode = "escape";
    else if (mode === "escape") {
      if (text[index] === "[") mode = "csi";
      else if (text[index] === "]") mode = "osc";
      else mode = null;
    } else if (mode === "csi" && code >= 0x40 && code <= 0x7e) mode = null;
    else if (mode === "osc" && (code === 7 || (code === 0x1b && text[index + 1] === "\\"))) mode = null;
  }
  if (!mode) return at;
  if (direction === "left") return start;
  for (let index = at; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (mode === "escape") return index + 1;
    if (mode === "csi" && code >= 0x40 && code <= 0x7e) return index + 1;
    if (mode === "osc" && code === 7) return index + 1;
    if (mode === "osc" && code === 0x1b && text[index + 1] === "\\") return index + 2;
  }
  return text.length;
};
const safeBoundary = (text: string, at: number, direction: "left" | "right") => {
  let value = Math.max(0, Math.min(text.length, ansiBoundary(text, at, direction)));
  if (value > 0 && value < text.length) {
    const before = text.charCodeAt(value - 1);
    const after = text.charCodeAt(value);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) value += direction === "right" ? 1 : -1;
    if (text.charCodeAt(value - 1) === 13 && text.charCodeAt(value) === 10) value += direction === "right" ? 1 : -1;
  }
  return value;
};
const prefixForBytes = (text: string, budget: number) => {
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(text.slice(0, safeBoundary(text, middle, "left"))) <= budget) low = middle;
    else high = middle - 1;
  }
  return safeBoundary(text, low, "left");
};
const suffixForBytes = (text: string, budget: number, floor: number, knownBytes = utf8Bytes(text)) => {
  const removeBytes = Math.max(0, knownBytes - budget);
  let at = floor, removed = 0;
  while (at < text.length && removed < removeBytes) {
    const code = text.codePointAt(at)!;
    removed += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    at += code > 0xffff ? 2 : 1;
  }
  at = Math.max(floor, safeBoundary(text, at, "right"));
  while (at < text.length && utf8Bytes(text.slice(at)) > budget) at = safeBoundary(text, at + (text.codePointAt(at)! > 0xffff ? 2 : 1), "right");
  return at;
};
// Copy numeric code units so a retained substring cannot keep its larger parent alive.
const owned = (text: string, start: number, end: number) => {
  const units = new Uint16Array(end - start);
  for (let index = 0; index < units.length; index++) units[index] = text.charCodeAt(start + index);
  let result = "";
  for (let index = 0; index < units.length; index += 8_192)
    result += String.fromCharCode(...units.subarray(index, Math.min(units.length, index + 8_192)));
  return result;
};
type StoredChunk = TextChunk & { readonly byteLength: number };
const chunkBytes = (chunk: TextChunk) => (chunk as StoredChunk).byteLength ?? utf8Bytes(chunk.text);
const chunksOf = (text: string, logicalStart: number, logicalLine: number): StoredChunk[] => {
  const chunks: StoredChunk[] = [];
  let at = 0, line = logicalLine;
  while (at < text.length) {
    let end = prefixForBytes(text.slice(at), CHUNK_BYTES) + at;
    if (end <= at) end = safeBoundary(text, at + 1, "right");
    const value = owned(text, at, end);
    chunks.push(Object.freeze({ start: logicalStart + at, line, text: value, byteLength: utf8Bytes(value) }));
    line += value.match(/\n/g)?.length ?? 0;
    at = end;
  }
  return chunks;
};

type TextBox = { text: string };
const firstBox = (text: string): TextBox => appendText({ text: "" }, undefined, "text", () => "", text);
const nextBox = (previous: TextBox, text: string): TextBox => appendText({ text: "" }, previous, "text", () => previous.text, text);
class Source implements TextSourceSnapshot {
  constructor(
    readonly version: number,
    readonly length: number,
    readonly bytes: number,
    readonly lines: number,
    readonly retainedBytes: number,
    readonly omission: TextOmission | null,
    readonly protocolTruncated: boolean,
    private readonly values: readonly TextChunk[],
    readonly pendingHigh = "",
    readonly box?: TextBox,
    readonly headRetainedBytes = omission?.start ?? retainedBytes,
  ) { Object.freeze(values); Object.freeze(this); }
  *chunks(): IterableIterator<TextChunk> { yield* this.box ? chunksOf(this.box.text, 0, 0) : this.values; }
}
const sourceText = (source: TextSourceSnapshot) => [...source.chunks()].map(({ text }) => text).join("");
const lineAt = (text: string, end: number) => text.slice(0, end).match(/\n/g)?.length ?? 0;

function buildTextSource(value: string, limit: number, reason: TextOmission["reason"], protocolTruncated: boolean, version: number, pendingHigh = ""): TextSourceSnapshot {
  const bytes = utf8Bytes(value);
  const lines = lineCount(value);
  if (bytes <= limit) {
    const valueCopy = owned(value, 0, value.length);
    return new Source(version, value.length, bytes, lines, bytes, null, protocolTruncated, [], pendingHigh, firstBox(valueCopy));
  }
  const headBudget = Math.floor(limit / 4);
  const headEnd = prefixForBytes(value, headBudget);
  const tailStart = suffixForBytes(value, limit - utf8Bytes(value.slice(0, headEnd)), headEnd);
  const head = owned(value, 0, headEnd);
  const tail = owned(value, tailStart, value.length);
  const retainedBytes = utf8Bytes(head) + utf8Bytes(tail);
  const omission = Object.freeze({ kind: "omitted" as const, reason, start: headEnd, end: tailStart, bytes: bytes - retainedBytes, whole: headEnd === 0 && tailStart === value.length });
  return new Source(version, value.length, bytes, lines, retainedBytes, omission, protocolTruncated, [...chunksOf(head, 0, 0), ...chunksOf(tail, tailStart, lineAt(value, tailStart))], pendingHigh, undefined, utf8Bytes(head));
}
export function createTextSource(text: string, limit = DEFAULT_TOOL_OUTPUT_ITEM_BYTES, reason: TextOmission["reason"] = "item-cap", protocolTruncated = false, version = 1): TextSourceSnapshot {
  return buildTextSource(canonical(text), limit, reason, protocolTruncated, version);
}
const streamingDelta = (text: string, pendingHigh = "") => {
  let input = pendingHigh + text;
  let pending = "";
  const last = input.charCodeAt(input.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) pending = input.at(-1)!, input = input.slice(0, -1);
  return { text: canonical(input), pending };
};
export function createStreamingTextSource(text: string, limit = DEFAULT_TOOL_OUTPUT_ITEM_BYTES): TextSourceSnapshot {
  const step = streamingDelta(text);
  return buildTextSource(step.text, limit, "item-cap", false, 1, step.pending);
}
const asSource = (source: TextSourceSnapshot) => source as Source;
export function finalizeTextSource(source: TextSourceSnapshot, limit = DEFAULT_TOOL_OUTPUT_ITEM_BYTES): TextSourceSnapshot {
  return asSource(source).pendingHigh ? appendTextSource(source, "", limit, true) : source;
}

export function markProtocolTruncated(source: TextSourceSnapshot): TextSourceSnapshot {
  return source.protocolTruncated ? source : new Source(source.version + 1, source.length, source.bytes, source.lines, source.retainedBytes, source.omission, true, [...source.chunks()], asSource(source).pendingHigh, asSource(source).box, asSource(source).headRetainedBytes);
}

export function omitTextSource(source: TextSourceSnapshot, reason: TextOmission["reason"]): TextSourceSnapshot {
  if (source.retainedBytes === 0 && source.omission?.whole && source.omission.reason === reason) return source;
  const omission = Object.freeze({ kind: "omitted" as const, reason, start: 0, end: source.length, bytes: source.bytes, whole: true });
  return new Source(source.version + 1, source.length, source.bytes, source.lines, 0, omission, source.protocolTruncated, [], asSource(source).pendingHigh, undefined, 0);
}

export function limitTextSource(source: TextSourceSnapshot, limit: number, reason: TextOmission["reason"]): TextSourceSnapshot {
  if (source.retainedBytes <= limit) return source;
  const retained = sourceText(source);
  const limited = createTextSource(retained, limit, reason, source.protocolTruncated, source.version + 1);
  if (!source.omission) return new Source(limited.version, limited.length, limited.bytes, limited.lines, limited.retainedBytes, limited.omission, limited.protocolTruncated, [...limited.chunks()], asSource(source).pendingHigh, undefined, limited.omission?.start ?? limited.retainedBytes);
  // A second cut can only retain less. Preserve the original logical totals and report all missing bytes.
  const chunks = [...limited.chunks()];
  const omission = Object.freeze({ kind: "omitted" as const, reason, start: chunks[0]?.text.length ?? 0, end: source.length - (chunks.at(-1)?.text.length ?? 0), bytes: source.bytes - limited.retainedBytes, whole: limited.retainedBytes === 0 });
  const headBytes = chunks.filter((chunk) => chunk.start < omission.start).reduce((sum, chunk) => sum + chunkBytes(chunk), 0);
  return new Source(source.version + 1, source.length, source.bytes, source.lines, limited.retainedBytes, omission, source.protocolTruncated, chunks, asSource(source).pendingHigh, undefined, headBytes);
}

export function appendTextSource(source: TextSourceSnapshot, delta: string, limit = DEFAULT_TOOL_OUTPUT_ITEM_BYTES, final = false): TextSourceSnapshot {
  const step = streamingDelta(delta, asSource(source).pendingHigh);
  const added = step.text + (final && step.pending ? "\ufffd" : "");
  const pendingHigh = final ? "" : step.pending;
  if (!added && pendingHigh === asSource(source).pendingHigh) return source;
  if (!source.omission && source.bytes + utf8Bytes(added) <= limit) {
    const box = nextBox(asSource(source).box ?? firstBox(sourceText(source)), owned(added, 0, added.length));
    return new Source(source.version + 1, source.length + added.length, source.bytes + utf8Bytes(added), source.lines + (added.match(/\n/g)?.length ?? 0), source.retainedBytes + utf8Bytes(added), null, source.protocolTruncated, [], pendingHigh, box);
  }
  if (!source.omission) return buildTextSource(sourceText(source) + added, limit, "item-cap", source.protocolTruncated, source.version + 1, pendingHigh);
  const chunks = [...source.chunks()];
  const headChunks = chunks.filter(({ start }) => start < source.omission!.start);
  const headBytes = asSource(source).headRetainedBytes;
  const candidates = [
    ...chunks.filter(({ start }) => start >= source.omission!.end),
    ...chunksOf(owned(added, 0, added.length), source.length, source.lines),
  ];
  const tailBudget = Math.max(0, limit - headBytes);
  const tailChunks: TextChunk[] = [];
  let tailBytes = 0;
  for (let index = candidates.length - 1; index >= 0 && tailBytes < tailBudget; index--) {
    const chunk = candidates[index]!;
    const room = tailBudget - tailBytes;
    const bytes = chunkBytes(chunk);
    if (bytes <= room) tailChunks.unshift(chunk), tailBytes += bytes;
    else {
      const start = suffixForBytes(chunk.text, room, 0, bytes);
      const value = owned(chunk.text, start, chunk.text.length);
      if (value) {
        const byteLength = utf8Bytes(value);
        tailChunks.unshift(Object.freeze({ start: chunk.start + start, line: chunk.line + (chunk.text.slice(0, start).match(/\n/g)?.length ?? 0), text: value, byteLength }));
        tailBytes += byteLength;
      }
    }
  }
  const logicalLength = source.length + added.length;
  const logicalBytes = source.bytes + utf8Bytes(added);
  const retainedBytes = headBytes + tailBytes;
  const tailLogicalStart = tailChunks[0]?.start ?? logicalLength;
  const omission = Object.freeze({ kind: "omitted" as const, reason: "item-cap" as const, start: source.omission.start, end: tailLogicalStart, bytes: logicalBytes - retainedBytes, whole: retainedBytes === 0 });
  return new Source(source.version + 1, logicalLength, logicalBytes, source.lines + (added.match(/\n/g)?.length ?? 0), retainedBytes, omission, source.protocolTruncated, [...headChunks, ...tailChunks], pendingHigh, undefined, headBytes);
}

export const emptyTextSource = () => createTextSource("");
export const retainedText = sourceText;

export function storeToolView(view: ToolView | undefined, limit = DEFAULT_TOOL_OUTPUT_ITEM_BYTES): StoredToolView | undefined {
  if (!view) return undefined;
  switch (view.kind) {
    case "shell": return { kind: "shell", command: view.command, ...(view.cwd === undefined ? {} : { cwd: view.cwd }), ...(view.exitCode === undefined ? {} : { exitCode: view.exitCode }), ...(view.stdout === undefined ? {} : { stdout: createTextSource(view.stdout, limit) }), ...(view.stderr === undefined ? {} : { stderr: createTextSource(view.stderr, limit) }), ...(view.durationMs === undefined ? {} : { durationMs: view.durationMs }) };
    case "edit": return { ...view, diff: createTextSource(view.diff, limit) };
    case "write": return { kind: "write", path: view.path, ...(view.content === undefined ? {} : { content: createTextSource(view.content, limit) }), ...(view.bytes === undefined ? {} : { bytes: view.bytes }), ...(view.durationMs === undefined ? {} : { durationMs: view.durationMs }) };
    case "search": return { kind: "search", pattern: view.pattern, ...(view.path === undefined ? {} : { path: view.path }), ...(view.matches === undefined ? {} : { matches: view.matches.map((match) => createTextSource(match, limit)) }), ...(view.durationMs === undefined ? {} : { durationMs: view.durationMs }) };
    default: return view;
  }
}
const storeBlock = (block: ContentBlock, limit: number): StoredResultBlock => {
  const { text, ...metadata } = block as ContentBlock & { text?: unknown };
  return Object.freeze({ metadata, ...(typeof text === "string" ? { text: createTextSource(text, limit) } : {}) });
};
export function storeToolResult(result: ToolResult, relation: StoredToolResult["relation"], finalContent: TextSourceSnapshot | undefined, limit: number): StoredToolResult {
  return Object.freeze({
    tool_call_id: result.tool_call_id,
    is_error: result.is_error,
    ...(result.is_canceled === undefined ? {} : { is_canceled: result.is_canceled }),
    ...(result.blocks === undefined ? {} : { blocks: result.blocks.map((block) => storeBlock(block, limit)) }),
    ...(result.truncated === undefined ? {} : { truncated: result.truncated }),
    relation,
    ...(finalContent ? { finalContent } : {}),
  });
}
