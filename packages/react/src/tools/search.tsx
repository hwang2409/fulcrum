import { useMemo } from "react";
import type { ToolBodyProps } from "../parts.js";
import { Arguments, asking, boundText, Empty, Foot, Output, splitLines } from "./common.js";
import { needsTextViewer, TextViewer, useTextMetrics } from "./text-viewer.js";

// `path:line:text` (grep -n, ripgrep), or `path-line-text` for ripgrep context lines.
const MATCH = /^(.+?):(\d+):(.*)$/;
const CONTEXT = /^(.+?)-(\d+)-(.*)$/;
type Group = { path: string; lines: Array<{ number: number; text: string }> };

// Groups consecutive matches by file; returns undefined when the output is not in grep format.
function group(lines: string[]) {
  const groups: Group[] = [];
  for (const line of lines) {
    const match = MATCH.exec(line) ?? CONTEXT.exec(line);
    if (!match) return undefined;
    const [, path, number, text] = match;
    const last = groups.at(-1);
    const entry = { number: Number(number), text: text! };
    if (last?.path === path) last.lines.push(entry);
    else groups.push({ path: path!, lines: [entry] });
  }
  return groups;
}

export function SearchBody({ item, output, state }: ToolBodyProps) {
  const text = item.view?.kind === "search" ? item.view.matches?.join("\n") ?? output : "";
  const metrics = useTextMetrics(text, true);
  const large = needsTextViewer(text, metrics);
  const groups = useMemo(() => large ? undefined : group(splitLines(text)), [large, text]);
  if (item.view?.kind !== "search") return null;
  return (
    <>
      {asking(state) ? <pre data-part="tool-path">{boundText(item.view.path ? `${item.view.pattern} in ${item.view.path}` : item.view.pattern).text}</pre> : null}
      {!text ? <Empty state={state} noun="matches" /> : large ? <TextViewer text={text} label="search results" appendOnly metrics={metrics} /> : groups ? (
        <div data-part="tool-matches">
          {groups.map((file, i) => (
            <div key={i} data-part="search-file">
              <div data-part="search-head"><span data-part="search-path">{file.path}</span><span data-part="search-count">{file.lines.length}</span></div>
              {file.lines.map((line, j) => <div key={j} data-part="line"><span data-part="line-number">{line.number}</span><span data-part="line-text">{line.text}</span></div>)}
            </div>
          ))}
        </div>
      ) : <Output text={text} />}
      {asking(state) ? <Arguments call={item.tool_call} /> : null}
      <Foot copy={[["pattern", item.view.pattern], ["output", text]]} />
    </>
  );
}
