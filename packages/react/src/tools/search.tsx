import { useState } from "react";
import type { ToolBodyProps } from "../parts.js";
import { Arguments, asking, boundLines, Empty, Foot, Gap, Output, ShowAll, splitLines } from "./common.js";

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
  const [expanded, setExpanded] = useState(false);
  if (item.view?.kind !== "search") return null;
  const text = item.view.matches?.join("\n") ?? output;
  // Results read top-down, so the bound keeps only the head.
  const window = boundLines(splitLines(text), expanded, 0);
  const groups = group(window.head);
  return (
    <>
      {asking(state) ? <pre data-part="tool-path">{item.view.path ? `${item.view.pattern} in ${item.view.path}` : item.view.pattern}</pre> : null}
      {!text ? <Empty state={state} noun="matches" /> : groups ? (
        <div data-part="tool-matches">
          {groups.map((file, i) => (
            <div key={i} data-part="search-file">
              <div data-part="search-head"><span data-part="search-path">{file.path}</span><span data-part="search-count">{file.lines.length}</span></div>
              {file.lines.map((line, j) => <div key={j} data-part="line"><span data-part="line-number">{line.number}</span><span data-part="line-text">{line.text}</span></div>)}
            </div>
          ))}
          <Gap window={window} expanded={expanded} noun="matches" />
        </div>
      ) : <Output text={text} />}
      {groups ? <ShowAll window={window} expanded={expanded} expand={() => setExpanded(true)} noun="matches" /> : null}
      {asking(state) ? <Arguments call={item.tool_call} /> : null}
      <Foot copy={[["pattern", item.view.pattern], ["output", text]]} />
    </>
  );
}
