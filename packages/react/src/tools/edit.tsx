import { useMemo, type ReactNode } from "react";
import { languageForPath } from "@fulcrum/highlight/languages";
import type { ToolBodyProps } from "../parts.js";
import { MarkedTokens, tokenLines, useTokens } from "../highlight.js";
import { Arguments, asking, Foot, Output } from "./common.js";
import { needsTextViewer, TextViewer, useTextMetrics } from "./text-viewer.js";
import { diffRows, type DiffRow } from "./diff.js";
import type { Token } from "@fulcrum/highlight";

const sign = { hunk: "", notice: "", context: " ", delete: "-", insert: "+" } as const;
const tone = { hunk: undefined, notice: undefined, context: undefined, delete: "tok-deleted", insert: "tok-inserted" } as const;
const DIFF_FORMAT = { language: "diff" };

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

export function EditBody({ item, output, state }: ToolBodyProps) {
  const view = item.view?.kind === "edit" ? item.view : undefined;
  const diff = view?.diff ?? "";
  const metrics = useTextMetrics(diff);
  const large = needsTextViewer(diff, metrics);
  const rows = useMemo(() => large ? [] : diffRows(diff), [diff, large]);
  const side = useMemo(() => sides(rows), [rows]);
  const language = view ? languageForPath(view.path) : undefined;
  const oldTokens = useTokens(side.old, language, `${item.id}:old`);
  const newTokens = useTokens(side.next, language, `${item.id}:new`);
  const oldLines = useMemo(() => oldTokens && tokenLines(oldTokens), [oldTokens]);
  const newLines = useMemo(() => newTokens && tokenLines(newTokens), [newTokens]);
  if (!view) return null;
  return (
    <>
      {large ? <TextViewer text={diff} id={`${item.id}:diff`} label="diff" metrics={metrics} format={DIFF_FORMAT} /> : (
        <div data-part="tool-diff" data-language={language}>
          {rows.map((row, index) => {
            const lines = row.change === "delete" ? oldLines : newLines;
            return <Line key={index} row={row} tokens={side.at[index]! >= 0 ? lines?.[side.at[index]!] : undefined} />;
          })}
        </div>
      )}
      {output ? <Output text={output} id={`${item.id}:output`} done={state !== "streaming"} /> : null}
      {asking(state) ? <Arguments call={item.tool_call} id={item.id} /> : null}
      <Foot copy={[["path", view.path], ["diff", diff]]} />
    </>
  );
}
