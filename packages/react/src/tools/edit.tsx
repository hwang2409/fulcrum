import type { ToolCardProps } from "./common.js";

export function EditTool({ item }: ToolCardProps) {
  if (item.view?.kind !== "edit") return null;
  const { path, diff } = item.view;
  const lines = diff.split("\n");
  return <section data-tool-view="edit"><header><code>{path}</code></header><pre data-part="tool-diff">{lines.map((line, index) => <span key={index} className={line.startsWith("+") && !line.startsWith("+++") ? "tok-inserted" : line.startsWith("-") && !line.startsWith("---") ? "tok-deleted" : undefined}>{line}</span>)}</pre></section>;
}
