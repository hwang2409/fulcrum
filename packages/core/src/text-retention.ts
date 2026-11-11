import type { RunItem, StoredResultBlock, StoredToolResult, StoredToolView, TextSourceSnapshot } from "./events.js";
import { limitTextSource, omitTextSource } from "./text-source.js";

type ToolItem = Extract<RunItem, { type: "tool" }>;
type Mapper = (source: TextSourceSnapshot) => TextSourceSnapshot;

const mapView = (view: StoredToolView | undefined, map: Mapper): StoredToolView | undefined => {
  if (!view) return undefined;
  switch (view.kind) {
    case "shell": return { ...view, ...(view.stdout ? { stdout: map(view.stdout) } : {}), ...(view.stderr ? { stderr: map(view.stderr) } : {}) };
    case "edit": return { ...view, diff: map(view.diff) };
    case "write": return { ...view, ...(view.content ? { content: map(view.content) } : {}) };
    case "search": return { ...view, ...(view.matches ? { matches: view.matches.map(map) } : {}) };
    default: return view;
  }
};
const mapResult = (result: StoredToolResult | undefined, map: Mapper): StoredToolResult | undefined => {
  if (!result) return undefined;
  const blocks = result.blocks?.map((block): StoredResultBlock => block.text ? { ...block, text: map(block.text) } : block);
  return { ...result, ...(blocks ? { blocks } : {}), ...(result.finalContent ? { finalContent: map(result.finalContent) } : {}) };
};
export const toolSources = (item: ToolItem): readonly TextSourceSnapshot[] => {
  const sources: TextSourceSnapshot[] = [item.output];
  const view = item.view;
  if (view?.kind === "shell") { if (view.stdout) sources.push(view.stdout); if (view.stderr) sources.push(view.stderr); }
  else if (view?.kind === "edit") sources.push(view.diff);
  else if (view?.kind === "write" && view.content) sources.push(view.content);
  else if (view?.kind === "search" && view.matches) sources.push(...view.matches);
  if (item.result?.finalContent) sources.push(item.result.finalContent);
  for (const block of item.result?.blocks ?? []) if (block.text) sources.push(block.text);
  return sources;
};
export const toolRetainedBytes = (item: ToolItem) => toolSources(item).reduce((total, source) => total + source.retainedBytes, 0);

const mapToolSources = (item: ToolItem, replacements: ReadonlyMap<TextSourceSnapshot, TextSourceSnapshot>): ToolItem => {
  const map = (source: TextSourceSnapshot) => replacements.get(source) ?? source;
  return { ...item, view: mapView(item.view, map), output: map(item.output), result: mapResult(item.result, map), version: item.version + 1 };
};

export function limitToolItem(item: ToolItem, cap: number): ToolItem {
  let remaining = cap;
  const replacements = new Map<TextSourceSnapshot, TextSourceSnapshot>();
  for (const source of toolSources(item)) {
    const next = limitTextSource(source, Math.max(0, remaining), "item-cap");
    replacements.set(source, next);
    remaining -= next.retainedBytes;
  }
  return [...replacements].some(([before, after]) => before !== after) ? mapToolSources(item, replacements) : item;
}
export function omitToolItem(item: ToolItem): ToolItem {
  const replacements = new Map<TextSourceSnapshot, TextSourceSnapshot>();
  for (const source of toolSources(item)) replacements.set(source, omitTextSource(source, "run-cap"));
  return toolRetainedBytes(item) ? mapToolSources(item, replacements) : item;
}
