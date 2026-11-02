import { useMemo } from "react";
import type { ToolBodyProps } from "../parts.js";
import { Arguments, asking, Foot, Output } from "./common.js";
import { needsTextViewer, TextViewer, useTextMetrics } from "./text-viewer.js";
import { diffRows, type DiffRow } from "./diff.js";

const sign = { hunk: "", notice: "", context: " ", delete: "-", insert: "+" } as const;
const tone = { hunk: undefined, notice: undefined, context: undefined, delete: "tok-deleted", insert: "tok-inserted" } as const;

function Line({ row }: { row: DiffRow }) {
  const text = row.word && row.word[1] > row.word[0]
    ? <>{row.text.slice(0, row.word[0])}<mark data-part="diff-word">{row.text.slice(...row.word)}</mark>{row.text.slice(row.word[1])}</>
    : row.text;
  return (
    <div data-part="diff-line" data-change={row.change}>
      <span data-part="diff-gutter">{row.old ?? ""}</span>
      <span data-part="diff-gutter">{row.new ?? ""}</span>
      <span data-part="diff-sign" className={tone[row.change]}>{sign[row.change]}</span>
      <span data-part="diff-text">{text}</span>
    </div>
  );
}

export function EditBody({ item, output, state }: ToolBodyProps) {
  const diff = item.view?.kind === "edit" ? item.view.diff : "";
  const metrics = useTextMetrics(diff);
  const large = needsTextViewer(diff, metrics);
  const rows = useMemo(() => large ? [] : diffRows(diff), [diff, large]);
  if (item.view?.kind !== "edit") return null;
  return (
    <>
      {large ? <TextViewer text={diff} label="diff" metrics={metrics} /> : (
        <div data-part="tool-diff">
          {rows.map((row, index) => <Line key={index} row={row} />)}
        </div>
      )}
      {output ? <Output text={output} /> : null}
      {asking(state) ? <Arguments call={item.tool_call} /> : null}
      <Foot copy={[["path", item.view.path], ["diff", diff]]} />
    </>
  );
}
