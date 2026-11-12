import type { ToolBodyProps } from "../parts.js";
import type { Block } from "../highlight.js";
import { Arguments, asking, Empty, Foot, Output, outputBlocks, sourceText } from "./common.js";

/** Any tool without a view: its output (JSON highlighted), then the raw JSON arguments (open in an approval, collapsed otherwise). */
export function GenericBody({ item, output, state }: ToolBodyProps) {
  const text = sourceText(output);
  return (
    <>
      {text ? <Output text={text} id={`${item.id}:output`} done={state !== "streaming"} pretty follow={state === "streaming"} source={output} /> : <Empty state={state} />}
      <Arguments call={item.tool_call} id={item.id} open={asking(state)} />
      <Foot copy={[["output", text]]} />
    </>
  );
}

/** The highlight blocks GenericBody asks for when it first mounts (its arguments stay closed outside an approval). */
export function genericBlocks({ item, output, state }: ToolBodyProps): Block[] {
  const text = sourceText(output);
  return text ? outputBlocks({ text, id: `${item.id}:output`, done: state !== "streaming", pretty: true }) : [];
}
