import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { Highlight } from "@fulcrum/highlight";
import type { ToolBodyProps, ToolItem } from "./parts.js";
import { requestTokens, type Block } from "./highlight.js";
import { editBlocks } from "./tools/edit.js";
import { fetchBlocks } from "./tools/fetch.js";
import { genericBlocks } from "./tools/generic.js";
import { readBlocks } from "./tools/read.js";
import { searchBlocks } from "./tools/search.js";
import { shellBlocks } from "./tools/shell.js";
import { writeBlocks } from "./tools/write.js";

const blocks: Record<NonNullable<ToolItem["view"]>["kind"], (props: ToolBodyProps) => Block[]> = {
  shell: shellBlocks,
  read: readBlocks,
  edit: editBlocks,
  write: writeBlocks,
  search: searchBlocks,
  fetch: fetchBlocks,
};

/** The highlight blocks ToolBody asks for when it first mounts. */
const toolBodyBlocks = (props: ToolBodyProps): Block[] => ((props.item.view && blocks[props.item.view.kind]) || genericBlocks)(props);

/**
 * ToolBody's first-render work, done ahead of time: the pure parts (JSON, ANSI, row models) land in their text caches
 * and every highlight block is requested, so the body paints colored on its first frame when it opens.
 */
export function warmToolBody(props: ToolBodyProps, highlight: Highlight) {
  for (const block of toolBodyBlocks(props)) requestTokens(highlight, block);
}

type Deadline = { timeRemaining(): number };
type Job = { node: RefObject<Element | null>; run: () => void };
const queue = new Set<Job>();
let scheduled = false;
const SLICE_MS = 8;

// Safari has no requestIdleCallback: a short timer with a frame-sized budget stands in.
const idle = (callback: (deadline: Deadline) => void) => {
  if (typeof requestIdleCallback === "function") requestIdleCallback(callback);
  else setTimeout(() => {
    const end = performance.now() + SLICE_MS;
    callback({ timeRemaining: () => end - performance.now() });
  }, 50);
};
const schedule = () => {
  if (scheduled || !queue.size) return;
  scheduled = true;
  idle(flush);
};
// Pixels from the viewport: rows on screen (0) warm first, then overscan rows nearest to it.
const distance = (node: Element | null) => {
  if (!node) return Infinity;
  const { top, bottom } = node.getBoundingClientRect();
  return bottom < 0 ? -bottom : top > innerHeight ? top - innerHeight : 0;
};

function flush(deadline: Deadline) {
  scheduled = false;
  const jobs = [...queue].map((job) => [distance(job.node.current), job] as const).sort((a, b) => a[0] - b[0]);
  for (const [, job] of jobs) {
    if (deadline.timeRemaining() < 1) break;
    queue.delete(job);
    job.run();
  }
  schedule();
}

/**
 * Warms a closed disclosure's content while the browser is idle, nearest the viewport first, and once per `revision`:
 * a row that unmounts (leaves the virtual window) drops out of the queue, and a revision that lands before the idle
 * period replaces the queued one, so streaming warms at most once per idle period. With nothing queued no callback is
 * scheduled. `warm` undefined (already open, nothing to warm) stops it. Returns a handler that warms at once (hover,
 * focus, press), which does nothing when this revision is already warm.
 */
export function useWarm(node: RefObject<Element | null>, warm: (() => void) | undefined, revision: unknown): () => void {
  const latest = useRef(warm);
  latest.current = warm;
  const warmed = useRef<unknown>(undefined);
  const now = useCallback(() => {
    if (!latest.current || warmed.current === revision) return;
    warmed.current = revision;
    latest.current();
  }, [revision]);
  const active = !!warm;
  useEffect(() => {
    if (!active || warmed.current === revision) return;
    const job: Job = { node, run: now };
    queue.add(job);
    schedule();
    return () => { queue.delete(job); };
  }, [active, revision, node, now]);
  return now;
}
