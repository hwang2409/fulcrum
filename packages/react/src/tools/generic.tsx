import type { ToolBodyProps } from "../parts.js";
import { Arguments, asking, Foot, Output } from "./common.js";

/** Any tool without a view: its output, then the raw JSON arguments (open in an approval, collapsed otherwise). */
export function GenericBody({ item, output, state }: ToolBodyProps) {
  return (
    <>
      {output ? <Output text={output} /> : null}
      <Arguments call={item.tool_call} open={asking(state)} />
      <Foot copy={[["output", output]]} />
    </>
  );
}
