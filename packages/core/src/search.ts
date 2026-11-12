import type { RunItem, StoredToolView, ToolView } from "./events.js";
import type { OutlineChange, OutlineSnapshot } from "./store.js";
import { fold } from "./fold.js";

export interface RunSearchStore {
  getItem(id: string): RunItem | undefined;
  getOutlineSnapshot(): OutlineSnapshot;
  subscribe(id: string, listener: () => void): () => void;
  subscribeOutline(listener: () => void): () => void;
}

export interface RunSearchOptions {
  /** Maximum number of newest outline rows retained by the index. */
  maxItems: number;
  /** Maximum retained UTF-16 code units across one row's searchable fields. */
  maxCharsPerItem: number;
}

export interface RunSearchMatch {
  /** Path to the documented display string that matched. */
  readonly field: string;
  /** Inclusive UTF-16 code unit offset into the original field string. */
  readonly start: number;
  /** Exclusive UTF-16 code unit offset into the original field string. */
  readonly end: number;
}

export interface RunSearchResult {
  readonly id: string;
  readonly matches: readonly RunSearchMatch[];
}

export interface RunSearchQuery {
  readonly results: readonly RunSearchResult[];
  readonly truncated: {
    /** Older outline rows fell outside `maxItems`. */
    readonly items: boolean;
    /** At least one retained row exceeded `maxCharsPerItem`. */
    readonly characters: boolean;
  };
}

export interface RunSearch {
  /** Searches retained committed rows without reading the store again. Cost is O(retained characters + matches). */
  query(text: string): RunSearchQuery;
  /** Runs after indexed text or truncation state changes. */
  subscribe(listener: () => void): () => void;
  /** Removes store subscriptions and releases all retained text. */
  dispose(): void;
}

type SearchField = {
  field: string;
  value: string;
  folded: string;
  starts: number[];
  ends: number[];
};
type SearchEntry = { id: string; fields: SearchField[]; truncated: boolean };
type Watched = { item: RunItem | undefined; unsubscribe: () => void };

const viewFields = (prefix: string, view: ToolView | StoredToolView | undefined): Array<[string, string | undefined]> => {
  if (!view) return [];
  switch (view.kind) {
    case "shell": return [[`${prefix}.command`, view.command], [`${prefix}.cwd`, view.cwd]];
    case "read":
    case "edit":
    case "write": return [[`${prefix}.path`, view.path]];
    case "search": return [[`${prefix}.pattern`, view.pattern], [`${prefix}.path`, view.path]];
    case "fetch": return [[`${prefix}.title`, view.title], [`${prefix}.url`, view.url], [`${prefix}.query`, view.query]];
  }
};

const displayFields = (item: RunItem): Array<[string, string | undefined]> => {
  switch (item.type) {
    case "message": {
      const fields: Array<[string, string | undefined]> = [];
      item.message.content.forEach((block, index) => {
        if (block.type !== "text" && block.type !== "reasoning") return;
        const text = block.text;
        if (typeof text !== "string") return;
        if (block.type === "text") fields.push([`message.content.${index}.text`, text]);
        if (block.type === "reasoning" && block.redacted !== true) fields.push([`message.content.${index}.reasoning`, text]);
      });
      if (item.text) fields.push(["message.text", item.text]);
      return fields;
    }
    case "tool":
      return [["tool.name", item.tool_call.name], ...viewFields("tool.view", item.view)];
    case "approval": {
      if (item.request.type !== "approval_request") return [];
      return [["approval.tool", item.request.tool_call.name], ...viewFields("approval.view", item.request.view)];
    }
    case "user":
      return item.event.type === "user_message" ? [["user.text", item.event.text]] : [];
    case "error":
      return item.event.type === "error" ? [["error.text", item.event.error.message]] : [];
    default:
      return [];
  }
};

const sliceAtCodePoint = (value: string, limit: number) => {
  if (value.length <= limit) return value;
  if (limit > 0 && /[\uD800-\uDBFF]/.test(value[limit - 1]!) && /[\uDC00-\uDFFF]/.test(value[limit]!)) return value.slice(0, limit - 1);
  return value.slice(0, limit);
};

const collectFields = (source: Array<[string, string | undefined]>, maxChars: number) => {
  let remaining = maxChars;
  let truncated = false;
  const fields: SearchField[] = [];
  for (let index = 0; index < source.length; index++) {
    const [field, original] = source[index]!;
    if (original === undefined) continue;
    const value = sliceAtCodePoint(original, remaining);
    if (value.length < original.length) truncated = true;
    if (value.length > 0) fields.push({ field, value, ...fold(value) });
    remaining -= value.length;
    if (remaining > 0) continue;
    truncated ||= source.slice(index + 1).some(([, next]) => Boolean(next?.length));
    break;
  }
  return { fields, truncated };
};

const entryFor = (item: RunItem, maxChars: number): SearchEntry | undefined => {
  if ((item.type === "message" || item.type === "tool") && item.active) return undefined;
  const source = displayFields(item);
  if (source.length === 0) return undefined;
  const collected = collectFields(source, maxChars);
  return collected.fields.length > 0 || collected.truncated ? { id: item.id, ...collected } : undefined;
};

const sameEntry = (left: SearchEntry | undefined, right: SearchEntry | undefined) => {
  if (!left || !right) return left === right;
  return left.truncated === right.truncated
    && left.fields.length === right.fields.length
    && left.fields.every((field, index) => field.field === right.fields[index]?.field && field.value === right.fields[index]?.value);
};

const matchesFor = (entry: SearchEntry, needle: string) => {
  const matches: RunSearchMatch[] = [];
  for (const field of entry.fields) {
    let from = 0;
    while (from <= field.folded.length - needle.length) {
      const index = field.folded.indexOf(needle, from);
      if (index < 0) break;
      matches.push({ field: field.field, start: field.starts[index]!, end: field.ends[index + needle.length - 1]! });
      from = index + Math.max(needle.length, 1);
    }
  }
  return matches;
};

const validBound = (name: string, value: number) => {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
};

/** Creates a bounded, opt-in index over one run's documented display fields. */
export function createRunSearch(store: RunSearchStore, options: RunSearchOptions): RunSearch {
  validBound("maxItems", options.maxItems);
  validBound("maxCharsPerItem", options.maxCharsPerItem);

  let disposed = false;
  let order: string[] = [];
  let outlineItems: OutlineSnapshot["items"] | undefined;
  let prefixLength = 0;
  let itemsTruncated = false;
  const entries = new Map<string, SearchEntry>();
  const watched = new Map<string, Watched>();
  const listeners = new Set<() => void>();
  let reconciling = false;
  let dirty = false;

  const publish = () => {
    if (disposed) return;
    if (reconciling) dirty = true;
    else listeners.forEach((listener) => listener());
  };
  const update = (id: string, item: RunItem | undefined) => {
    const previous = entries.get(id);
    const next = item ? entryFor(item, options.maxCharsPerItem) : undefined;
    if (next) entries.set(id, next);
    else entries.delete(id);
    if (!sameEntry(previous, next)) publish();
  };
  const watch = (id: string) => {
    const initial = store.getItem(id);
    const watchedItem: Watched = { item: initial, unsubscribe: () => {} };
    watchedItem.unsubscribe = store.subscribe(id, () => {
      if (disposed) return;
      const item = store.getItem(id);
      if (item === watchedItem.item) return;
      watchedItem.item = item;
      update(id, item);
    });
    watched.set(id, watchedItem);
    update(id, initial);
  };
  const replaceOrder = (snapshot: OutlineSnapshot) => {
    const next = snapshot.items.slice(-options.maxItems).map(({ id }) => id);
    const changed = next.length !== order.length || next.some((id, index) => id !== order[index]);
    order = next;
    prefixLength = snapshot.items.length - order.length;
    return changed;
  };
  const applySplices = (change: OutlineChange, items: OutlineSnapshot["items"]) => {
    const added = new Set<string>();
    const removed = new Set<string>();
    const add = (id: string) => removed.delete(id) || added.add(id);
    const remove = (id: string) => added.delete(id) || removed.add(id);
    let changed = false;
    for (const splice of change.splices) {
      const end = splice.index + splice.deleteCount;
      if (end <= prefixLength) {
        prefixLength += splice.items.length - splice.deleteCount;
        continue;
      }
      changed = true;
      const localIndex = Math.max(0, splice.index - prefixLength);
      const deletedFromPrefix = Math.max(0, prefixLength - splice.index);
      prefixLength -= deletedFromPrefix;
      const inserted = splice.items.map(({ id }) => id);
      order.slice(localIndex, localIndex + splice.deleteCount - deletedFromPrefix).forEach(remove);
      inserted.forEach(add);
      order.splice(localIndex, splice.deleteCount - deletedFromPrefix, ...inserted);
    }
    const excess = Math.max(0, order.length - options.maxItems);
    if (excess > 0) {
      order.slice(0, excess).forEach(remove);
      order.splice(0, excess);
      prefixLength += excess;
    }
    const missing = Math.min(options.maxItems - order.length, prefixLength);
    if (missing > 0) {
      const restored = items.slice(prefixLength - missing, prefixLength).map(({ id }) => id);
      restored.forEach(add);
      order.unshift(...restored);
      prefixLength -= missing;
    }
    removed.forEach((id) => { if (unwatch(id)) changed = true; });
    added.forEach((id) => { if (!watched.has(id)) watch(id); });
    return changed;
  };
  const rescan = (snapshot: OutlineSnapshot) => {
    let changed = replaceOrder(snapshot);
    const nextIds = new Set(order);
    for (const id of watched.keys()) if (!nextIds.has(id) && unwatch(id)) changed = true;
    for (const id of order) if (!watched.has(id)) watch(id);
    return changed;
  };
  const unwatch = (id: string) => {
    watched.get(id)?.unsubscribe();
    watched.delete(id);
    return entries.delete(id);
  };
  const reconcile = () => {
    if (disposed) return;
    reconciling = true;
    dirty = false;
    const snapshot = store.getOutlineSnapshot();
    // Edit in place only when the change starts from the rows this index holds; a fresh store has no change yet.
    let changed = snapshot.change && snapshot.change.from === outlineItems
      ? applySplices(snapshot.change, snapshot.items)
      : rescan(snapshot);
    outlineItems = snapshot.items;
    const nextItemsTruncated = snapshot.items.length > options.maxItems;
    changed ||= nextItemsTruncated !== itemsTruncated;
    itemsTruncated = nextItemsTruncated;
    if (changed) dirty = true;
    reconciling = false;
    if (dirty) listeners.forEach((listener) => listener());
  };

  const unsubscribeOutline = store.subscribeOutline(reconcile);
  reconcile();

  return {
    query(text) {
      if (disposed) return { results: [], truncated: { items: false, characters: false } };
      if (text.length === 0) return { results: [], truncated: { items: itemsTruncated, characters: [...entries.values()].some(({ truncated }) => truncated) } };
      const needle = fold(text).folded;
      const results: RunSearchResult[] = [];
      let characters = false;
      for (const id of order) {
        const entry = entries.get(id);
        if (!entry) continue;
        characters ||= entry.truncated;
        const matches = matchesFor(entry, needle);
        if (matches.length > 0) results.push({ id, matches });
      }
      return { results, truncated: { items: itemsTruncated, characters } };
    },
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeOutline();
      watched.forEach(({ unsubscribe }) => unsubscribe());
      watched.clear();
      entries.clear();
      order = [];
      outlineItems = undefined;
      prefixLength = 0;
      itemsTruncated = false;
      listeners.clear();
    },
  };
}
