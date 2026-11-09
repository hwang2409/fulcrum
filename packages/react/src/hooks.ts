import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { createRunStore, LazyContentBlock, RunItem, RunState } from "@fulcrum/core";
import type { Highlight } from "@fulcrum/highlight";
import { HighlightContext } from "./highlight.js";
import { createMediaStore, type LoadMedia, type MediaLease, type MediaState, type MediaStore } from "./media-store.js";
export type { LoadMedia } from "./media-store.js";

export type RunStore = Pick<
  ReturnType<typeof createRunStore>,
  | "getState"
  | "getItem"
  | "getOutline"
  | "getOutlineSnapshot"
  | "subscribe"
  | "subscribeOutline"
> & Partial<Pick<ReturnType<typeof createRunStore>, "getDiagnostics" | "subscribeDiagnostics" | "hasMessageDelivery">>;

const StoreContext = createContext<RunStore | null>(null);
const RetryContext = createContext<(() => void) | undefined>(undefined);
const MediaContext = createContext<MediaStore | undefined>(undefined);

/** `highlight` colors tool content; `onRetry` retries history; `loadMedia` resolves lazy content blocks. */
export function RunProvider({ store, highlight, onRetry, loadMedia, children }: { store: RunStore; highlight?: Highlight; onRetry?: () => void; loadMedia?: LoadMedia; children?: ReactNode }) {
  const media = useMemo(() => loadMedia ? createMediaStore(loadMedia) : undefined, [loadMedia]);
  useEffect(() => () => media?.dispose(), [media]);
  return createElement(StoreContext.Provider, { value: store },
    createElement(RetryContext.Provider, { value: onRetry },
      createElement(MediaContext.Provider, { value: media },
        createElement(HighlightContext.Provider, { value: highlight }, children))));
}
const idleMedia = { status: "idle" } as const;
type MediaView = MediaState | typeof idleMedia;
export function useMedia(block: LazyContentBlock | undefined, active: boolean) {
  const store = useContext(MediaContext);
  const lease = useRef<MediaLease>(undefined);
  const [view, setView] = useState<MediaView>(idleMedia);
  const release = useCallback(() => { lease.current?.release(); lease.current = undefined; }, []);
  useEffect(() => {
    release();
    setView(idleMedia);
    return release;
  }, [store, block?.source.key, release]);
  useEffect(() => {
    if (!store || !block || !active) {
      if (lease.current?.read().status === "loading") { release(); setView(idleMedia); }
      return;
    }
    if (lease.current) return;
    let next: MediaLease;
    const update = () => setView(next.read());
    next = store.acquire(block.source.key, block, update);
    lease.current = next;
    update();
  }, [active, block, store, release]);
  useLayoutEffect(() => { lease.current?.commit(view.status === "ready" ? view : undefined); });
  const retry = useCallback(() => {
    if (view.status !== "idle") lease.current?.invalidate(view);
  }, [view]);
  return { state: view, retry, available: !!store };
}

export const useRunStore = () => {
  const store = useContext(StoreContext);
  if (!store) throw new Error("fulcrum hooks must be used inside <RunProvider>");
  return store;
};

const syncedDiagnostics = { ignoredEvents: 0, sanitizedFields: 0, desynced: false } as const;
const noSubscription = () => () => {};
const never = () => false;
/**
 * Whether the run holds a user message with this delivery id (the harness's echo of a sent message, or its history
 * row). False with no id, outside a `RunProvider`, or for a store without `hasMessageDelivery`.
 */
export const useMessageDelivered = (deliveryId: string | undefined) => {
  const store = useContext(StoreContext);
  const read = deliveryId !== undefined && store?.hasMessageDelivery ? () => store.hasMessageDelivery!(deliveryId) : never;
  return useSyncExternalStore(read === never ? noSubscription : store!.subscribe, read, read);
};

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
