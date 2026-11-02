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
