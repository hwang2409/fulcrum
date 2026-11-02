import type { ToolCardProps } from "./common.js";
import { bytes, CappedText, CopyButton, EmptyOutput, ToolMeta, toolOutput } from "./common.js";

export function FetchTool({ item }: ToolCardProps) {
  if (item.view?.kind !== "fetch") return null;
  const target = item.view.url ?? item.view.query;
  const output = toolOutput(item);
  return (
    <section data-tool-view="fetch">
      <header>
        {item.view.title ? <strong>{item.view.title}</strong> : null}
        <code>{target}</code>
        <CopyButton value={target} label={item.view.url ? "url" : "query"} />
        {item.view.bytes !== undefined ? <span data-part="tool-meta">{bytes(item.view.bytes)}</span> : null}
        <ToolMeta view={item.view} />
      </header>
      {output ? <details><summary>response</summary><CappedText>{output}</CappedText></details> : <EmptyOutput item={item} noun="response" />}
    </section>
  );
}
