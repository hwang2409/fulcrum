import { languageForPath } from "@fulcrum/highlight/languages";
import type { ToolBodyProps } from "../parts.js";
import type { Block } from "../highlight.js";
import { Arguments, asking, boundText, cutByHeader, Empty, Foot, NumberedLines, numberedBlocks, Output, outputBlocks } from "./common.js";

// A failed or canceled read returns a reason, not file lines, so it gets no line numbers.
export function ReadBody({ item, output, state }: ToolBodyProps) {
  if (item.view?.kind !== "read") return null;
  const { path, range } = item.view;
  const id = `${item.id}:content`;
  return (
    <>
      {asking(state) && cutByHeader(path) ? <pre data-part="tool-path">{boundText(path).text}</pre> : null}
      {output ? (item.is_error || item.canceled
        ? <Output text={output} id={id} />
        : <NumberedLines text={output} start={(range?.offset ?? 0) + 1} id={id} language={languageForPath(path)} done={state !== "streaming"} />
      ) : <Empty state={state} noun="content" />}
      {asking(state) ? <Arguments call={item.tool_call} id={item.id} /> : null}
      <Foot copy={[["path", path], ["output", output]]} />
    </>
  );
}

/** The highlight blocks ReadBody asks for when it first mounts. */
export function readBlocks({ item, output, state }: ToolBodyProps): Block[] {
  if (item.view?.kind !== "read" || !output) return [];
  const id = `${item.id}:content`;
  return item.is_error || item.canceled ? outputBlocks({ text: output, id }) : numberedBlocks({ text: output, id, language: languageForPath(item.view.path), done: state !== "streaming" });
}
