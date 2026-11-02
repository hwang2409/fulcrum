import type { ToolCardProps } from "./common.js";
import { CappedText, CopyButton, ToolMeta } from "./common.js";

export function EditTool({ item }: ToolCardProps) {
  if (item.view?.kind !== "edit") return null;
  const { path, diff } = item.view;
  return (
    <section data-tool-view="edit">
      <header><code>{path}</code><CopyButton value={path} label="path" /><ToolMeta view={item.view} /></header>
      <CappedText
        part="tool-diff"
        renderLine={(line) => (
          <span className={
            line.startsWith("+") && !line.startsWith("+++") ? "tok-inserted" :
            line.startsWith("-") && !line.startsWith("---") ? "tok-deleted" : undefined
          }>{line}</span>
        )}
      >{diff}</CappedText>
    </section>
  );
}
