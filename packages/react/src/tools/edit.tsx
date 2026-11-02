import { useMemo, useState } from "react";
import type { ToolBodyProps } from "../parts.js";
import { Arguments, asking, bound, boundText, Foot, Gap, Output, ShowAll } from "./common.js";
import { diffRows, diffStat, type DiffRow } from "./diff.js";

const sign = { hunk: "", context: " ", delete: "-", insert: "+" } as const;
const tone = { hunk: undefined, context: undefined, delete: "tok-deleted", insert: "tok-inserted" } as const;

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

const rowChrome = (row: DiffRow) => String(row.old ?? "").length + String(row.new ?? "").length + 1;
const cutRow = (row: DiffRow, chars: number): DiffRow => ({ ...row, text: boundText(row.text, Math.max(0, chars - rowChrome(row))).text, word: undefined });

export function EditBody({ item, output, state }: ToolBodyProps) {
  const diff = item.view?.kind === "edit" ? item.view.diff : "";
  const rows = useMemo(() => diffRows(diff), [diff]);
  // An approval shows the whole change (up to the DOM cap): it is what the user decides on.
  const [expanded, setExpanded] = useState(asking(state));
  if (item.view?.kind !== "edit") return null;
  const window = bound(rows, expanded, (row) => row.text.length + rowChrome(row), cutRow);
  const hidden = diffStat(rows.slice(window.head.length, window.tailFrom));
  const hiddenNoun = `lines (+${hidden.insert} -${hidden.remove})`;
  return (
    <>
      <div data-part="tool-diff">
        {window.head.map((row, i) => <Line key={i} row={row} />)}
        <Gap window={window} expanded={expanded} noun={hiddenNoun} />
        {window.tail.map((row, i) => <Line key={window.tailFrom + i} row={row} />)}
      </div>
      <ShowAll window={window} expanded={expanded} expand={() => setExpanded(true)} />
      {output ? <Output text={output} /> : null}
      {asking(state) ? <Arguments call={item.tool_call} /> : null}
      <Foot copy={[["path", item.view.path], ["diff", diff]]} />
    </>
  );
}
