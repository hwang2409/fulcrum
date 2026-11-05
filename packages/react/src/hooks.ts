import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { createRunStore, ImageContentBlock, RunItem, RunState } from "@fulcrum/core";
import type { Highlight } from "@fulcrum/highlight";
import { HighlightContext } from "./highlight.js";

export type RunStore = Pick<
  ReturnType<typeof createRunStore>,
  | "getState"
  | "getItem"
  | "getOutline"
  | "getOutlineSnapshot"
  | "subscribe"
  | "subscribeOutline"
> & Partial<Pick<ReturnType<typeof createRunStore>, "getDiagnostics" | "subscribeDiagnostics">>;

const StoreContext = createContext<RunStore | null>(null);
const RetryContext = createContext<(() => void) | undefined>(undefined);
export type LoadMedia = (block: ImageContentBlock, signal: AbortSignal) => Promise<Blob>;
const MEDIA_CACHE_SIZE = 32;
class MediaCache {
  private entries = new Map<string, Promise<string>>();
  constructor(private readonly load: LoadMedia) {}
  get(block: ImageContentBlock, signal: AbortSignal) {
    const key = block.source?.key;
    if (!key) return Promise.reject(new Error("image has no lazy source"));
    const cached = this.entries.get(key);
    if (cached) { this.entries.delete(key); this.entries.set(key, cached); return cached; }
    const pending = this.load(block, signal).then((blob) => URL.createObjectURL(blob));
    this.entries.set(key, pending);
    pending.catch(() => { if (this.entries.get(key) === pending) this.entries.delete(key); });
    while (this.entries.size > MEDIA_CACHE_SIZE) {
      const oldest = this.entries.entries().next().value as [string, Promise<string>] | undefined;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      void oldest[1].then(URL.revokeObjectURL, () => {});
    }
    return pending;
  }
  dispose() {
    for (const value of this.entries.values()) void value.then(URL.revokeObjectURL, () => {});
    this.entries.clear();
  }
}
const MediaContext = createContext<MediaCache | undefined>(undefined);

/** `highlight` colors tool content; `onRetry` retries history; `loadMedia` resolves generic lazy image blocks. */
export function RunProvider({ store, highlight, onRetry, loadMedia, children }: { store: RunStore; highlight?: Highlight; onRetry?: () => void; loadMedia?: LoadMedia; children?: ReactNode }) {
  const media = useMemo(() => loadMedia ? new MediaCache(loadMedia) : undefined, [loadMedia]);
  useEffect(() => () => media?.dispose(), [media]);
  return createElement(StoreContext.Provider, { value: store },
    createElement(RetryContext.Provider, { value: onRetry },
      createElement(MediaContext.Provider, { value: media },
        createElement(HighlightContext.Provider, { value: highlight }, children))));
}
export const useMediaCache = () => useContext(MediaContext);

export const useRunStore = () => {
  const store = useContext(StoreContext);
  if (!store) throw new Error("fulcrum hooks must be used inside <RunProvider>");
  return store;
};

const syncedDiagnostics = { ignoredEvents: 0, sanitizedFields: 0, desynced: false } as const;
const noSubscription = () => () => {};
export const useRunDiagnostics = () => {
  const store = useRunStore();
  const available = store.subscribeDiagnostics && store.getDiagnostics;
  const read = available ? store.getDiagnostics! : () => syncedDiagnostics;
  return useSyncExternalStore(available ? store.subscribeDiagnostics! : noSubscription, read, read);
};
export const useRunRetry = () => useContext(RetryContext);

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
    if (cache.current && cache.current.source === source && cache.current.selector === selector)
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
  const store = useRunStore();
  return useSelected(store.subscribe, store.getState, selector, equal);
}

export function useItemSelector<T>(
  id: string,
  selector: (item: RunItem | undefined) => T,
  equal: (left: T, right: T) => boolean = Object.is,
): T {
  const store = useRunStore();
  return useSelected(
    (listener) => store.subscribe(id, listener),
    () => store.getItem(id),
    selector,
    equal,
  );
}

export const useTimelineSnapshot = () => {
  const store = useRunStore();
  type Source = {
    store: RunStore;
    snapshot: ReturnType<RunStore["getOutlineSnapshot"]>;
    subscribe(listener: () => void): () => void;
    getSnapshot(): ReturnType<RunStore["getOutlineSnapshot"]>;
  };
  const current = useRef<Source>(undefined);
  if (current.current?.store !== store) {
    const source = { store, snapshot: store.getOutlineSnapshot() } as Source;
    source.subscribe = (listener) => store.subscribeOutline(() => {
      source.snapshot = store.getOutlineSnapshot();
      listener();
    });
    source.getSnapshot = () => source.snapshot;
    current.current = source;
  }
  const source = current.current;
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
};

export const useTimeline = () => useTimelineSnapshot().items;
export const useItem = (id: string) => useItemSelector(id, (item) => item);
