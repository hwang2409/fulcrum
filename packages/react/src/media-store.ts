import type { LazyContentBlock } from "@fulcrum/core";

/** Resolves lazy content. A source key must be unique for this loader's lifetime. */
export type LoadMedia = (block: LazyContentBlock, signal: AbortSignal) => Promise<Blob>;

export type MediaState =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "error"; error: unknown };

type LeaseRecord = {
  entry: Entry;
  listeners: Set<() => void>;
  released: boolean;
};

type Entry = {
  block: LazyContentBlock;
  controller: AbortController;
  generation: number;
  leases: Set<LeaseRecord>;
  revoked: boolean;
  state: MediaState;
};

export type MediaLease = {
  readonly generation: number;
  readonly state: MediaState;
  subscribe(listener: () => void): () => void;
  release(): void;
};

const CACHE_SIZE = 32;

export class MediaStore {
  private readonly entries = new Map<string, Entry>();
  private readonly unused = new Map<string, Entry>();
  private nextGeneration = 0;

  constructor(private readonly load: LoadMedia) {}

  acquire(key: string, block: LazyContentBlock): MediaLease {
    const entry = this.entries.get(key) ?? this.start(key, block);
    const record: LeaseRecord = { entry, listeners: new Set(), released: false };
    entry.leases.add(record);
    this.unused.delete(key);
    return {
      get generation() { return record.entry.generation; },
      get state() { return record.entry.state; },
      subscribe: (listener) => { record.listeners.add(listener); return () => record.listeners.delete(listener); },
      release: () => {
        if (record.released) return;
        record.released = true;
        record.entry.leases.delete(record);
        this.release(key, record.entry);
      },
    };
  }

  invalidate(key: string, generation: number) {
    const entry = this.entries.get(key);
    if (!entry || entry.generation !== generation) return;
    const replacement = this.start(key, entry.block);
    const leases = [...entry.leases];
    for (const lease of leases) {
      entry.leases.delete(lease);
      lease.entry = replacement;
      replacement.leases.add(lease);
    }
    leases.forEach((lease) => lease.listeners.forEach((listener) => listener()));
    this.release(key, entry);
  }

  private start(key: string, block: LazyContentBlock) {
    const entry: Entry = {
      block,
      controller: new AbortController(),
      generation: ++this.nextGeneration,
      leases: new Set(),
      revoked: false,
      state: { status: "loading" },
    };
    this.entries.set(key, entry);
    void this.load(block, entry.controller.signal).then(
      (blob) => this.finish(key, entry, blob),
      (error) => this.fail(key, entry, error),
    );
    return entry;
  }

  private notify(entry: Entry) {
    entry.leases.forEach((lease) => lease.listeners.forEach((listener) => listener()));
  }

  private finish(key: string, entry: Entry, blob: Blob) {
    if (this.entries.get(key) !== entry || entry.controller.signal.aborted) return;
    entry.state = { status: "ready", url: URL.createObjectURL(blob) };
    this.notify(entry);
    if (entry.leases.size === 0) this.cache(key, entry);
  }

  private fail(key: string, entry: Entry, error: unknown) {
    if (this.entries.get(key) !== entry) return;
    entry.state = { status: "error", error };
    this.notify(entry);
    if (entry.leases.size === 0) this.entries.delete(key);
  }

  private release(key: string, entry: Entry) {
    if (entry.leases.size > 0) return;
    if (this.entries.get(key) !== entry) {
      entry.controller.abort();
      this.revoke(entry);
    } else if (entry.state.status === "loading") {
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
    this.revoke(entry);
  }

  private revoke(entry: Entry) {
    if (entry.state.status !== "ready" || entry.revoked) return;
    entry.revoked = true;
    URL.revokeObjectURL(entry.state.url);
  }

  dispose() {
    for (const entry of this.entries.values()) {
      entry.controller.abort();
      this.revoke(entry);
    }
    this.entries.clear();
    this.unused.clear();
  }
}
