import { useMemo, type CSSProperties, type ReactNode } from "react";
import { languageForPath } from "@fulcrum/highlight/languages";
import type { ToolBodyProps } from "../parts.js";
import { MarkedTokens, tokenLines, useTokens, type Block } from "../highlight.js";
import { Arguments, asking, boundText, Foot, memoText, Output, outputBlocks } from "./common.js";
import { ROW_CHARS, TextViewer, useTextMetrics, viewerBlocks, type RowModel } from "./text-viewer.js";
import { diffRows, type DiffRow } from "./diff.js";
import type { Token } from "@fulcrum/highlight";

const sign = { hunk: "", notice: "", context: " ", delete: "-", insert: "+" } as const;
const tone = { hunk: undefined, notice: undefined, context: undefined, delete: "tok-deleted", insert: "tok-inserted" } as const;

function Line({ row, tokens, gutter }: { row: DiffRow; tokens?: Token[]; gutter: CSSProperties }) {
  const ranges: Array<[number, number]> = row.word && row.word[1] > row.word[0] ? [row.word] : [];
  let text: ReactNode = row.text;
  if (tokens) text = <MarkedTokens tokens={tokens} ranges={ranges} part="diff-word" />;
  else if (ranges.length) text = <>{row.text.slice(0, row.word![0])}<mark data-part="diff-word">{row.text.slice(...row.word!)}</mark>{row.text.slice(row.word![1])}</>;
  return (
    <div data-part="diff-line" data-change={row.change} style={gutter}>
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

// The two blocks of rows [start, end): the old side and the new side.
const sideBlocks = (side: { old: string; next: string }, language: string | undefined, id: string, start: number): [Block, Block] =>
  [{ code: side.old, language, id: `${id}@${start}:old` }, { code: side.next, language, id: `${id}@${start}:new` }];

/** Rows [start, end) of a diff, highlighted as their own block: every edit view draws its rows through this. */
function DiffLines({ rows, start, end, language, id, gutter }: { rows: DiffRow[]; start: number; end: number; language?: string; id: string; gutter: CSSProperties }) {
  const shown = useMemo(() => rows.slice(start, end), [rows, start, end]);
  const side = useMemo(() => sides(shown), [shown]);
  const [oldBlock, newBlock] = sideBlocks(side, language, id, start);
  const oldTokens = useTokens(oldBlock.code, language, oldBlock.id);
  const newTokens = useTokens(newBlock.code, language, newBlock.id);
  const oldLines = useMemo(() => oldTokens && tokenLines(oldTokens), [oldTokens]);
  const newLines = useMemo(() => newTokens && tokenLines(newTokens), [newTokens]);
  return shown.map((row, index) => {
    const lines = row.change === "delete" ? oldLines : newLines;
    return <Line key={start + index} row={row} tokens={side.at[index]! >= 0 ? lines?.[side.at[index]!] : undefined} gutter={gutter} />;
  });
}

const capped = (row: DiffRow) => (row.text.length > ROW_CHARS ? { ...row, text: boundText(row.text, ROW_CHARS).text } : row);
const rowsOf = memoText((diff) => {
  const rows = diffRows(diff).map(capped);
  // Both number columns fit the largest line number, so every row (and every viewer group) aligns.
  let last = 0;
  for (const row of rows) last = Math.max(last, row.old ?? 0, row.new ?? 0);
  return { rows, gutter: { "--diff-gutter": `${Math.max(4, String(last).length) + 1}ch` } as CSSProperties };
});

function diffModel(diff: string, language: string | undefined, id: string): RowModel {
  const { rows, gutter } = rowsOf(diff);
  return {
    count: rows.length,
    part: "tool-diff",
    language,
    render: (start, end) => <DiffLines rows={rows} start={start} end={end} language={language} id={id} gutter={gutter} />,
    blocks: (start, end) => sideBlocks(sides(rows.slice(start, end)), language, id, start),
    size: (index) => rows[index]!.text.length,
  };
}

/** The highlight blocks EditBody asks for when it first mounts. */
export function editBlocks({ item, output, state }: ToolBodyProps): Block[] {
  if (item.view?.kind !== "edit") return [];
  const id = `${item.id}:diff`;
  const { diff, path } = item.view;
  return [...viewerBlocks({ text: diff, id, rows: diffModel(diff, languageForPath(path), id) }), ...(output ? outputBlocks({ text: output, id: `${item.id}:output`, done: state !== "streaming" }) : [])];
}

export function EditBody({ item, output, state }: ToolBodyProps) {
  const view = item.view?.kind === "edit" ? item.view : undefined;
  const diff = view?.diff ?? "";
  const metrics = useTextMetrics(diff);
  const language = view ? languageForPath(view.path) : undefined;
  const id = `${item.id}:diff`;
  const model = useMemo(() => diffModel(diff, language, id), [diff, language, id]);
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
