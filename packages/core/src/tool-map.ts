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

const lines = (text: string) => (text === "" ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n"));
const range = (start: number, count: number) => (count === 1 ? `${start}` : `${count ? start : 0},${count}`);
// Above this many cells the quadratic table costs more than the diff is worth: show all old lines, then all new ones.
const MAX_DIFF_CELLS = 4_000_000;

/**
 * One unified-diff hunk from a before and after text, for tool maps whose edit tools take old and new strings.
 * Line numbers count from the start of `before`, since the harness gives no position in the file.
 */
export function lineDiff(before: string, after: string): string {
  const a = lines(before);
  const b = lines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const body: string[] = a.slice(0, head).map((line) => ` ${line}`);
  if (x.length * y.length > MAX_DIFF_CELLS) {
    body.push(...x.map((line) => `-${line}`), ...y.map((line) => `+${line}`));
  } else {
    // Longest common subsequence table, filled from the end so the walk below runs forward.
    const width = y.length + 1;
    const table = new Uint32Array((x.length + 1) * width);
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        table[i * width + j] = x[i] === y[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) body.push(` ${x[i++]}`), j++;
      else if (j >= y.length || (i < x.length && table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) body.push(`-${x[i++]}`);
      else body.push(`+${y[j++]}`);
    }
  }
  body.push(...a.slice(a.length - tail).map((line) => ` ${line}`));
  return [`@@ -${range(1, a.length)} +${range(1, b.length)} @@`, ...body].join("\n");
}
