/** What one Timeline scroll callback means. Internal: the hook acts on it, the package does not export it. */
export type ScrollClass =
  /** our own write landed: report it, keep intent */
  | "own"
  /** the browser moved the reader for a size change or an end clamp: report it, keep intent (a pinned reader returns to the end) */
  | "layout"
  /** the reader or the host moved the view away: follow drops, nothing snaps back */
  | "intent"
  /** reader input: the engine decides follow by distance (its bottom threshold) */
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
  scrollHeight: number;
  /** scrollHeight at the last callback, write, or viewport resize we saw */
  lastScrollHeight: number;
  clientHeight: number;
  /** viewport size the engine has; the viewport observer reports every resize, so a difference is from this frame */
  viewportSize: number;
  /** the engine's bottom threshold */
  bottomThreshold: number;
};

// The one rule for scroll callbacks. Premise: the adapter sets overflow-anchor none on the element that scrolls
// (virtual.tsx), so without input a browser never moves scrollTop down; it only clamps it up when the content or the
// viewport shrinks. So, for a move that is not our write and has no reader input:
// - at the old or new DOM end (a point test): layout, an end clamp. F1: it never resumes follow;
// - down: the host's intent (scrollIntoView, find, a scrollTop write);
// - up, in a viewport resize the engine has not seen yet: layout within |resize| + the bottom threshold (WebKit moves a
//   reader 41 px up for a 3 px shrink), else intent;
// - up, with a content change (scrollHeight, not the DOM end, which a viewport resize also moves): layout within the
//   change, else intent; anything else is intent, even within the bottom threshold.
// Reader input moving up off the end is the reader leaving; other reader input goes to the engine's threshold.
export function classifyScroll(facts: ScrollFacts): ScrollClass {
  const { top, lastTop, domEnd, priorDomEnd } = facts;
  const slack = Math.min(1, Math.abs(domEnd - priorDomEnd));
  const atEnd = Math.abs(top - priorDomEnd) <= slack + 0.5 || Math.abs(top - domEnd) <= slack + 0.5;
  const up = lastTop - top;
  if (facts.lease) return up > 0.5 && !atEnd ? "intent" : "reader";
  if (facts.pendingMatch) return "own";
  if (atEnd) return "layout";
  if (up < -0.5) return "intent";
  const resize = Math.abs(facts.clientHeight - facts.viewportSize);
  if (resize >= 0.5) return up <= resize + facts.bottomThreshold ? "layout" : "intent";
  const contentChange = Math.abs(facts.scrollHeight - facts.lastScrollHeight);
  if (contentChange >= 0.5 && up <= contentChange + 1) return "layout";
  return "intent";
}
