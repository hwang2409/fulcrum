import type { ToolCardProps } from "./common.js";
import { bytes } from "./common.js";

export function WriteTool({ item }: ToolCardProps) {
  if (item.view?.kind !== "write") return null;
  return <section data-tool-view="write"><header><code>{item.view.path}</code>{item.view.bytes !== undefined ? <span data-part="tool-meta">{bytes(item.view.bytes)}</span> : null}</header></section>;
}
