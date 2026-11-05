import type { LazyContentBlock } from "@fulcrum/core";

/** Resolves lazy content. A source key must be unique for this loader's lifetime. */
export type LoadMedia = (block: LazyContentBlock, signal: AbortSignal) => Promise<Blob>;
export type MediaState = { status: "loading" } | { status: "ready"; url: string } | { status: "error"; error: unknown };

type LeaseRecord = { bad: boolean; notify?: () => void; rendered?: Entry; next: Entry };
type Entry = { block: LazyContentBlock; controller: AbortController; key: string; refs: Set<LeaseRecord>; state: MediaState };
export type MediaLease = {
  read(): MediaState;
  commit(generation: MediaState | undefined): void;
  invalidate(generation: MediaState): void;
  release(): void;
};

const CACHE_SIZE = 32;
const shown = (lease: LeaseRecord) => !lease.bad && lease.rendered?.state.status === "ready" && lease.next.state.status !== "ready" ? lease.rendered : lease.next;

export function createMediaStore(load: LoadMedia) {
  const entries = new Map<string, Entry>();
  const unused = new Set<Entry>();
  const notify = (entry: Entry) => entry.refs.forEach((lease) => lease.notify?.());
  const discard = (entry: Entry) => {
    entry.controller.abort();
    if (entry.state.status === "ready") URL.revokeObjectURL(entry.state.url);
  };
  const cache = (entry: Entry) => {
    unused.add(entry);
    if (unused.size <= CACHE_SIZE) return;
    const oldest = unused.values().next().value as Entry;
    unused.delete(oldest);
    entries.delete(oldest.key);
    discard(oldest);
  };
  const cleanup = (entry: Entry) => {
    if (entry.refs.size > 0) return;
    if (entries.get(entry.key) !== entry) discard(entry);
    else if (entry.state.status === "loading") {
      entries.delete(entry.key);
      discard(entry);
    } else if (entry.state.status === "ready") cache(entry);
    else entries.delete(entry.key);
  };
  const start = (key: string, block: LazyContentBlock) => {
    const entry: Entry = { block, controller: new AbortController(), key, refs: new Set(), state: { status: "loading" } };
    entries.set(key, entry);
    void load(block, entry.controller.signal).then((blob) => {
      if (entries.get(key) !== entry) return;
      entry.state = { status: "ready", url: URL.createObjectURL(blob) };
      notify(entry);
      if (entry.refs.size === 0) cache(entry);
    }, (error) => {
      if (entries.get(key) !== entry) return;
      entry.state = { status: "error", error };
      notify(entry);
      cleanup(entry);
    });
    return entry;
  };
  const acquire = (key: string, block: LazyContentBlock, notify: () => void): MediaLease => {
    const entry = entries.get(key) ?? start(key, block);
    const lease: LeaseRecord = { bad: false, notify, next: entry };
    entry.refs.add(lease);
    unused.delete(entry);
    const commit = (generation: object | undefined) => {
      if (!lease.next.refs.has(lease)) return;
      const next = generation === lease.next.state && lease.next.state.status === "ready" ? lease.next : generation === lease.rendered?.state ? lease.rendered : undefined;
      if (next === lease.rendered) return;
      const previous = lease.rendered;
      lease.rendered = next;
      if (next === lease.next) lease.bad = false;
      if (previous && previous !== lease.next) {
        previous.refs.delete(lease);
        cleanup(previous);
      }
    };
    return {
      read: () => shown(lease).state,
      commit,
      invalidate: (generation) => {
        if (!lease.next.refs.has(lease) || shown(lease).state !== generation) return;
        lease.bad = true;
        const current = entries.get(key);
        if (!current || current.state !== generation) { lease.notify?.(); return; }
        const replacement = start(key, current.block);
        const refs = [...current.refs];
        for (const item of refs) {
          item.next = replacement;
          replacement.refs.add(item);
          if (item.rendered !== current) current.refs.delete(item);
        }
        refs.forEach((item) => item.notify?.());
        cleanup(current);
      },
      release: () => {
        if (!lease.next.refs.delete(lease)) return;
        const next = lease.next;
        const rendered = lease.rendered;
        if (rendered) rendered.refs.delete(lease);
        lease.rendered = undefined;
        lease.notify = undefined;
        cleanup(next);
        if (rendered && rendered !== next) cleanup(rendered);
      },
    };
  };
  const dispose = () => {
    for (const entry of entries.values()) {
      entry.controller.abort();
      if (entry.refs.size === 0 && entry.state.status === "ready") URL.revokeObjectURL(entry.state.url);
    }
    entries.clear();
    unused.clear();
  };
  return { acquire, dispose };
}

export type MediaStore = ReturnType<typeof createMediaStore>;
