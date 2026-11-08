import type { OutlineItem } from "@fulcrum/core";
import { createContext, useCallback, useContext, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";

/**
 * The id of a Timeline's newest row (the last outline item that can follow text in a turn), read per id: when it changes, only the row that loses it
 * and the row that gains it are told, never every row. The streaming cursor shows only on the newest row, so text that
 * a later row (a running tool) follows stops blinking, in plain and virtual mode and with a row kept mounted for focus.
 */
type NewestRow = { subscribe(id: string, listener: () => void): () => void; is(id: string): boolean };

// Rows that report on the run instead of continuing the turn: a message above one still streams, so it keeps the cursor.
const PASSIVE_KINDS: ReadonlySet<OutlineItem["kind"]> = new Set<OutlineItem["kind"]>(["notification", "unknown"]);

/** The id of the last row a reader sees the agent act in: passive rows (a background notification) are skipped. */
export function newestStreamableRow(items: readonly OutlineItem[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index--) if (!PASSIVE_KINDS.has(items[index]!.kind)) return items[index]!.id;
  return undefined;
}

const NewestRowContext = createContext<NewestRow | null>(null);

function createNewestRow(initial: string | undefined) {
  let newest = initial;
  const listeners = new Map<string, Set<() => void>>();
  const notify = (id: string | undefined) => { if (id !== undefined) listeners.get(id)?.forEach((listener) => listener()); };
  return {
    subscribe(id: string, listener: () => void) {
      const set = listeners.get(id) ?? new Set();
      listeners.set(id, set);
      set.add(listener);
      return () => {
        set.delete(listener);
        if (!set.size && listeners.get(id) === set) listeners.delete(id);
      };
    },
    is: (id: string) => id === newest,
    set(id: string | undefined) {
      if (id === newest) return;
      const prior = newest;
      newest = id;
      notify(prior);
      notify(id);
    },
  };
}

export function NewestRowProvider({ id, children }: { id: string | undefined; children: ReactNode }) {
  const [source] = useState(() => createNewestRow(id));
  useLayoutEffect(() => source.set(id), [source, id]);
  return <NewestRowContext.Provider value={source}>{children}</NewestRowContext.Provider>;
}

const idle = () => {};

/**
 * Whether row `id` is its Timeline's newest row; outside a Timeline, every row is. With `watch` false it answers false
 * and holds no subscription, so the thousands of finished rows of a long run cost nothing.
 */
export function useNewestRow(id: string, watch: boolean): boolean {
  const source = useContext(NewestRowContext);
  const subscribe = useCallback((listener: () => void) => source && watch ? source.subscribe(id, listener) : idle, [source, id, watch]);
  const newest = () => watch && (!source || source.is(id));
  return useSyncExternalStore(subscribe, newest, newest);
}
