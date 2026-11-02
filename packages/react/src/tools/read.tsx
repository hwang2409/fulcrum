import { languageForPath } from "@fulcrum/highlight/languages";
import type { ToolBodyProps } from "../parts.js";
import { Arguments, asking, boundText, Empty, Foot, NumberedLines, Output } from "./common.js";

// A failed or canceled read returns a reason, not file lines, so it gets no line numbers.
export function ReadBody({ item, output, state }: ToolBodyProps) {
  if (item.view?.kind !== "read") return null;
  const { path, range } = item.view;
  const id = `${item.id}:content`;
  return (
    <>
      {asking(state) ? <pre data-part="tool-path">{boundText(path).text}</pre> : null}
      {output ? (item.is_error || item.canceled
        ? <Output text={output} id={id} />
        : <NumberedLines text={output} start={(range?.offset ?? 0) + 1} id={id} language={languageForPath(path)} done={state !== "streaming"} />
      ) : <Empty state={state} noun="content" />}
      {asking(state) ? <Arguments call={item.tool_call} id={item.id} /> : null}
      <Foot copy={[["path", path], ["output", output]]} />
    </>
  );
}
