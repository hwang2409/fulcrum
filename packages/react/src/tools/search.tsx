import type { ToolCardProps } from "./common.js";
import { CappedText, CopyButton, EmptyOutput, ToolMeta, toolOutput } from "./common.js";

export function SearchTool({ item }: ToolCardProps) {
  if (item.view?.kind !== "search") return null;
  const matches = item.view.matches?.join("\n") || toolOutput(item);
  return (
    <section data-tool-view="search">
      <header>
        <code>{item.view.pattern}</code>
        <CopyButton value={item.view.pattern} label="search pattern" />
        {item.view.path ? <span data-part="tool-meta">{item.view.path}</span> : null}
        <ToolMeta view={item.view} />
      </header>
      {matches ? <CappedText part="tool-matches">{matches}</CappedText> : <EmptyOutput item={item} noun="matches" />}
    </section>
  );
}
