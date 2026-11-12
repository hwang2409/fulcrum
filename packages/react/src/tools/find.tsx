import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { findText, type TextMatch } from "@fulcrum/core/text";

/** What a viewer's find needs from the viewer: its text, its rows' text starts, and how to bring a row into view. */
export type FindHost = {
  text: string;
  /** Text start of each row, ascending; a row is drawn as `[data-start]` holding exactly its text. */
  starts: readonly number[];
  scrollRef: RefObject<HTMLElement | null>;
  /** Scrolls row `index` into the box (it may not be drawn yet). Find moving the view stops following new output. */
  scrollToRow(index: number): void;
  /** Called before find scrolls the box itself (to a drawn match). */
  stopFollow(): void;
  /** Text offset at the top of the view: a new query starts from the first match at or after it. */
  viewStart(): number;
  /** False when the text the viewer was given is not the whole output (a cut, or a host that cut it). */
  complete: boolean;
  label: string;
};
type Found = { count: number; current: number; done: boolean; complete: boolean; capped: boolean };
const IDLE: Found = { count: 0, current: -1, done: true, complete: true, capped: false };
// A streaming text is searched again once it stops changing for this long, not on every append.
const RESTART_MS = 250;
const counts = new Intl.NumberFormat("en-US");

// The matches of every open viewer, one highlight per name (CSS.highlights is global); each viewer adds and removes its
// own ranges. Without the CSS Custom Highlight API, find still counts and scrolls, and the current match is selected.
const highlights = typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
const highlight = (name: string, priority: number) => {
  let value = CSS.highlights.get(name);
  if (!value) {
    value = new Highlight();
    value.priority = priority;
    CSS.highlights.set(name, value);
  }
  return value;
};

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";
/** The last index in ascending `values` that is <= `value` (0 when none is). */
const rowAt = (values: readonly number[], value: number) => {
  let low = 0;
  let high = values.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (values[mid]! <= value) low = mid;
    else high = mid - 1;
  }
  return low;
};
/** The first match that ends after `offset`. */
const firstAfter = (matches: readonly TextMatch[], offset: number) => {
  let low = 0;
  let high = matches.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (matches[mid]!.end <= offset) low = mid + 1;
    else high = mid;
  }
  return low;
};

/** DOM ranges for `matches` (ascending, each overlapping the row) inside a drawn row whose text starts at `start`. */
function rowRanges(row: Element, start: number, matches: readonly TextMatch[]): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let at = start;
  for (const match of matches) {
    let range: Range | undefined;
    while (node) {
      const end = at + node.nodeValue!.length;
      if (!range && match.start < end) {
        range = document.createRange();
        range.setStart(node, Math.max(0, match.start - at));
      }
      if (range && match.end <= end) {
        range.setEnd(node, match.end - at);
        break;
      }
      at = end;
      node = walker.nextNode();
    }
    if (!node) {
      // The match runs past this row: it ends at the row's end (the next row draws the rest).
      if (range) {
        range.setEndAfter(row.lastChild ?? row);
        ranges.push(range);
      }
      break;
    }
    ranges.push(range!);
  }
  return ranges;
}

/**
 * Find in a virtual viewer's whole text, not only its drawn rows: an abortable incremental search (findText) that
 * counts every match, moves through them with Enter and Shift+Enter, scrolls each into view, and highlights the drawn
 * ones. A new query, new text, closing, and unmounting abort the search in flight; nothing is kept once it closes.
 */
export function useFind(host: FindHost): { open: () => void; onKeyDown: (event: KeyboardEvent) => void; bar: ReactNode } {
  const [isOpen, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState(IDLE);
  const matches = useRef<readonly TextMatch[]>([]);
  const searched = useRef("");
  const reveal = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(host);
  latest.current = host;
  const current = useRef(-1);
  current.current = found.current;
  const moved = useRef(false);

  useEffect(() => {
    if (!isOpen || !query) {
      matches.current = [];
      searched.current = "";
      setFound(IDLE);
      return;
    }
    const controller = new AbortController();
    const fresh = searched.current !== query;
    searched.current = query;
    moved.current = false;
    // A new query starts at the view. The same query over new text keeps its match and does not move the view; the old
    // matches stay drawn until the new search reports.
    const anchor = fresh ? latest.current.viewStart() : -1;
    const kept = fresh ? undefined : matches.current[current.current];
    if (fresh) {
      matches.current = [];
      setFound({ ...IDLE, done: false });
    }
    const timer = setTimeout(async () => {
      const all: TextMatch[] = [];
      let at = -1;
      try {
        for await (const update of findText({ chunks: () => [{ start: 0, line: 0, text: host.text }].values(), omission: null, protocolTruncated: false }, query, { signal: controller.signal })) {
          for (const match of update.matches) all.push(match);
          if (at < 0) {
            const next = firstAfter(all, kept ? kept.start : anchor);
            if (next < all.length) at = next;
            else if (update.done && all.length) at = 0;
            if (at >= 0 && fresh) reveal.current = true;
          }
          matches.current = all;
          const facts = { count: all.length, done: update.done, complete: update.complete && latest.current.complete, capped: update.capped };
          // Once the reader moves (Enter, the arrows), the search no longer picks the current match.
          setFound((prior) => ({ ...facts, current: moved.current ? prior.current : at }));
        }
      } catch (error) {
        if (!isAbort(error)) throw error;
      }
    }, fresh ? 0 : RESTART_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [isOpen, query, host.text]);

  // Paint the drawn matches, and bring the current one into view when it moved. Rows mount, unmount, and get their
  // colors later, so the drawn content is watched and painted again (once per frame at most) while find is open.
  useLayoutEffect(() => {
    const box = host.scrollRef.current;
    if (!isOpen || !box || !found.count) return;
    const own: Range[] = [];
    const ownCurrent: Range[] = [];
    let frame = 0;
    const paint = () => {
      frame = 0;
      const { starts, text } = latest.current;
      const all = matches.current;
      const pick = all[current.current];
      if (highlights) {
        own.forEach((range) => highlight("fulcrum-find", 0).delete(range));
        ownCurrent.forEach((range) => highlight("fulcrum-find-current", 1).delete(range));
      }
      own.length = ownCurrent.length = 0;
      let target: Range | undefined;
      for (const row of box.querySelectorAll<HTMLElement>("[data-part=text-viewer-row][data-start]")) {
        const start = Number(row.dataset.start);
        const index = rowAt(starts, start);
        const end = starts[index + 1] ?? text.length;
        const from = firstAfter(all, start);
        let to = from;
        while (to < all.length && all[to]!.start < end) to++;
        if (to === from) continue;
        const ranges = rowRanges(row, start, all.slice(from, to));
        ranges.forEach((range, offset) => {
          const isCurrent = all[from + offset] === pick;
          (isCurrent ? ownCurrent : own).push(range);
          if (isCurrent && !target) target = range;
        });
      }
      if (highlights) {
        own.forEach((range) => highlight("fulcrum-find", 0).add(range));
        ownCurrent.forEach((range) => highlight("fulcrum-find-current", 1).add(range));
      }
      if (reveal.current && pick) {
        if (!target) {
          latest.current.scrollToRow(rowAt(starts, pick.start)); // drawn on a later render, then revealed
          return;
        }
        reveal.current = false;
        const view = box.getBoundingClientRect();
        const rect = target.getBoundingClientRect();
        if (rect.top < view.top || rect.bottom > view.bottom) {
          latest.current.stopFollow();
          box.scrollTop += rect.top - view.top - view.height / 3;
        }
        if (!highlights) {
          const selection = getSelection();
          selection?.removeAllRanges();
          selection?.addRange(target);
        }
      }
    };
    paint();
    const schedule = () => { frame ||= requestAnimationFrame(paint); };
    const observer = new MutationObserver(schedule);
    observer.observe(box, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      if (!highlights) return;
      own.forEach((range) => highlight("fulcrum-find", 0).delete(range));
      ownCurrent.forEach((range) => highlight("fulcrum-find-current", 1).delete(range));
    };
  }, [isOpen, found, host.scrollRef]);

  const open = () => {
    setOpen(true);
    // The bar may already be open: focus moves back to it either way, its query selected to type over.
    requestAnimationFrame(() => input.current?.select());
    input.current?.focus();
  };
  // The query stays for the next open, selected to type over, as a browser's find bar keeps it.
  const close = () => {
    setOpen(false);
    host.scrollRef.current?.focus({ preventScroll: true });
  };
  const step = (by: number) => {
    if (!found.count) return;
    moved.current = true;
    reveal.current = true;
    const from = found.current < 0 ? (by > 0 ? -1 : 0) : found.current;
    setFound({ ...found, current: (from + by + found.count) % found.count });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && isOpen) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "f" && !event.shiftKey) {
      event.preventDefault();
      open();
    } else if (key === "g" && isOpen) {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
  };
  if (!isOpen) return { open, onKeyDown, bar: null };
  const more = !found.done;
  const total = `${counts.format(found.count)}${more || found.capped ? "+" : ""}`;
  const where = found.complete || !found.done ? "" : " in retained text";
  const status = !query ? "" : found.count ? `${found.current >= 0 ? counts.format(found.current + 1) : "–"} of ${total}${where}` : more ? "searching" : `no matches${where}`;
  return {
    open,
    onKeyDown,
    bar: (
      <div data-part="text-viewer-find" role="search" onKeyDown={onKeyDown}>
        <input
          ref={input}
          autoFocus
          type="text"
          spellCheck={false}
          autoComplete="off"
          aria-label={`find in ${host.label}`}
          placeholder={`find in ${host.label}`}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          }}
        />
        <span data-part="text-viewer-find-count" data-state={found.count || !query || more ? undefined : "none"}>{status}</span>
        {/* Read once the search settles, not at every work slice. */}
        <span data-part="text-viewer-announce" aria-live="polite">{query && found.done ? status : ""}</span>
        <button type="button" data-action="find-previous" aria-label="previous match" disabled={!found.count} onClick={() => step(-1)}>↑</button>
        <button type="button" data-action="find-next" aria-label="next match" disabled={!found.count} onClick={() => step(1)}>↓</button>
        <button type="button" data-action="find-close" aria-label="close find" onClick={close}>×</button>
      </div>
    ),
  };
}
