import type { LazyContentBlock } from "@fulcrum/core";

/** Resolves lazy content. A source key must be unique for this loader's lifetime. */
export type LoadMedia = (block: LazyContentBlock, signal: AbortSignal) => Promise<Blob>;

export type MediaState =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "error"; error: unknown };

type Entry = {
  controller: AbortController;
  refs: number;
  state: MediaState;
  listeners: Set<() => void>;
};

export type MediaLease = {
  readonly state: MediaState;
  subscribe(listener: () => void): () => void;
  release(): void;
};

const CACHE_SIZE = 32;

export class MediaStore {
  private readonly entries = new Map<string, Entry>();
  private readonly unused = new Map<string, Entry>();

  constructor(private readonly load: LoadMedia) {}

  acquire(key: string, block: LazyContentBlock): MediaLease {
    const entry = this.entries.get(key) ?? this.start(key, block);
    entry.refs++;
    this.unused.delete(key);
    let released = false;
    return {
      get state() { return entry.state; },
      subscribe: (listener) => { entry.listeners.add(listener); return () => entry.listeners.delete(listener); },
      release: () => {
        if (released) return;
        released = true;
        this.release(key, entry);
      },
    };
  }

  private start(key: string, block: LazyContentBlock) {
    const entry: Entry = { controller: new AbortController(), refs: 0, state: { status: "loading" }, listeners: new Set() };
    this.entries.set(key, entry);
    void this.load(block, entry.controller.signal).then(
      (blob) => this.finish(key, entry, blob),
      (error) => this.fail(key, entry, error),
    );
    return entry;
  }

  private finish(key: string, entry: Entry, blob: Blob) {
    if (this.entries.get(key) !== entry || entry.controller.signal.aborted) return;
    entry.state = { status: "ready", url: URL.createObjectURL(blob) };
    entry.listeners.forEach((listener) => listener());
    if (entry.refs === 0) this.cache(key, entry);
  }

  private fail(key: string, entry: Entry, error: unknown) {
    if (this.entries.get(key) !== entry) return;
    entry.state = { status: "error", error };
    entry.listeners.forEach((listener) => listener());
    if (entry.refs === 0) this.entries.delete(key);
  }

  private release(key: string, entry: Entry) {
    if (--entry.refs > 0 || this.entries.get(key) !== entry) return;
    if (entry.state.status === "loading") {
      this.entries.delete(key);
      entry.controller.abort();
    } else if (entry.state.status === "ready") this.cache(key, entry);
    else this.entries.delete(key);
  }

  private cache(key: string, entry: Entry) {
    this.unused.delete(key);
    this.unused.set(key, entry);
    while (this.unused.size > CACHE_SIZE) this.evict(this.unused.keys().next().value as string);
  }

  private evict(key: string) {
    const entry = this.unused.get(key);
    if (!entry) return;
    this.unused.delete(key);
    this.entries.delete(key);
    if (entry.state.status === "ready") URL.revokeObjectURL(entry.state.url);
  }

  dispose() {
    for (const entry of this.entries.values()) {
      entry.controller.abort();
      if (entry.state.status === "ready") URL.revokeObjectURL(entry.state.url);
    }
    this.entries.clear();
    this.unused.clear();
  }
}
