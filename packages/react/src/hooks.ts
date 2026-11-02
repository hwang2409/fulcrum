import { createContext, createElement, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { createRunStore, RunState } from "@fulcrum/core";

export type RunStore = Pick<ReturnType<typeof createRunStore>, "getState" | "subscribe">;

const StoreContext = createContext<RunStore | null>(null);

export function RunProvider({ store, children }: { store: RunStore; children?: ReactNode }) {
  return createElement(StoreContext.Provider, { value: store }, children);
}

/** `selector` must return a stable value (a primitive or a reference from state), or every store update re-renders. */
export function useRun<T>(selector: (state: RunState) => T): T {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useRun must be used inside <RunProvider>");
  const snapshot = () => selector(store.getState());
  return useSyncExternalStore(store.subscribe, snapshot, snapshot);
}

export const useTimeline = () => useRun((state) => state.items);
export const useItem = (id: string) => useRun((state) => state.itemsById[id]);
