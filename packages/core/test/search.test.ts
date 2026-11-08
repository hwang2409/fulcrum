import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRunSearch,
  createRunStore,
  type OutlineItem,
  type RunItem,
  type RunSearchStore,
} from "../src/index.js";

const message = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const queuedStore = () => {
  const jobs: Array<() => void> = [];
  const store = createRunStore((job) => jobs.push(job));
  return { store, flush: () => { while (jobs.length) jobs.shift()!(); } };
};

class TestStore implements RunSearchStore {
  outline: OutlineItem[] = [];
  items = new Map<string, RunItem>();
  outlineListeners = new Set<() => void>();
  itemListeners = new Map<string, Set<() => void>>();

  getItem(id: string) { return this.items.get(id); }
  getOutline() { return this.outline; }
  subscribe(id: string, listener: () => void) {
    const listeners = this.itemListeners.get(id) ?? new Set();
    listeners.add(listener);
    this.itemListeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.itemListeners.delete(id);
    };
  }
  subscribeOutline(listener: () => void) {
    this.outlineListeners.add(listener);
    return () => this.outlineListeners.delete(listener);
  }
  add(item: RunItem) {
    this.items.set(item.id, item);
    this.outline.push({ id: item.id, kind: item.type });
    this.outlineListeners.forEach((listener) => listener());
  }
  change(item: RunItem) {
    this.items.set(item.id, item);
    this.itemListeners.get(item.id)?.forEach((listener) => listener());
  }
  listenerCount() {
    return this.outlineListeners.size + [...this.itemListeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }
}

const fakeMessage = (id: string, text: string, active = false): RunItem => ({
  id,
  type: "message",
  message: message(text),
  version: 1,
  active,
});

test("the public store workload writes no active index and one committed index", () => {
  const { store, flush } = queuedStore();
  for (let index = 0; index < 5_000; index++) {
    store.dispatch({ type: "message_commit", message_id: `seed-${index}`, message: message(`seed ${index}`) });
  }
  flush();
  store.dispatch({ type: "message_delta", message_id: "live", delta: "start" });
  flush();
  const search = createRunSearch(store, { maxItems: 5_001, maxCharsPerItem: 100 });
  let updates = 0;
  search.subscribe(() => updates++);

  for (let index = 0; index < 1_000; index++) {
    store.dispatch({ type: "message_delta", message_id: "live", delta: "x" });
    flush();
  }
  expect(updates).toBe(0);
  expect(search.query("start").results).toEqual([]);

  store.dispatch({ type: "message_commit", message_id: "live", message: message("committed needle") });
  flush();
  expect(updates).toBe(1);
  expect(search.query("needle").results[0]?.id).toBe("message:live");
});

test("streaming work extracts no active text and indexes once at commit", () => {
  const store = new TestStore();
  for (let index = 0; index < 5_000; index++) store.add(fakeMessage(`message:seed-${index}`, `seed ${index}`));
  let extractions = 0;
  const observed = (active: boolean, text: string): RunItem => ({
    id: "message:live",
    type: "message",
    message: { role: "assistant", content: [{ type: "text", get text() { extractions++; return text; } }] },
    version: extractions,
    active,
  });
  store.add(observed(true, "start"));
  const search = createRunSearch(store, { maxItems: 5_001, maxCharsPerItem: 100 });
  let updates = 0;
  search.subscribe(() => updates++);

  for (let index = 0; index < 1_000; index++) store.change(observed(true, `draft ${index}`));
  expect(extractions).toBe(0);
  expect(updates).toBe(0);

  store.change(observed(false, "committed needle"));
  expect(extractions).toBe(1);
  expect(updates).toBe(1);
  expect(search.query("needle").results[0]?.id).toBe("message:live");
  search.query("needle");
  expect(extractions).toBe(1);
});

test("requires explicit positive integer bounds", () => {
  const store = new TestStore();
  expect(() => createRunSearch(store, { maxItems: 0, maxCharsPerItem: 1 })).toThrow("maxItems must be a positive integer");
  expect(() => createRunSearch(store, { maxItems: 1, maxCharsPerItem: 1.5 })).toThrow("maxCharsPerItem must be a positive integer");
});

test("returns stable ids and utf-16 ranges through length-changing case folds", () => {
  const { store, flush } = queuedStore();
  store.dispatch({
    type: "message_commit",
    message_id: "unicode",
    message: message("İ ß 😀needle"),
  });
  flush();
  const search = createRunSearch(store, { maxItems: 10, maxCharsPerItem: 100 });

  expect(search.query("i").results).toEqual([{ id: "message:unicode", matches: [{ field: "message.content.0.text", start: 0, end: 1 }] }]);
  expect(search.query("SS").results).toEqual([{ id: "message:unicode", matches: [{ field: "message.content.0.text", start: 2, end: 3 }] }]);
  expect(search.query("😀").results).toEqual([{ id: "message:unicode", matches: [{ field: "message.content.0.text", start: 4, end: 6 }] }]);
  expect(search.query("NEEDLE").results).toEqual([{ id: "message:unicode", matches: [{ field: "message.content.0.text", start: 6, end: 12 }] }]);
});

test("indexes only documented display fields", () => {
  const { store, flush } = queuedStore();
  store.dispatch({ type: "message_commit", message_id: "m", message: { role: "assistant", content: [
    { type: "text", text: "visible text" },
    { type: "reasoning", text: "visible thought" },
    { type: "reasoning", text: "hidden thought", redacted: true },
  ], metadata: { secret: "opaque metadata" } } });
  store.dispatch({ type: "tool_end", tool_call: { id: "t", name: "read", arguments: { secret: "opaque argument" } }, view: { kind: "read", path: "src/visible.ts" }, tool_result: { tool_call_id: "t", content: "opaque output", is_error: false } });
  store.dispatch({ type: "approval_request", request_id: "a", tool_call: { id: "a", name: "write", arguments: {} }, view: { kind: "write", path: "visible.md" }, delegated: false });
  store.dispatch({ type: "user_message", text: "visible user", mode: "send" });
  store.dispatch({ type: "error", error: { code: "opaque-code", message: "visible error" } });
  store.dispatch({ type: "notification", data: { secret: "opaque notification" } });
  flush();
  const search = createRunSearch(store, { maxItems: 10, maxCharsPerItem: 1_000 });

  expect(search.query("visible").results.map(({ id }) => store.getItem(id)?.type)).toEqual(["message", "tool", "approval", "user", "error"]);
  for (const excluded of ["hidden", "metadata", "argument", "output", "notification", "opaque-code"]) {
    expect(search.query(excluded).results).toEqual([]);
  }
});

test("reports item and character truncation at the configured bounds", () => {
  const { store, flush } = queuedStore();
  store.dispatch({ type: "user_message", text: "oldest", mode: "send" });
  store.dispatch({ type: "user_message", text: "middle", mode: "send" });
  store.dispatch({ type: "user_message", text: "abcdef", mode: "send" });
  flush();
  const search = createRunSearch(store, { maxItems: 2, maxCharsPerItem: 3 });

  expect(search.query("abc")).toEqual({
    results: [{ id: "user:3", matches: [{ field: "user.text", start: 0, end: 3 }] }],
    truncated: { items: true, characters: true },
  });
  expect(search.query("oldest").results).toEqual([]);
  expect(search.query("def").results).toEqual([]);
});

test("history prepend preserves newest bounds and reset replaces retained text", () => {
  const { store, flush } = queuedStore();
  store.beginHistory();
  store.dispatch({ type: "message_commit", message_id: "new", message: message("new text") });
  flush();
  const search = createRunSearch(store, { maxItems: 1, maxCharsPerItem: 100 });
  store.prepend([{ type: "message_commit", message_id: "old", message: message("old text") }]);
  flush();

  expect(search.query("old")).toEqual({ results: [], truncated: { items: true, characters: false } });
  expect(search.query("new").results[0]?.id).toBe("message:new");

  store.resync([{ type: "message_commit", message_id: "reset", message: message("reset text") }]);
  expect(search.query("new").results).toEqual([]);
  expect(search.query("reset").results[0]?.id).toBe("message:reset");
});

test("dispose releases every store subscription and retained field", () => {
  const store = new TestStore();
  let reads = 0;
  store.add({
    id: "user:1",
    type: "user",
    event: { type: "user_message", mode: "send", get text() { reads++; return "before dispose"; } },
  });
  const search = createRunSearch(store, { maxItems: 1, maxCharsPerItem: 100 });
  let callbacks = 0;
  search.subscribe(() => callbacks++);
  expect(store.listenerCount()).toBe(2);
  expect(reads).toBe(1);

  search.dispose();
  expect(store.listenerCount()).toBe(0);
  store.change({ id: "user:1", type: "user", event: { type: "user_message", mode: "send", text: "after dispose" } });
  expect(reads).toBe(1);
  expect(callbacks).toBe(0);
  expect(search.query("before").results).toEqual([]);
});

test("a store-only root import drops the search implementation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fulcrum-search-"));
  try {
    const entry = join(directory, "root.ts");
    const root = new URL("../src/index.ts", import.meta.url).pathname;
    await writeFile(entry, `import { createRunStore } from ${JSON.stringify(root)}; globalThis.store = createRunStore;`);
    const build = await Bun.build({ entrypoints: [entry], target: "browser", minify: true });
    expect(build.success).toBe(true);
    const output = await build.outputs[0]!.text();
    expect(output).not.toContain("maxItems must be a positive integer");
    expect(output).not.toContain("message.content.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
