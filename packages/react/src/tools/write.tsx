import type { ToolCardProps } from "./common.js";
import { bytes, CappedText, CopyButton, EmptyOutput, ToolMeta, toolOutput } from "./common.js";

export function WriteTool({ item }: ToolCardProps) {
  if (item.view?.kind !== "write") return null;
  const output = toolOutput(item);
  return (
    <section data-tool-view="write">
      <header>
        <code>{item.view.path}</code>
        <CopyButton value={item.view.path} label="path" />
        {item.view.bytes !== undefined ? <span data-part="tool-meta">{bytes(item.view.bytes)}</span> : null}
        <ToolMeta view={item.view} />
      </header>
      {output ? <CappedText>{output}</CappedText> : <EmptyOutput item={item} />}
    </section>
  );
}
