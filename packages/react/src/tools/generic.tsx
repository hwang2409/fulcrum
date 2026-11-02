import type { ToolBodyProps } from "../parts.js";
import { Arguments, asking, Empty, Foot, Output } from "./common.js";

/** Any tool without a view: its output (JSON highlighted), then the raw JSON arguments (open in an approval, collapsed otherwise). */
export function GenericBody({ item, output, state }: ToolBodyProps) {
  return (
    <>
      {output ? <Output text={output} id={`${item.id}:output`} done={state !== "streaming"} pretty follow={state === "streaming"} /> : <Empty state={state} />}
      <Arguments call={item.tool_call} id={item.id} open={asking(state)} />
      <Foot copy={[["output", output]]} />
    </>
  );
}
