import { useMemo } from "react";
import { languageForPath } from "@fulcrum/highlight/languages";
import type { ToolBodyProps } from "../parts.js";
import { MarkedTokens, tokenLines, useTokens } from "../highlight.js";
import { Arguments, asking, boundText, Empty, Foot, Output, splitLines } from "./common.js";
import { ROW_CHARS, TextViewer, useTextMetrics, type RowModel } from "./text-viewer.js";

// `path:line:text` (grep -n, ripgrep), or `path-line-text` for ripgrep context lines.
const MATCH = /^(.+?):(\d+):(.*)$/;
const CONTEXT = /^(.+?)-(\d+)-(.*)$/;
type Group = { path: string; matches: number; lines: Array<{ number: number; text: string; match: boolean }> };

// Groups consecutive matches by file; returns undefined when the output is not in grep format.
function group(lines: string[]) {
  const groups: Group[] = [];
  for (const line of lines) {
    const match = MATCH.exec(line);
    const found = match ?? CONTEXT.exec(line);
    if (!found) return undefined;
    const [, path, number, text] = found;
    const last = groups.at(-1);
    const entry = { number: Number(number), text: text!.length > ROW_CHARS ? boundText(text!, ROW_CHARS).text : text!, match: !!match };
    const file = last?.path === path ? last : groups[groups.push({ path: path!, matches: 0, lines: [] }) - 1]!;
    file.lines.push(entry);
    if (match) file.matches++;
  }
  return groups;
}

const META = /[\\^$.|?*+()[\]{}]/;
// shortcut: marks literal patterns and alternations of literals (`TODO|FIXME`); other regexes stay unmarked, since
// running an agent's arbitrary regex on the main thread can backtrack for seconds. Use the tool's match offsets if a
// harness reports them.
export function matchRanges(text: string, pattern: string): Array<[number, number]> {
  const literals = pattern.split("|");
  if (!pattern || literals.some((literal) => !literal || META.test(literal))) return [];
  const find = (haystack: string) => {
    const ranges: Array<[number, number]> = [];
    for (const literal of literals) {
      const needle = haystack === text ? literal : literal.toLowerCase();
      for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) ranges.push([at, at + needle.length]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    return ranges.filter((range, index) => index === 0 || range[0] >= ranges[index - 1]![1]);
  };
  const exact = find(text);
  const lower = text.toLowerCase();
  // A case-insensitive search (-i) matched; lowercasing must keep offsets, so only when it keeps the length.
  return exact.length || lower.length !== text.length ? exact : find(lower);
}

/** Lines [from, to) of one file, highlighted as their own block; the head shows with the file's first line. */
function File({ file, from, to, pattern, id }: { file: Group; from: number; to: number; pattern: string; id: string }) {
  const shown = useMemo(() => file.lines.slice(from, to), [file, from, to]);
  const tokens = useTokens(useMemo(() => shown.map((line) => line.text).join("\n"), [shown]), languageForPath(file.path), `${id}@${from}`);
  const lines = useMemo(() => tokens && tokenLines(tokens), [tokens]);
  return (
    <div data-part="search-file">
      {from === 0 ? <div data-part="search-head"><span data-part="search-path">{file.path}</span><span data-part="search-count">{file.matches}</span></div> : null}
      {shown.map((line, j) => (
        <div key={from + j} data-part="line" data-match={line.match || undefined}>
          <span data-part="line-number">{line.number}</span>
          <span data-part="line-text"><MarkedTokens tokens={lines?.[j] ?? [{ text: line.text }]} ranges={line.match ? matchRanges(line.text, pattern) : []} part="search-match" /></span>
        </div>
      ))}
    </div>
  );
}

// Rows are the lines of every file in order; rows [start, end) draw each file they cross through File.
function searchRows(groups: Group[], pattern: string, id: string): RowModel {
  const starts: number[] = [];
  let count = 0;
  for (const file of groups) { starts.push(count); count += file.lines.length; }
  const render = (start: number, end: number) => {
    const out = [];
    let low = 0;
    for (let high = groups.length - 1; low < high;) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid]! <= start) low = mid;
      else high = mid - 1;
    }
    for (let g = low; g < groups.length && starts[g]! < end; g++) {
      const from = Math.max(0, start - starts[g]!);
      out.push(<File key={g} file={groups[g]!} from={from} to={Math.min(groups[g]!.lines.length, end - starts[g]!)} pattern={pattern} id={`${id}:file-${g}`} />);
    }
    return out;
  };
  return { count, part: "tool-matches", render };
}

export function SearchBody({ item, output, state }: ToolBodyProps) {
  const view = item.view?.kind === "search" ? item.view : undefined;
  const text = view ? view.matches?.join("\n") ?? output : "";
  const metrics = useTextMetrics(text, true);
  const groups = useMemo(() => group(splitLines(text)), [text]);
  const pattern = view?.pattern ?? "";
  const model = useMemo(() => groups && searchRows(groups, pattern, item.id), [groups, pattern, item.id]);
  if (!view) return null;
  const { path } = view;
  const matches = groups?.reduce((sum, file) => sum + file.matches, 0);
  return (
    <>
      {asking(state) ? <pre data-part="tool-path">{boundText(path ? `${pattern} in ${path}` : pattern).text}</pre> : null}
      {!text ? <Empty state={state} noun="matches" /> : model
        ? <TextViewer text={text} id={`${item.id}:results`} label="search results" appendOnly metrics={metrics} done={state !== "streaming"} rows={model} />
        : <Output text={text} id={`${item.id}:output`} done={state !== "streaming"} />}
      {asking(state) ? <Arguments call={item.tool_call} id={item.id} /> : null}
      <Foot copy={[["pattern", pattern], ["output", text]]}>
        {text && matches !== undefined ? <span data-part="search-total">{matches} {matches === 1 ? "match" : "matches"} in {groups!.length} {groups!.length === 1 ? "file" : "files"}</span> : null}
      </Foot>
    </>
  );
}
