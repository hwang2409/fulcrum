import type { ToolBodyProps } from "../parts.js";
import { Arguments, asking, bytes, Foot, NumberedLines, Output } from "./common.js";

export function WriteBody({ item, output, state }: ToolBodyProps) {
  if (item.view?.kind !== "write") return null;
  const { path, content, bytes: size } = item.view;
  return (
    <>
      {asking(state) ? <pre data-part="tool-path">{path}</pre> : null}
      {content ? <NumberedLines text={content} /> : null}
      {output ? <Output text={output} /> : null}
      {asking(state) ? <Arguments call={item.tool_call} /> : null}
      <Foot copy={[["path", path], ["content", content]]}>
        {size !== undefined ? <span data-part="tool-size">{bytes(size)}</span> : null}
      </Foot>
    </>
  );
}
