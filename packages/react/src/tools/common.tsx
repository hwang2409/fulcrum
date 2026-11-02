import { useState, type ReactNode } from "react";
import type { RunItem } from "@fulcrum/core";

export type ToolItem = Extract<RunItem, { type: "tool" }>;
export type ToolCardProps = { item: ToolItem; onOpenRun?: (childRunId: string) => void };

const HEAD_LINES = 40;
const TAIL_LINES = 20;
const MAX_EXPANDED_CHARS = 100_000;

export function CappedText({ children, part = "tool-output", renderLine }: { children: string; part?: string; renderLine?: (line: string, index: number) => ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const lines = children.split("\n");
  const hidden = Math.max(0, lines.length - HEAD_LINES - TAIL_LINES);
  const bounded = children.length <= MAX_EXPANDED_CHARS
    ? children
    : `${children.slice(0, MAX_EXPANDED_CHARS / 2)}\n… output capped …\n${children.slice(-MAX_EXPANDED_CHARS / 2)}`;
  const shown = expanded || hidden === 0
    ? bounded
    : `${lines.slice(0, HEAD_LINES).join("\n")}\n… ${hidden} lines hidden …\n${lines.slice(-TAIL_LINES).join("\n")}`;
  const shownLines = renderLine ? shown.split("\n") : undefined;
  const render = renderLine;
  return (
    <div data-part={part}>
      <pre>{shownLines && render ? shownLines.map((line, index) => <span key={index}>{render(line, index)}{index < shownLines.length - 1 ? "\n" : null}</span>) : shown}</pre>
      {hidden > 0 && !expanded ? <button type="button" data-action="show-all" onClick={() => setExpanded(true)}>show all {hidden} lines</button> : null}
    </div>
  );
}

export const toolOutput = (item: ToolItem) => item.output || item.result?.content || "";
export const bytes = (value: number | undefined) => value === undefined ? undefined : value < 1_000 ? `${value} B` : `${(value / 1_000).toFixed(1)} kB`;
