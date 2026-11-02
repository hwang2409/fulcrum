import { useMemo } from "react";
import { languageForPath } from "@fulcrum/highlight";
import type { ToolBodyProps } from "../parts.js";
import { MarkedTokens, tokenLines, useTokens } from "../highlight.js";
import { Arguments, asking, boundText, Empty, Foot, Output, splitLines } from "./common.js";
import { needsTextViewer, TextViewer, useTextMetrics } from "./text-viewer.js";

// `path:line:text` (grep -n, ripgrep), or `path-line-text` for ripgrep context lines.
const MATCH = /^(.+?):(\d+):(.*)$/;
const CONTEXT = /^(.+?)-(\d+)-(.*)$/;
type Group = { path: string; lines: Array<{ number: number; text: string; match: boolean }> };

// Groups consecutive matches by file; returns undefined when the output is not in grep format.
function group(lines: string[]) {
  const groups: Group[] = [];
  for (const line of lines) {
    const match = MATCH.exec(line);
    const found = match ?? CONTEXT.exec(line);
    if (!found) return undefined;
    const [, path, number, text] = found;
    const last = groups.at(-1);
    const entry = { number: Number(number), text: text!, match: !!match };
    if (last?.path === path) last.lines.push(entry);
    else groups.push({ path: path!, lines: [entry] });
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

function File({ file, pattern, id }: { file: Group; pattern: string; id: string }) {
  const tokens = useTokens(file.lines.map((line) => line.text).join("\n"), languageForPath(file.path), id);
  const lines = useMemo(() => tokens && tokenLines(tokens), [tokens]);
  const matches = file.lines.filter((line) => line.match).length;
  return (
    <div data-part="search-file">
      <div data-part="search-head"><span data-part="search-path">{file.path}</span><span data-part="search-count">{matches}</span></div>
      {file.lines.map((line, j) => (
        <div key={j} data-part="line" data-match={line.match || undefined}>
          <span data-part="line-number">{line.number}</span>
          <span data-part="line-text"><MarkedTokens tokens={lines?.[j] ?? [{ text: line.text }]} ranges={line.match ? matchRanges(line.text, pattern) : []} part="search-match" /></span>
        </div>
      ))}
    </div>
  );
}

export function SearchBody({ item, output, state }: ToolBodyProps) {
  const text = item.view?.kind === "search" ? item.view.matches?.join("\n") ?? output : "";
  const metrics = useTextMetrics(text, true);
  const large = needsTextViewer(text, metrics);
  const groups = useMemo(() => large ? undefined : group(splitLines(text)), [large, text]);
  if (item.view?.kind !== "search") return null;
  const { pattern, path } = item.view;
  const matches = groups?.reduce((sum, file) => sum + file.lines.filter((line) => line.match).length, 0);
  return (
    <>
      {asking(state) ? <pre data-part="tool-path">{boundText(path ? `${pattern} in ${path}` : pattern).text}</pre> : null}
      {!text ? <Empty state={state} noun="matches" /> : large ? <TextViewer text={text} id={`${item.id}:results`} label="search results" appendOnly metrics={metrics} done={state !== "streaming"} /> : groups ? (
        <div data-part="tool-matches">
          {groups.map((file, i) => <File key={i} file={file} pattern={pattern} id={`${item.id}:file-${i}`} />)}
        </div>
      ) : <Output text={text} id={`${item.id}:output`} done={state !== "streaming"} />}
      {asking(state) ? <Arguments call={item.tool_call} id={item.id} /> : null}
      <Foot copy={[["pattern", pattern], ["output", text]]}>
        {matches !== undefined ? <span data-part="search-total">{matches} {matches === 1 ? "match" : "matches"} in {groups!.length} {groups!.length === 1 ? "file" : "files"}</span> : null}
      </Foot>
    </>
  );
}
