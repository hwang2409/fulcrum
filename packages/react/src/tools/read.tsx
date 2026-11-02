import type { ToolCardProps } from "./common.js";
import { CappedText, CopyButton, EmptyOutput, ToolMeta, toolOutput } from "./common.js";

export function ReadTool({ item }: ToolCardProps) {
  if (item.view?.kind !== "read") return null;
  const { path, range } = item.view;
  const label = `${path}${range?.offset !== undefined ? `:${range.offset}${range.limit !== undefined ? `+${range.limit}` : ""}` : ""}`;
  const output = toolOutput(item);
  return (
    <section data-tool-view="read">
      <header><code>{label}</code><CopyButton value={path} label="path" /><ToolMeta view={item.view} /></header>
      {output ? <details><summary>content</summary><CappedText>{output}</CappedText></details> : <EmptyOutput item={item} noun="content" />}
    </section>
  );
}
