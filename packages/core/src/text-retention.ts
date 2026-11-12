import type { RunItem, StoredResultBlock, StoredToolResult, StoredToolView, TextSourceSnapshot } from "./events.js";
import { limitTextSource, omitTextSource, PROTECTED_COMPLETED_TOOLS } from "./text-source.js";

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
const toolSources = (item: ToolItem): readonly TextSourceSnapshot[] => {
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
const toolRetainedBytes = (item: ToolItem) => toolSources(item).reduce((total, source) => total + source.retainedBytes, 0);

const mapToolSources = (item: ToolItem, replacements: ReadonlyMap<TextSourceSnapshot, TextSourceSnapshot>): ToolItem => {
  const map = (source: TextSourceSnapshot) => replacements.get(source) ?? source;
  return { ...item, view: mapView(item.view, map), output: map(item.output), result: mapResult(item.result, map), version: item.version + 1 };
};

function limitToolItem(item: ToolItem, cap: number): ToolItem {
  let remaining = cap;
  const replacements = new Map<TextSourceSnapshot, TextSourceSnapshot>();
  for (const source of toolSources(item)) {
    const next = limitTextSource(source, Math.max(0, remaining), "item-cap");
    replacements.set(source, next);
    remaining -= next.retainedBytes;
  }
  return [...replacements].some(([before, after]) => before !== after) ? mapToolSources(item, replacements) : item;
}
function omitToolItem(item: ToolItem): ToolItem {
  const replacements = new Map<TextSourceSnapshot, TextSourceSnapshot>();
  for (const source of toolSources(item)) replacements.set(source, omitTextSource(source, "run-cap"));
  return toolRetainedBytes(item) ? mapToolSources(item, replacements) : item;
}

const failed = (item: ToolItem) => item.is_error || (item.view?.kind === "shell" && item.view.exitCode !== undefined && item.view.exitCode !== 0);

/**
 * The store's one owner of tool-text retention. Every tool item change passes through `enforce` before the store
 * publishes: each item keeps at most `itemBytes` across its sources, and while the run holds more than `runBytes`,
 * completed tools lose their bodies oldest first. Running tools, failed tools, and the newest
 * PROTECTED_COMPLETED_TOOLS completed tools never lose their whole body, so the run cap is soft when they alone exceed it.
 */
export function createToolRetention(itemBytes: number, runBytes: number) {
  if (!(Number.isSafeInteger(itemBytes) && itemBytes > 0)) throw new RangeError("toolOutputItemBytes must be a positive integer");
  if (!(Number.isSafeInteger(runBytes) && runBytes > 0)) throw new RangeError("toolOutputRunBytes must be a positive integer");
  // Tools that retain bytes, in the order they started retaining them (oldest first): eviction walks from the front
  // and skips only protected tools, so a long run does not rescan the tools it already emptied.
  let retained = new Map<string, number>();
  let total = 0;
  // Ids of the most recently finished tools, newest last.
  let recent: string[] = [];
  const account = (id: string, bytes: number) => {
    total += bytes - (retained.get(id) ?? 0);
    if (bytes) retained.set(id, bytes);
    else retained.delete(id);
  };
  const evict = (target: Map<string, RunItem>, changed: Set<string>) => {
    if (total <= runBytes) return;
    for (const id of retained.keys()) {
      const item = target.get(id);
      if (item?.type !== "tool" || item.active || failed(item) || recent.includes(id)) continue;
      const omitted = omitToolItem(item);
      target.set(id, omitted);
      changed.add(id);
      account(id, toolRetainedBytes(omitted));
      if (total <= runBytes) return;
    }
  };
  const limit = (target: Map<string, RunItem>, id: string, changed: Set<string>) => {
    const item = target.get(id);
    if (item?.type !== "tool") return void account(id, 0);
    const limited = limitToolItem(item, itemBytes);
    if (limited !== item) target.set(id, limited), changed.add(id);
    account(id, toolRetainedBytes(limited));
    return limited;
  };
  return {
    /** Bounds the tools `ids` names (changed by one reduction) in `target`, adding every id it rewrites to `changed`. */
    enforce(target: Map<string, RunItem>, ids: Iterable<string>, changed: Set<string>) {
      for (const id of ids) {
        const item = limit(target, id, changed);
        if (item && !item.active) recent = [...recent.filter((other) => other !== id), id].slice(-PROTECTED_COMPLETED_TOOLS);
      }
      evict(target, changed);
    },
    /** Recounts `target` from nothing in outline order, as after a history prepend rebuilt every item. */
    reset(target: Map<string, RunItem>, outline: readonly { id: string }[], changed: Set<string>) {
      retained = new Map();
      total = 0;
      recent = [];
      const seen = new Set<string>();
      for (const { id } of outline) {
        seen.add(id);
        const item = limit(target, id, changed);
        if (item && !item.active) recent = [...recent, id].slice(-PROTECTED_COMPLETED_TOOLS);
      }
      for (const [id, item] of target) if (item.type === "tool" && !seen.has(id)) limit(target, id, changed);
      evict(target, changed);
    },
    clear() { retained = new Map(); total = 0; recent = []; },
    /** Retained bytes across every tool source the pool owns (tests and diagnostics). */
    get bytes() { return total; },
  };
}
