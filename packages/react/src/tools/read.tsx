import type { ToolBodyProps } from "../parts.js";
import { Arguments, asking, Empty, Foot, NumberedLines } from "./common.js";

export function ReadBody({ item, output, state }: ToolBodyProps) {
  if (item.view?.kind !== "read") return null;
  const { path, range } = item.view;
  return (
    <>
      {asking(state) ? <pre data-part="tool-path">{path}</pre> : null}
      {output ? (item.is_error ? <pre data-part="tool-output">{output}</pre> : <NumberedLines text={output} start={(range?.offset ?? 0) + 1} />) : <Empty state={state} noun="content" />}
      {asking(state) ? <Arguments call={item.tool_call} /> : null}
      <Foot copy={[["path", path], ["output", output]]} />
    </>
  );
}
