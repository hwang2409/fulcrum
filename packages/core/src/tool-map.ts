import type { RunItem, ToolCall, ToolView } from "./events.js";

export interface ToolArguments {
  value(name: string): unknown;
  string(name: string): string | undefined;
  number(name: string): number | undefined;
  object(name: string): Record<string, unknown> | undefined;
  array(name: string): readonly unknown[] | undefined;
}

export type ToolViewResolver = (args: ToolArguments) => ToolView | undefined;
export type ToolMap = Readonly<Record<string, ToolViewResolver>>;

/** Preserve tool names while checking every resolver against the public view contract. */
export const defineToolMap = <const Map extends ToolMap>(map: Map): Map => map;

const argumentsFor = (values: Record<string, unknown>): ToolArguments => ({
  value: (name) => values[name],
  string: (name) => typeof values[name] === "string" ? values[name] : undefined,
  number: (name) => typeof values[name] === "number" ? values[name] : undefined,
  object: (name) => {
    const value = values[name];
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  },
  array: (name) => Array.isArray(values[name]) ? values[name] : undefined,
});

/** Resolve a harness tool call. Invalid arguments and resolver errors safely produce no hint. */
export function resolveToolView(map: ToolMap, call: ToolCall): ToolView | undefined {
  try {
    return map[call.name]?.(argumentsFor(call.arguments));
  } catch {
    return undefined;
  }
}

/** Add a resolved hint to a core tool item without changing unknown tools. */
export function applyToolMap(
  map: ToolMap,
  item: Extract<RunItem, { type: "tool" }>,
): Extract<RunItem, { type: "tool" }> {
  const view = resolveToolView(map, item.tool_call);
  return view ? { ...item, view } : item;
}

type DiffLine = { text: string; newline: boolean };
type DiffOp = { change: "context" | "delete" | "insert"; line: DiffLine };

const lines = (text: string): DiffLine[] => {
  if (text === "") return [];
  const values = text.split("\n");
  const finalNewline = values.at(-1) === "";
  if (finalNewline) values.pop();
  return values.map((value, index) => ({ text: value, newline: index < values.length - 1 || finalNewline }));
};
const sameLine = (a: DiffLine, b: DiffLine) => a.text === b.text && a.newline === b.newline;
const range = (start: number, count: number) => (count === 1 ? `${start}` : `${count ? start : 0},${count}`);
const CONTEXT = 3;
// Myers runs only between stable anchors. A region over this distance becomes an exact delete/add block.
const MAX_MYERS_DISTANCE = 256;

function backtrack(trace: ReadonlyArray<ReadonlyMap<number, number>>, a: DiffLine[], b: DiffLine[], distance: number): DiffOp[] {
  const reversed: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = distance; d > 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    const previousK = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? k + 1 : k - 1;
    const previousX = v.get(previousK) ?? 0;
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) reversed.push({ change: "context", line: a[--x]! }), y--;
    if (x === previousX) reversed.push({ change: "insert", line: b[--y]! });
    else reversed.push({ change: "delete", line: a[--x]! });
  }
  while (x > 0 && y > 0) reversed.push({ change: "context", line: a[--x]! }), y--;
  while (x > 0) reversed.push({ change: "delete", line: a[--x]! });
  while (y > 0) reversed.push({ change: "insert", line: b[--y]! });
  return reversed.reverse();
}

function diffRegion(a: DiffLine[], b: DiffLine[]): DiffOp[] {
  if (!a.length) return b.map((line) => ({ change: "insert", line }));
  if (!b.length) return a.map((line) => ({ change: "delete", line }));
  const limit = Math.min(a.length + b.length, MAX_MYERS_DISTANCE);
  let v = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];
  for (let d = 0; d <= limit; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? v.get(k + 1) ?? 0 : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < a.length && y < b.length && sameLine(a[x]!, b[y]!)) x++, y++;
      v.set(k, x);
      if (x >= a.length && y >= b.length) return backtrack(trace, a, b, d);
    }
  }
  return [...a.map((line): DiffOp => ({ change: "delete", line })), ...b.map((line): DiffOp => ({ change: "insert", line }))];
}

const lineKey = (line: DiffLine) => `${line.newline ? "1" : "0"}${line.text}`;
type Anchor = { old: number; next: number };

// Patience anchors: unique common lines, ordered by the longest increasing sequence in the new file.
function anchors(a: DiffLine[], b: DiffLine[]): Anchor[] {
  const old = new Map<string, { count: number; index: number }>();
  const next = new Map<string, { count: number; index: number }>();
  for (let index = 0; index < a.length; index++) {
    const key = lineKey(a[index]!);
    const found = old.get(key);
    old.set(key, found ? { count: found.count + 1, index: found.index } : { count: 1, index });
  }
  for (let index = 0; index < b.length; index++) {
    const key = lineKey(b[index]!);
    const found = next.get(key);
    next.set(key, found ? { count: found.count + 1, index: found.index } : { count: 1, index });
  }
  const candidates: Anchor[] = [];
  for (const [key, value] of old) {
    const match = next.get(key);
    if (value.count === 1 && match?.count === 1) candidates.push({ old: value.index, next: match.index });
  }
  candidates.sort((left, right) => left.old - right.old);
  const tails: number[] = [];
  const previous = new Array<number>(candidates.length).fill(-1);
  for (let index = 0; index < candidates.length; index++) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (candidates[tails[middle]!]!.next < candidates[index]!.next) low = middle + 1;
      else high = middle;
    }
    if (low) previous[index] = tails[low - 1]!;
    tails[low] = index;
  }
  const result: Anchor[] = [];
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]!) result.push(candidates[index]!);
  return result.reverse();
}

function diffOps(a: DiffLine[], b: DiffLine[]): DiffOp[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && sameLine(a[prefix]!, b[prefix]!)) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && sameLine(a[a.length - suffix - 1]!, b[b.length - suffix - 1]!)) suffix++;
  const middleA = a.slice(prefix, a.length - suffix);
  const middleB = b.slice(prefix, b.length - suffix);
  const stable = anchors(middleA, middleB);
  const ops = a.slice(0, prefix).map((line): DiffOp => ({ change: "context", line }));
  let old = 0;
  let next = 0;
  for (const anchor of stable) {
    ops.push(...diffRegion(middleA.slice(old, anchor.old), middleB.slice(next, anchor.next)));
    ops.push({ change: "context", line: middleA[anchor.old]! });
    old = anchor.old + 1;
    next = anchor.next + 1;
  }
  ops.push(...diffRegion(middleA.slice(old), middleB.slice(next)));
  ops.push(...a.slice(a.length - suffix).map((line): DiffOp => ({ change: "context", line })));
  return ops;
}

const countsBefore = (ops: DiffOp[], kind: "old" | "new") => {
  const counts = [0];
  for (const op of ops) counts.push(counts.at(-1)! + (op.change !== (kind === "old" ? "insert" : "delete") ? 1 : 0));
  return counts;
};

type LineEnding = "CRLF" | "LF";
const lineEnding = (text: string): LineEnding | undefined => {
  let lf = 0;
  let crlf = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) !== 10) continue;
    lf++;
    if (index && text.charCodeAt(index - 1) === 13) crlf++;
  }
  return !lf ? undefined : crlf === lf ? "CRLF" : crlf === 0 ? "LF" : undefined;
};

/** Conventional three-context hunks. Whole-file CRLF/LF changes are normalized and shown as a note. */
export function lineDiff(before: string, after: string): string {
  const beforeEnding = lineEnding(before);
  const afterEnding = lineEnding(after);
  const changedEnding = beforeEnding && afterEnding && beforeEnding !== afterEnding;
  if (changedEnding) {
    if (beforeEnding === "CRLF") before = before.replaceAll("\r\n", "\n");
    if (afterEnding === "CRLF") after = after.replaceAll("\r\n", "\n");
  }
  const note = changedEnding ? `\\ Line endings changed from ${beforeEnding} to ${afterEnding}` : "";
  const ops = diffOps(lines(before), lines(after));
  const changes = ops.flatMap((op, index) => op.change === "context" ? [] : [index]);
  if (!changes.length) return note;
  const hunks: Array<[number, number]> = [];
  for (const index of changes) {
    const start = Math.max(0, index - CONTEXT);
    const end = Math.min(ops.length, index + CONTEXT + 1);
    const previous = hunks.at(-1);
    if (previous && start < previous[1]) previous[1] = Math.max(previous[1], end);
    else hunks.push([start, end]);
  }
  const oldBefore = countsBefore(ops, "old");
  const newBefore = countsBefore(ops, "new");
  const output: string[] = [];
  for (const [start, end] of hunks) {
    const oldCount = oldBefore[end]! - oldBefore[start]!;
    const newCount = newBefore[end]! - newBefore[start]!;
    const oldStart = oldCount ? oldBefore[start]! + 1 : oldBefore[start]!;
    const newStart = newCount ? newBefore[start]! + 1 : newBefore[start]!;
    output.push(`@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`);
    for (const op of ops.slice(start, end)) {
      output.push(`${op.change === "context" ? " " : op.change === "delete" ? "-" : "+"}${op.line.text}`);
      if (!op.line.newline) output.push("\\ No newline at end of file");
    }
  }
  return [...(note ? [note] : []), ...output].join("\n");
}
