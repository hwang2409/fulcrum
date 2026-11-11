import { useCallback, useEffect, useRef, useState, type RefCallback } from "react";

type Update = () => void;
const updates = new Map<Element, Set<Update>>();
let observer: ResizeObserver | undefined;

const resizeObserver = () => observer ??= new ResizeObserver((entries) => {
  const pending = new Set<Update>();
  for (const entry of entries) for (const update of updates.get(entry.target) ?? []) pending.add(update);
  for (const update of pending) update();
});

function watch(target: Element, update: Update) {
  let listeners = updates.get(target);
  if (!listeners) updates.set(target, listeners = new Set());
  listeners.add(update);
  resizeObserver().observe(target);
}

function unwatch(target: Element, update: Update) {
  const listeners = updates.get(target);
  listeners?.delete(update);
  if (listeners?.size) return;
  updates.delete(target);
  observer?.unobserve(target);
  if (!updates.size) {
    observer?.disconnect();
    observer = undefined;
  }
}

/** Makes an overflow box a named tab stop only while it actually scrolls. One observer serves every mounted box. */
export function useOverflowFocus(label: string): { ref: RefCallback<HTMLElement>; tabIndex?: 0; "aria-label"?: string } {
  const node = useRef<HTMLElement | null>(null);
  const watched = useRef<Element[]>([]);
  const [overflowing, setOverflowing] = useState(false);
  const update = useCallback(() => {
    const current = node.current;
    if (current) setOverflowing(current.scrollWidth - current.clientWidth > 1 || current.scrollHeight - current.clientHeight > 1);
  }, []);
  const detach = useCallback(() => {
    for (const target of watched.current) unwatch(target, update);
    watched.current = [];
  }, [update]);
  const ref = useCallback<RefCallback<HTMLElement>>((next) => {
    detach();
    node.current = next;
    if (!next) return;
    if (typeof ResizeObserver === "undefined") {
      setOverflowing(false);
      return;
    }
    watched.current = [next, ...next.children];
    for (const target of watched.current) watch(target, update);
    update(); // ResizeObserver can defer descendants skipped by content-visibility; one mount read keeps them reachable.
  }, [detach, update]);
  useEffect(() => detach, [detach]);
  return { ref, tabIndex: overflowing ? 0 : undefined, "aria-label": overflowing ? `${label}, scrollable` : undefined };
}
