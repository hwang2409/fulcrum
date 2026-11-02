import type { ToolBodyProps } from "../parts.js";
import { Arguments, asking, boundText, Empty, Foot, NumberedLines, Output } from "./common.js";

// A failed or canceled read returns a reason, not file lines, so it gets no line numbers.
export function ReadBody({ item, output, state }: ToolBodyProps) {
  if (item.view?.kind !== "read") return null;
  const { path, range } = item.view;
  return (
    <>
      {asking(state) ? <pre data-part="tool-path">{boundText(path).text}</pre> : null}
      {output ? (item.is_error || item.canceled ? <Output text={output} /> : <NumberedLines text={output} start={(range?.offset ?? 0) + 1} />) : <Empty state={state} noun="content" />}
      {asking(state) ? <Arguments call={item.tool_call} version={item.version} /> : null}
      <Foot copy={[["path", path], ["output", output]]} />
    </>
  );
}
