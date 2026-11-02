import { memo } from "react";
import { useItem } from "../hooks.js";
import type { ItemProps } from "../parts.js";
import { EditTool } from "./edit.js";
import { FetchTool } from "./fetch.js";
import { GenericTool } from "./generic.js";
import { ReadTool } from "./read.js";
import { SearchTool } from "./search.js";
import { ShellTool } from "./shell.js";
import { WriteTool } from "./write.js";

export { EditTool } from "./edit.js";
export { FetchTool } from "./fetch.js";
export { GenericTool } from "./generic.js";
export { ReadTool } from "./read.js";
export { SearchTool } from "./search.js";
export { ShellTool } from "./shell.js";
export { WriteTool } from "./write.js";
export { CappedText, type ToolCardProps, type ToolItem } from "./common.js";

export const ToolBody = memo(function ToolBody({ id, onOpenRun }: ItemProps & { onOpenRun?: (childRunId: string) => void }) {
  const item = useItem(id);
  if (item?.type !== "tool") return null;
  const props = { item, onOpenRun };
  switch (item.view?.kind) {
    case "shell": return <ShellTool {...props} />;
    case "read": return <ReadTool {...props} />;
    case "edit": return <EditTool {...props} />;
    case "write": return <WriteTool {...props} />;
    case "search": return <SearchTool {...props} />;
    case "fetch": return <FetchTool {...props} />;
    default: return <GenericTool {...props} />;
  }
});
