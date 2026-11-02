import type { ToolCardProps } from "./common.js";
import { CappedText, toolOutput } from "./common.js";

export function ReadTool({ item }: ToolCardProps) {
  if (item.view?.kind !== "read") return null;
  const { path, range } = item.view;
  const start = range?.offset;
  const end = start !== undefined && range?.limit !== undefined ? start + range.limit - 1 : undefined;
  const label = `${path}${start !== undefined ? `:${start}${end !== undefined ? `-${end}` : ""}` : ""}`;
  const output = toolOutput(item);
  return <section data-tool-view="read"><header><code>{label}</code></header>{output ? <details><summary>content</summary><CappedText>{output}</CappedText></details> : null}</section>;
}
