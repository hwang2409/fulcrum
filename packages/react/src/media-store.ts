import type { LazyContentBlock } from "@fulcrum/core";

/** Resolves lazy content. A source key must be unique for this loader's lifetime. */
export type LoadMedia = (block: LazyContentBlock, signal: AbortSignal) => Promise<Blob>;

export type MediaState =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "error"; error: unknown };

type LeaseRecord = {
  broken: boolean;
  listeners: Set<() => void>;
  released: boolean;
  rendered?: Entry;
  target: Entry;
};

type Entry = {
  block: LazyContentBlock;
  controller: AbortController;
  generation: number;
  leases: Set<LeaseRecord>;
  renderRefs: number;
  revoked: boolean;
  state: MediaState;
};

export type MediaLease = {
  readonly generation: number;
  readonly renderGeneration: number;
  readonly state: MediaState;
  commit(generation: number): void;
  invalidate(generation: number): void;
  subscribe(listener: () => void): () => void;
  release(): void;
};

const CACHE_SIZE = 32;

export class MediaStore {
  private readonly entries = new Map<string, Entry>();
  private readonly generations = new Set<Entry>();
  private readonly unused = new Map<string, Entry>();
  private disposed = false;
  private nextGeneration = 0;

  constructor(private readonly load: LoadMedia) {}

  acquire(key: string, block: LazyContentBlock): MediaLease {
    const entry = this.entries.get(key) ?? this.start(key, block);
    const record: LeaseRecord = { broken: false, listeners: new Set(), released: false, target: entry };
    entry.leases.add(record);
    this.unused.delete(key);
    const shown = () => entryForState(record);
    return {
      get generation() { return shown().generation; },
      get renderGeneration() { const entry = shown(); return entry.state.status === "ready" ? entry.generation : 0; },
      get state() { return shown().state; },
      commit: (generation) => this.commit(record, generation),
      invalidate: (generation) => this.invalidate(key, generation, record),
      subscribe: (listener) => { record.listeners.add(listener); return () => record.listeners.delete(listener); },
      release: () => this.release(key, record),
    };
  }

  private invalidate(key: string, generation: number, source: LeaseRecord) {
    if (source.released || entryForState(source).generation !== generation) return;
    source.broken = true;
    const entry = this.entries.get(key);
    if (!entry || entry.generation !== generation) {
      source.listeners.forEach((listener) => listener());
      return;
    }
    const replacement = this.start(key, entry.block);
    const leases = [...entry.leases];
    for (const lease of leases) {
      entry.leases.delete(lease);
      lease.target = replacement;
      replacement.leases.add(lease);
    }
    leases.forEach((lease) => lease.listeners.forEach((listener) => listener()));
    this.cleanup(key, entry);
  }

  private start(key: string, block: LazyContentBlock) {
    const entry: Entry = {
      block,
      controller: new AbortController(),
      generation: ++this.nextGeneration,
      leases: new Set(),
      renderRefs: 0,
      revoked: false,
      state: { status: "loading" },
    };
    this.entries.set(key, entry);
    this.generations.add(entry);
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
    if (entry.leases.size === 0 && entry.renderRefs === 0) this.cache(key, entry);
  }

  private fail(key: string, entry: Entry, error: unknown) {
    if (this.entries.get(key) !== entry) return;
    entry.state = { status: "error", error };
    this.notify(entry);
    this.cleanup(key, entry);
  }

  private commit(record: LeaseRecord, generation: number) {
    if (record.released) return;
    const next = generation === record.target.generation && record.target.state.status === "ready"
      ? record.target
      : generation === record.rendered?.generation ? record.rendered : undefined;
    if (next === record.rendered) return;
    if (next) next.renderRefs++;
    const previous = record.rendered;
    record.rendered = next;
    if (next === record.target) record.broken = false;
    if (previous) {
      previous.renderRefs--;
      this.cleanup(previous.block.source.key, previous);
    }
  }

  private release(key: string, record: LeaseRecord) {
    if (record.released) return;
    record.released = true;
    record.target.leases.delete(record);
    const target = record.target;
    const rendered = record.rendered;
    if (rendered) rendered.renderRefs--;
    record.rendered = undefined;
    record.listeners.clear();
    this.cleanup(key, target);
    if (rendered && rendered !== target) this.cleanup(key, rendered);
  }

  private cleanup(key: string, entry: Entry) {
    if (entry.leases.size > 0 || entry.renderRefs > 0) return;
    if (this.disposed || this.entries.get(key) !== entry) this.discard(entry);
    else if (entry.state.status === "loading") {
      this.entries.delete(key);
      this.discard(entry);
    } else if (entry.state.status === "ready") this.cache(key, entry);
    else {
      this.entries.delete(key);
      this.generations.delete(entry);
    }
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
    this.discard(entry);
  }

  private discard(entry: Entry) {
    entry.controller.abort();
    this.revoke(entry);
    this.generations.delete(entry);
  }

  private revoke(entry: Entry) {
    if (entry.state.status !== "ready" || entry.revoked) return;
    entry.revoked = true;
    URL.revokeObjectURL(entry.state.url);
  }

  dispose() {
    this.disposed = true;
    this.entries.clear();
    this.unused.clear();
    for (const entry of this.generations) {
      entry.controller.abort();
      if (entry.renderRefs === 0) this.discard(entry);
    }
  }
}

const entryForState = (record: LeaseRecord) =>
  !record.broken && record.rendered?.state.status === "ready" && record.target.state.status !== "ready"
    ? record.rendered
    : record.target;
