import { languageForPath } from "@fulcrum/highlight/languages";
import type { ToolBodyProps } from "../parts.js";
import type { Block } from "../highlight.js";
import { Arguments, asking, boundText, cutByHeader, cutRows, Empty, Foot, NumberedLines, numberedBlocks, Output, outputBlocks, sourceText } from "./common.js";

// A failed or canceled read returns a reason, not file lines, so it gets no line numbers; nor does one the run let go of
// whole. A read cut in the middle stays a numbered, highlighted file view: its tail keeps the file's own line numbers.
const numbered = ({ item, output }: ToolBodyProps) => !item.is_error && !item.canceled && !output.omission?.whole;
export function ReadBody({ item, output, state }: ToolBodyProps) {
  if (item.view?.kind !== "read") return null;
  const { path, range } = item.view;
  const id = `${item.id}:content`;
  const text = sourceText(output);
  return (
    <>
      {asking(state) && cutByHeader(path) ? <pre data-part="tool-path">{boundText(path).text}</pre> : null}
      {text ? (numbered({ item, output, state })
        ? <NumberedLines text={text} start={(range?.offset ?? 0) + 1} id={id} language={languageForPath(path)} done={state !== "streaming"} cut={cutRows(output)} />
        : <Output text={text} id={id} />
      ) : <Empty state={state} noun="content" />}
      {asking(state) ? <Arguments call={item.tool_call} id={item.id} /> : null}
      <Foot copy={[["path", path], ["output", text]]} />
    </>
  );
}

/** The highlight blocks ReadBody asks for when it first mounts. */
export function readBlocks({ item, output, state }: ToolBodyProps): Block[] {
  if (item.view?.kind !== "read") return [];
  const id = `${item.id}:content`;
  const text = sourceText(output);
  return !text ? [] : numbered({ item, output, state }) ? numberedBlocks({ text, id, language: languageForPath(item.view.path), done: state !== "streaming" }) : outputBlocks({ text, id });
}
