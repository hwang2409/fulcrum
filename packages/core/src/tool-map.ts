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
// Myers is linear for the common small-edit case. Beyond this edit distance, a complete delete/add fallback is clearer and bounded.
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

function diffOps(a: DiffLine[], b: DiffLine[]): DiffOp[] {
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

const countsBefore = (ops: DiffOp[], kind: "old" | "new") => {
  const counts = [0];
  for (const op of ops) counts.push(counts.at(-1)! + (op.change !== (kind === "old" ? "insert" : "delete") ? 1 : 0));
  return counts;
};

/** Conventional unified-diff hunks with three context lines. Work is bounded when edits are extremely large. */
export function lineDiff(before: string, after: string): string {
  const ops = diffOps(lines(before), lines(after));
  const changes = ops.flatMap((op, index) => op.change === "context" ? [] : [index]);
  if (!changes.length) return "";
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
  return output.join("\n");
}
