import { useCallback, useLayoutEffect, useRef, type RefCallback } from "react";

// The aria-label this module set on each box it made a tab stop, so it only ever removes what it added.
const marked = new WeakMap<HTMLElement, string>();
const leaving = new WeakSet<HTMLElement>(); // focused boxes that lose their tab stop once focus leaves
const overflows = (node: HTMLElement) => node.scrollWidth - node.clientWidth > 1 || node.scrollHeight - node.clientHeight > 1;

/**
 * Makes `node` a named tab stop (`label` given) or takes back the tab stop this function gave it (`null`). A focused box
 * keeps its tab stop until focus leaves it, and is measured again then: removing `tabindex` would drop focus to the page.
 */
export function markScrollable(node: HTMLElement, label: string | null) {
  if (label !== null) {
    const name = `${label}, scrollable`;
    if (marked.get(node) === name) return;
    marked.set(node, name);
    node.tabIndex = 0;
    node.setAttribute("aria-label", name);
    return;
  }
  const name = marked.get(node);
  if (name === undefined) return;
  if (node.ownerDocument.activeElement === node) {
    if (leaving.has(node)) return;
    leaving.add(node);
    node.addEventListener("blur", () => {
      leaving.delete(node);
      if (!overflows(node)) markScrollable(node, null);
    }, { once: true });
    return;
  }
  marked.delete(node);
  if (node.getAttribute("tabindex") === "0") node.removeAttribute("tabindex");
  if (node.getAttribute("aria-label") === name) node.removeAttribute("aria-label");
}

type Box = { node: HTMLElement; label: { current: string } };
const boxes = new Map<Element, Set<Box>>();
let observer: ResizeObserver | undefined;

// The browser calls this after its own layout, so these reads are of fresh layout; every read happens before any write.
const resizeObserver = () => observer ??= new ResizeObserver((entries) => {
  const pending = new Set<Box>();
  for (const entry of entries) for (const box of boxes.get(entry.target) ?? []) pending.add(box);
  const measured = [...pending].map((box) => [box, overflows(box.node)] as const);
  for (const [box, scrollable] of measured) markScrollable(box.node, scrollable ? box.label.current : null);
});

function watch(target: Element, box: Box) {
  let listeners = boxes.get(target);
  if (!listeners) boxes.set(target, listeners = new Set());
  listeners.add(box);
  resizeObserver().observe(target);
}

function unwatch(target: Element, box: Box) {
  const listeners = boxes.get(target);
  listeners?.delete(box);
  if (listeners?.size) return;
  boxes.delete(target);
  observer?.unobserve(target);
  if (!boxes.size) {
    observer?.disconnect();
    observer = undefined;
  }
}

/**
 * Makes an overflow box a named tab stop (`tabindex="0"`, `aria-label="<label>, scrollable"`) only while it actually
 * scrolls. One observer serves every mounted box, and a box is measured only inside its callback, after the browser's
 * own layout: a mount forces no layout and no second render, so a row that `content-visibility` skips stays skipped (and
 * is not a tab stop) until the browser lays it out.
 */
export function useOverflowFocus(label: string): { ref: RefCallback<HTMLElement> } {
  const box = useRef<Box | undefined>(undefined);
  const watched = useRef<Element[]>([]);
  const name = useRef(label);
  const ref = useCallback<RefCallback<HTMLElement>>((node) => {
    for (const target of watched.current) unwatch(target, box.current!);
    watched.current = [];
    box.current = node ? { node, label: name } : undefined;
    if (!node || typeof ResizeObserver === "undefined") return;
    watched.current = [node, ...node.children];
    for (const target of watched.current) watch(target, box.current!);
  }, []);
  // A new label renames a box that is already a tab stop; that is not a measurement, so it reads no layout.
  useLayoutEffect(() => {
    name.current = label;
    const node = box.current?.node;
    if (node && marked.has(node)) markScrollable(node, label);
  }, [label]);
  return { ref };
}
