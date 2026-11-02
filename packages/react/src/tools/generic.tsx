import type { ToolCardProps } from "./common.js";
import { CappedText, toolOutput } from "./common.js";

const summary = (args: Record<string, unknown>) => Object.entries(args).slice(0, 3).map(([key, value]) => `${key}: ${typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : "…"}`).join(" · ");

export function GenericTool({ item }: ToolCardProps) {
  const output = toolOutput(item);
  return <section data-tool-view="generic"><header><strong>{item.tool_call.name}</strong><span data-part="tool-meta">{summary(item.tool_call.arguments)}</span></header><details><summary>arguments</summary><pre data-part="tool-args">{JSON.stringify(item.tool_call.arguments, null, 2)}</pre></details>{output ? <CappedText>{output}</CappedText> : null}</section>;
}
