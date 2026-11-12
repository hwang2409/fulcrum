import { languageForPath } from "@fulcrum/highlight/languages";
import type { ToolBodyProps } from "../parts.js";
import type { Block } from "../highlight.js";
import { Arguments, asking, boundText, cutByHeader, bytes, Foot, NumberedLines, numberedBlocks, Output, outputBlocks, sourceText } from "./common.js";

export function WriteBody({ item, output, state }: ToolBodyProps) {
  if (item.view?.kind !== "write") return null;
  const { path, bytes: size } = item.view;
  const content = item.view.content && sourceText(item.view.content);
  const shown = sourceText(output);
  return (
    <>
      {asking(state) && cutByHeader(path) ? <pre data-part="tool-path">{boundText(path).text}</pre> : null}
      {content ? (item.view.content!.omission
        ? <Output text={content} id={`${item.id}:content`} source={item.view.content} />
        : <NumberedLines text={content} id={`${item.id}:content`} language={languageForPath(path)} source={item.view.content} />) : null}
      {shown ? <Output text={shown} id={`${item.id}:output`} done={state !== "streaming"} source={output} /> : null}
      {asking(state) ? <Arguments call={item.tool_call} id={item.id} /> : null}
      <Foot copy={[["path", path], ["content", content]]}>
        {size !== undefined ? <span data-part="tool-size">{bytes(size)}</span> : null}
      </Foot>
    </>
  );
}

/** The highlight blocks WriteBody asks for when it first mounts. */
export function writeBlocks({ item, output, state }: ToolBodyProps): Block[] {
  if (item.view?.kind !== "write") return [];
  const { path } = item.view;
  const content = item.view.content && sourceText(item.view.content);
  const shown = sourceText(output);
  return [
    ...(content ? (item.view.content!.omission ? outputBlocks({ text: content, id: `${item.id}:content` }) : numberedBlocks({ text: content, id: `${item.id}:content`, language: languageForPath(path) })) : []),
    ...(shown ? outputBlocks({ text: shown, id: `${item.id}:output`, done: state !== "streaming" }) : []),
  ];
}
