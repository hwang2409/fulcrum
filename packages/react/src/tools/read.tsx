import { languageForPath } from "@fulcrum/highlight/languages";
import type { ToolBodyProps } from "../parts.js";
import type { Block } from "../highlight.js";
import { Arguments, asking, boundText, cutByHeader, Empty, Foot, NumberedLines, numberedBlocks, Output, outputBlocks, sourceText } from "./common.js";

// A failed or canceled read returns a reason, not file lines, so it gets no line numbers; nor does a cut read, whose
// tail would be numbered from the cut.
export function ReadBody({ item, output, state }: ToolBodyProps) {
  if (item.view?.kind !== "read") return null;
  const { path, range } = item.view;
  const id = `${item.id}:content`;
  const text = sourceText(output);
  return (
    <>
      {asking(state) && cutByHeader(path) ? <pre data-part="tool-path">{boundText(path).text}</pre> : null}
      {text ? (item.is_error || item.canceled || output.omission
        ? <Output text={text} id={id} />
        : <NumberedLines text={text} start={(range?.offset ?? 0) + 1} id={id} language={languageForPath(path)} done={state !== "streaming"} />
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
  return !text ? [] : item.is_error || item.canceled || output.omission ? outputBlocks({ text, id }) : numberedBlocks({ text, id, language: languageForPath(item.view.path), done: state !== "streaming" });
}
