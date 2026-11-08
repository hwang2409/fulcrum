import { expect, test } from "bun:test";
import { classifyScroll, type ScrollClass, type ScrollFacts } from "../src/scroll-class.js";

// Pinned: the reader sits at the DOM end (1,000). Unpinned: the reader sits at 400. Viewport 600, no pending write.
const base = (pinned: boolean): ScrollFacts => ({
  lease: false, pendingMatch: false, top: pinned ? 1_000 : 400, lastTop: pinned ? 1_000 : 400,
  domEnd: 1_000, lastDomEnd: 1_000, priorDomEnd: 1_000, clientHeight: 600, viewportSize: 600,
});
type Row = [name: string, change: (facts: ScrollFacts) => Partial<ScrollFacts>, pinned: ScrollClass, unpinned: ScrollClass];
const rows: Row[] = [
  ["own echo", (f) => ({ pendingMatch: true, top: f.top }), "own", "own"],
  ["end clamp at the old end (content grew 300)", () => ({ top: 1_000, domEnd: 1_300, lastDomEnd: 1_000, priorDomEnd: 1_000 }), "layout", "layout"],
  ["end clamp at the new end (content shrank 300)", () => ({ top: 700, domEnd: 700, lastDomEnd: 1_000, priorDomEnd: 1_000 }), "layout", "layout"],
  ["viewport resize, 41 px move", (f) => ({ top: f.top - 41, clientHeight: 597, domEnd: 1_003, lastDomEnd: 1_000, priorDomEnd: 1_000 }), "layout", "layout"],
  ["viewport resize, 500 px move (frame-bounded limit)", (f) => ({ top: f.top - 500, clientHeight: 597, domEnd: 1_003 }), "layout", "layout"],
  ["content grew 30, move within it (20)", (f) => ({ top: f.top + 20, domEnd: 1_030, priorDomEnd: 1_000 }), "layout", "layout"],
  ["content grew 30, move beyond it (2,000 up / 300 up)", (f) => ({ top: f.top - (f.top > 500 ? 2_000 : 300), domEnd: 1_030 }), "intent", "intent"],
  ["content grew 200 while idle, later far move", (f) => ({ top: Math.max(0, f.top - 3_000), domEnd: 1_200 }), "intent", "intent"],
  ["no size change, small move (10 up)", (f) => ({ top: f.top - 10 }), "intent", "intent"],
  ["no size change, large move (100 up)", (f) => ({ top: f.top - 100 }), "intent", "intent"],
  ["lease scroll down", (f) => ({ lease: true, top: Math.min(1_000, f.top + 100) }), "reader", "reader"],
  ["lease scroll up (the engine threshold decides)", (f) => ({ lease: true, top: f.top - 40 }), "reader", "reader"],
  // Gamma's approval click: a focus lease covers the browser's clamp to the new end after the card shrinks 161 px.
  ["focus lease over an end clamp after a shrink", (f) => ({ lease: true, top: Math.min(f.top, 839), domEnd: 839, priorDomEnd: 1_000 }), "reader", "reader"],
];
test.each(rows.flatMap(([name, change, pinned, unpinned]) => [
  [`${name} while pinned`, change, true, pinned] as const,
  [`${name} while unpinned`, change, false, unpinned] as const,
]))("classifyScroll: %s", (_, change, pinned, expected) => {
  const facts = base(pinned);
  expect(classifyScroll({ ...facts, ...change(facts) })).toBe(expected);
});
