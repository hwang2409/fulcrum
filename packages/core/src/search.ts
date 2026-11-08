import type { RunItem, ToolView } from "./events.js";
import type { OutlineItem } from "./reducer.js";

export interface RunSearchStore {
  getItem(id: string): RunItem | undefined;
  getOutline(): readonly OutlineItem[];
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

const fold = (value: string) => {
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const character of value) {
    const start = offset;
    offset += character.length;
    const part = character.toUpperCase().toLowerCase();
    folded += part;
    for (let index = 0; index < part.length; index++) {
      starts.push(start);
      ends.push(offset);
    }
  }
  return { folded, starts, ends };
};

const viewFields = (prefix: string, view: ToolView | undefined): Array<[string, string | undefined]> => {
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

const entryFor = (item: RunItem, maxChars: number): SearchEntry | undefined => {
  if ((item.type === "message" || item.type === "tool") && item.active) return undefined;
  const source = displayFields(item);
  if (source.length === 0) return undefined;
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
    if (remaining === 0) {
      if (source.slice(index + 1).some(([, next]) => next?.length)) truncated = true;
      break;
    }
  }
  return fields.length > 0 || truncated ? { id: item.id, fields, truncated } : undefined;
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
    if (previous !== next) publish();
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
  const reconcile = () => {
    if (disposed) return;
    reconciling = true;
    dirty = false;
    const outline = store.getOutline();
    const nextItemsTruncated = outline.length > options.maxItems;
    const nextOrder = outline.slice(-options.maxItems).map(({ id }) => id);
    const nextIds = new Set(nextOrder);
    let changed = nextItemsTruncated !== itemsTruncated || nextOrder.length !== order.length || nextOrder.some((id, index) => id !== order[index]);
    itemsTruncated = nextItemsTruncated;
    order = nextOrder;
    for (const [id, item] of watched) {
      if (nextIds.has(id)) continue;
      item.unsubscribe();
      watched.delete(id);
      if (entries.delete(id)) changed = true;
    }
    for (const id of nextOrder) if (!watched.has(id)) watch(id);
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
      itemsTruncated = false;
      listeners.clear();
    },
  };
}
