/** What one Timeline scroll callback means. Internal: the hook acts on it, the package does not export it. */
export type ScrollClass =
  /** our own write landed: report it, keep intent */
  | "own"
  /** the browser moved the reader for a size change or an end clamp: report it, keep intent (a pinned reader returns to the end) */
  | "layout"
  /** the reader or the host moved the view away: follow drops, nothing snaps back */
  | "intent"
  /** reader input that does not move up: the engine decides follow by distance */
  | "reader";

export type ScrollFacts = {
  /** a reader-input lease (wheel, key, focus, scrollbar, touch) covers this callback */
  lease: boolean;
  /** the position is our pending write */
  pendingMatch: boolean;
  top: number;
  /** position at the last callback or write we saw */
  lastTop: number;
  domEnd: number;
  /** DOM end at the last callback or write we saw */
  lastDomEnd: number;
  /** DOM end before our pending write, else `lastDomEnd` */
  priorDomEnd: number;
  clientHeight: number;
  /** viewport size the engine has; the viewport observer reports every resize, so a difference is from this frame */
  viewportSize: number;
};

// The one rule for non-input scrolls. Layout causes, in order: an end clamp (a point test at the old or new DOM end),
// a viewport resize the engine has not seen yet (any distance; it is frame-bounded), or a content-size change no smaller
// than the move (a clamp moves the reader at most by the shrink). Anything else is host intent, even within the
// engine's bottom threshold. Content outside the rows can change the DOM end long before a host move, so a content
// change alone is not a cause.
export function classifyScroll(facts: ScrollFacts): ScrollClass {
  const { top, lastTop, domEnd, lastDomEnd, priorDomEnd } = facts;
  if (facts.lease) return top < lastTop - 0.5 ? "intent" : "reader";
  if (facts.pendingMatch) return "own";
  const slack = Math.min(1, Math.abs(domEnd - priorDomEnd));
  if (Math.abs(top - priorDomEnd) <= slack + 0.5 || Math.abs(top - domEnd) <= slack + 0.5) return "layout";
  if (Math.abs(facts.clientHeight - facts.viewportSize) >= 0.5) return "layout";
  const contentChange = Math.abs(domEnd - lastDomEnd);
  if (contentChange >= 0.5 && Math.abs(top - lastTop) <= contentChange + 1) return "layout";
  return "intent";
}
