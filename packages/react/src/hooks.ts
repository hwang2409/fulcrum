import {
  createContext,
  createElement,
  useContext,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { createRunStore, RunItem, RunState } from "@fulcrum/core";

export type RunStore = Pick<
  ReturnType<typeof createRunStore>,
  | "getState"
  | "getItem"
  | "getOutline"
  | "subscribe"
  | "subscribeOutline"
>;

const StoreContext = createContext<RunStore | null>(null);

export function RunProvider({ store, children }: { store: RunStore; children?: ReactNode }) {
  return createElement(StoreContext.Provider, { value: store }, children);
}

const useStore = () => {
  const store = useContext(StoreContext);
  if (!store) throw new Error("fulcrum hooks must be used inside <RunProvider>");
  return store;
};

function useSelected<S, T>(
  subscribe: (listener: () => void) => () => void,
  read: () => S,
  selector: (state: S) => T,
  equal: (left: T, right: T) => boolean,
): T {
  const cache = useRef<
    { source: S; selector: (state: S) => T; value: T } | undefined
  >(undefined);
  const snapshot = () => {
    const source = read();
    if (cache.current?.source === source && cache.current.selector === selector)
      return cache.current.value;
    const value = selector(source);
    if (cache.current && equal(cache.current.value, value)) {
      cache.current = { source, selector, value: cache.current.value };
      return cache.current.value;
    }
    cache.current = { source, selector, value };
    return value;
  };
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function useRun<T>(
  selector: (state: RunState) => T,
  equal: (left: T, right: T) => boolean = Object.is,
): T {
  const store = useStore();
  return useSelected(store.subscribe, store.getState, selector, equal);
}

export function useItemSelector<T>(
  id: string,
  selector: (item: RunItem | undefined) => T,
  equal: (left: T, right: T) => boolean = Object.is,
): T {
  const store = useStore();
  return useSelected(
    (listener) => store.subscribe(id, listener),
    () => store.getItem(id),
    selector,
    equal,
  );
}

export const useTimeline = () => {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribeOutline,
    store.getOutline,
    store.getOutline,
  );
};

export const useItem = (id: string) => useItemSelector(id, (item) => item);
