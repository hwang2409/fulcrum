import type { ToolCardProps } from "./common.js";
import { CappedText, CopyButton, EmptyOutput, ToolMeta, toolOutput } from "./common.js";

export function ShellTool({ item }: ToolCardProps) {
  if (item.view?.kind !== "shell") return null;
  const output = toolOutput(item);
  return (
    <section data-tool-view="shell">
      <header>
        <code>$ {item.view.command}</code>
        <CopyButton value={item.view.command} label="command" />
        {item.view.cwd ? <span data-part="tool-meta">{item.view.cwd}</span> : null}
        <ToolMeta view={item.view} />
      </header>
      {output ? <CappedText>{output}</CappedText> : <EmptyOutput item={item} />}
      {item.view.exitCode !== undefined ? <footer data-part="tool-exit" data-exit-code={item.view.exitCode}>exit {item.view.exitCode}</footer> : null}
    </section>
  );
}
