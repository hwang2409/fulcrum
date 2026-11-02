import type { ToolCardProps } from "./common.js";
import { CappedText, toolOutput } from "./common.js";

export function ShellTool({ item }: ToolCardProps) {
  if (item.view?.kind !== "shell") return null;
  const output = toolOutput(item);
  return <section data-tool-view="shell"><header><code>$ {item.view.command}</code>{item.view.cwd ? <span data-part="tool-meta">{item.view.cwd}</span> : null}</header>{output ? <CappedText>{output}</CappedText> : null}{item.view.exitCode !== undefined ? <footer data-part="tool-status">exit {item.view.exitCode}</footer> : null}</section>;
}
