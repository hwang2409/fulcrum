import { expect, test } from "bun:test";
import { classifyScroll, type ScrollClass, type ScrollFacts } from "../src/scroll-class.js";

// Pinned: the reader sits at the DOM end (1,000). Unpinned: the reader sits at 400. Viewport 600 (content 1,600), no
// pending write, the engine's default 48 px bottom threshold.
const base = (pinned: boolean): ScrollFacts => ({
  lease: false, pendingMatch: false, top: pinned ? 1_000 : 400, lastTop: pinned ? 1_000 : 400,
  domEnd: 1_000, lastDomEnd: 1_000, priorDomEnd: 1_000, scrollHeight: 1_600, lastScrollHeight: 1_600,
  clientHeight: 600, viewportSize: 600, bottomThreshold: 48,
});
type Row = [name: string, change: (facts: ScrollFacts) => Partial<ScrollFacts>, pinned: ScrollClass, unpinned: ScrollClass];
const rows: Row[] = [
  ["own echo", (f) => ({ pendingMatch: true, top: f.top }), "own", "own"],
  ["end clamp at the old end (content grew 300)", () => ({ top: 1_000, domEnd: 1_300, scrollHeight: 1_900 }), "layout", "layout"],
  ["end clamp at the new end (content shrank 300)", () => ({ top: 700, domEnd: 700, scrollHeight: 1_300 }), "layout", "layout"],
  // WebKit reconnect capture (capA-reconnect-4 t=1295): a banner shrinks the box 3 px; the browser moves the reader 41 px up.
  ["WebKit banner: viewport shrink 3, 41 px up, no input", (f) => ({ top: f.top - 41, clientHeight: 597, domEnd: 1_003 }), "layout", "layout"],
  // capA-reconnect-3 ended 46 px above the end: the same 3 px shrink class, still inside |resize| + 48.
  ["viewport shrink 3, 46 px up", (f) => ({ top: f.top - 46, clientHeight: 597, domEnd: 1_003 }), "layout", "layout"],
  ["viewport shrink 3, 52 px up (beyond |resize| + 48)", (f) => ({ top: f.top - 52, clientHeight: 597, domEnd: 1_003 }), "intent", "intent"],
  ["viewport shrink 3, 500 px up", (f) => ({ top: f.top - 500, clientHeight: 597, domEnd: 1_003 }), "intent", "intent"],
  // The sub-agent clock (subagent-check.ts): the host shrinks the box 506 -> 146 and scrolls down in the same task.
  ["sub-agent clock: viewport 506 -> 146, host 345 px down", (f) => ({ top: f.top + 345, lastTop: f.top, clientHeight: 146, viewportSize: 506, domEnd: 1_454 }), "intent", "intent"],
  ["sub-agent clock: viewport 506 -> 146, host 143 px down", (f) => ({ top: f.top + 143, lastTop: f.top, clientHeight: 146, viewportSize: 506, domEnd: 1_454 }), "intent", "intent"],
  // Content changes are measured from scrollHeight: a viewport resize the engine already has moves the DOM end too.
  ["content grew 30, 20 px up", (f) => ({ top: f.top - 20, domEnd: 1_030, scrollHeight: 1_630 }), "layout", "layout"],
  ["content grew 30, move beyond it (2,000 up / 300 up)", (f) => ({ top: f.top - (f.top > 500 ? 2_000 : 300), domEnd: 1_030, scrollHeight: 1_630 }), "intent", "intent"],
  ["seen viewport shrink 454 moved the DOM end, no content change, 200 px up", (f) => ({ top: f.top - 200, clientHeight: 146, viewportSize: 146, domEnd: 1_454 }), "intent", "intent"],
  ["content grew 200 while idle, later far move", (f) => ({ top: Math.max(0, f.top - 3_000), domEnd: 1_200, scrollHeight: 1_800 }), "intent", "intent"],
  // Premise (overflow-anchor: none): without input a browser moves scrollTop only up, so a move down is never layout.
  ["content grew 30, host 20 px down (not at the end)", (f) => ({ top: f.top + 20, domEnd: 1_030, scrollHeight: 1_630 }), "intent", "intent"],
  ["no size change, 100 px down", (f) => ({ top: f.top + 100, lastTop: f.top, domEnd: 1_200, lastDomEnd: 1_200, priorDomEnd: 1_200, scrollHeight: 1_800, lastScrollHeight: 1_800 }), "intent", "intent"],
  // F1: a host write that lands exactly at the end is layout: it never resumes follow (only reader input at the end does).
  ["host write down to the end", (f) => ({ top: 1_300, lastTop: f.top - 300, domEnd: 1_300, lastDomEnd: 1_300, priorDomEnd: 1_300, scrollHeight: 1_900, lastScrollHeight: 1_900 }), "layout", "layout"],
  // WebKit capture (#94's fractional rows): our 4442.625 write was stored as 4442; nothing moved, no input, no size change.
  ["WebKit truncated write: top 4442, lastTop 4442, domEnd 4444, pending 4442.625 unmatched", () => ({ top: 4_442, lastTop: 4_442, domEnd: 4_444, lastDomEnd: 4_444, priorDomEnd: 4_444, scrollHeight: 5_087, lastScrollHeight: 5_087, clientHeight: 643, viewportSize: 643 }), "layout", "layout"],
  ["no size change, small move (10 up)", (f) => ({ top: f.top - 10 }), "intent", "intent"],
  ["no size change, large move (100 up)", (f) => ({ top: f.top - 100 }), "intent", "intent"],
  ["lease scroll down", (f) => ({ lease: true, top: Math.min(1_000, f.top + 100) }), "reader", "reader"],
  // Review-3 M1: a held page key or a scrollbar drag that moves up off the end is the reader leaving.
  ["lease scroll up 40 off the end", (f) => ({ lease: true, top: f.top - 40 }), "intent", "intent"],
  ["lease scroll up 20 off the end", (f) => ({ lease: true, top: f.top - 20 }), "intent", "intent"],
  // Gamma's approval click: a focus lease covers the browser's clamp to the new end after the card shrinks 161 px.
  ["focus lease over an end clamp after a shrink", (f) => ({ lease: true, top: Math.min(f.top, 839), domEnd: 839, scrollHeight: 1_439, priorDomEnd: 1_000 }), "reader", "reader"],
];
test.each(rows.flatMap(([name, change, pinned, unpinned]) => [
  [`${name} while pinned`, change, true, pinned] as const,
  [`${name} while unpinned`, change, false, unpinned] as const,
]))("classifyScroll: %s", (_, change, pinned, expected) => {
  const facts = base(pinned);
  expect(classifyScroll({ ...facts, ...change(facts) })).toBe(expected);
});
