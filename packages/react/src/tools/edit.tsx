import { useMemo, type ReactNode } from "react";
import { languageForPath } from "@fulcrum/highlight/languages";
import type { ToolBodyProps } from "../parts.js";
import { MarkedTokens, tokenLines, useTokens } from "../highlight.js";
import { Arguments, asking, boundText, Foot, Output } from "./common.js";
import { ROW_CHARS, TextViewer, useTextMetrics, type RowModel } from "./text-viewer.js";
import { diffRows, type DiffRow } from "./diff.js";
import type { Token } from "@fulcrum/highlight";

const sign = { hunk: "", notice: "", context: " ", delete: "-", insert: "+" } as const;
const tone = { hunk: undefined, notice: undefined, context: undefined, delete: "tok-deleted", insert: "tok-inserted" } as const;

function Line({ row, tokens }: { row: DiffRow; tokens?: Token[] }) {
  const ranges: Array<[number, number]> = row.word && row.word[1] > row.word[0] ? [row.word] : [];
  let text: ReactNode = row.text;
  if (tokens) text = <MarkedTokens tokens={tokens} ranges={ranges} part="diff-word" />;
  else if (ranges.length) text = <>{row.text.slice(0, row.word![0])}<mark data-part="diff-word">{row.text.slice(...row.word!)}</mark>{row.text.slice(row.word![1])}</>;
  return (
    <div data-part="diff-line" data-change={row.change}>
      <span data-part="diff-gutter">{row.old ?? ""}</span>
      <span data-part="diff-gutter">{row.new ?? ""}</span>
      <span data-part="diff-sign" className={tone[row.change]}>{sign[row.change]}</span>
      <span data-part="diff-text">{text}</span>
    </div>
  );
}

// Each side of the diff is highlighted as one block of the file's language (old: context and deleted lines, new:
// context and inserted lines), so a line keeps the grammar state of the lines above it on its own side.
function sides(rows: DiffRow[]) {
  const old: string[] = [];
  const next: string[] = [];
  const at = rows.map((row) => {
    if (row.change === "delete" || row.change === "context") old.push(row.text);
    if (row.change === "insert" || row.change === "context") next.push(row.text);
    return row.change === "delete" ? old.length - 1 : row.change === "insert" || row.change === "context" ? next.length - 1 : -1;
  });
  return { old: old.join("\n"), next: next.join("\n"), at };
}

/** Rows [start, end) of a diff, highlighted as their own block: every edit view draws its rows through this. */
function DiffLines({ rows, start, end, language, id }: { rows: DiffRow[]; start: number; end: number; language?: string; id: string }) {
  const shown = useMemo(() => rows.slice(start, end), [rows, start, end]);
  const side = useMemo(() => sides(shown), [shown]);
  const oldTokens = useTokens(side.old, language, `${id}@${start}:old`);
  const newTokens = useTokens(side.next, language, `${id}@${start}:new`);
  const oldLines = useMemo(() => oldTokens && tokenLines(oldTokens), [oldTokens]);
  const newLines = useMemo(() => newTokens && tokenLines(newTokens), [newTokens]);
  return shown.map((row, index) => {
    const lines = row.change === "delete" ? oldLines : newLines;
    return <Line key={start + index} row={row} tokens={side.at[index]! >= 0 ? lines?.[side.at[index]!] : undefined} />;
  });
}

const capped = (row: DiffRow) => (row.text.length > ROW_CHARS ? { ...row, text: boundText(row.text, ROW_CHARS).text } : row);

export function EditBody({ item, output, state }: ToolBodyProps) {
  const view = item.view?.kind === "edit" ? item.view : undefined;
  const diff = view?.diff ?? "";
  const metrics = useTextMetrics(diff);
  const language = view ? languageForPath(view.path) : undefined;
  const id = `${item.id}:diff`;
  const model = useMemo((): RowModel => {
    const rows = diffRows(diff).map(capped);
    return { count: rows.length, part: "tool-diff", language, render: (start, end) => <DiffLines rows={rows} start={start} end={end} language={language} id={id} /> };
  }, [diff, language, id]);
  if (!view) return null;
  return (
    <>
      <TextViewer text={diff} id={id} label="diff" metrics={metrics} rows={model} />
      {output ? <Output text={output} id={`${item.id}:output`} done={state !== "streaming"} /> : null}
      {asking(state) ? <Arguments call={item.tool_call} id={item.id} /> : null}
      <Foot copy={[["path", view.path], ["diff", diff]]} />
    </>
  );
}
