import type { ToolCardProps } from "./common.js";
import { CappedText, toolOutput } from "./common.js";

export function SearchTool({ item }: ToolCardProps) {
  if (item.view?.kind !== "search") return null;
  const matches = item.view.matches?.join("\n") || toolOutput(item);
  return <section data-tool-view="search"><header><code>{item.view.pattern}</code>{item.view.path ? <span data-part="tool-meta">{item.view.path}</span> : null}</header>{matches ? <CappedText part="tool-matches">{matches}</CappedText> : null}</section>;
}
