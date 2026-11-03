import { normalizeLanguage } from "./names.js";
import type { Highlight, HighlightContext, Token } from "./types.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";

const MAX_BLOCK = 512 * 1024;
const MAX_LINES = 10_000;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BLOCKS = 512; // tool cards and mounted viewer rows each hold a block
type WorkerLike = { postMessage(value: WorkerRequest): void; terminate(): void; onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null; onerror: ((event: ErrorEvent) => unknown) | null };
/**
 * `onHighlightUnavailable` is called once, in a microtask, when highlighting stops for good: the environment has no
 * Worker (SSR, tests), the worker cannot be built (a strict CSP), or it failed again after its one restart. From then
 * on every block is its exact plain text. Nothing is announced to the user; an app may show its own notice here.
 */
export type HighlighterOptions = { workerFactory?: () => WorkerLike; onHighlightUnavailable?: () => void };
type Pending = { resolve: (tokens: Token[]) => void; code: string; language: string; context: HighlightContext };
// The page's thread never tokenizes: compiling one cold regex or scanner cannot be split (568 ms for cpp in Chromium),
// so a UI freeze would be worse than missing colors. This module must not import the tokenizer runtime (a test checks).
// The worker is hung only when it answers nothing for this long while work is pending. A per-request deadline would
// misfire on a long backlog.
const WORKER_SILENCE_MS = 2_000;
// A failed, crashed, or silent worker is replaced once, after this pause, and gets every pending request again.
const RESTART_BACKOFF_MS = 250;
// `code` is kept so a hit is checked against the exact source: an (id, version) pair from a caller is a hint, never proof of content.
type CacheEntry = { tokens: Token[]; weight: number; used: number; done: boolean; id: string; code: string };

export function createController(options: HighlighterOptions = {}): Highlight {
  let worker: WorkerLike | undefined;
  let requestId = 0;
  let restarted = false;
  let unavailable = false;
  let disposed = false;
  let clock = 0;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let restart: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<number, Pending>();
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<Token[]>>();
  const inflightCode = new Map<string, string>();
  const inflightIds = new Map<string, string>();
  const latestSettled = new Map<string, { key: string; tokens: Token[] }>();
  const versions = new Map<string, string[]>();
  const current = new Map<string, string>();
  const latestVersion = new Map<string, number>();
  const listeners = new Map<string, Set<() => void>>();

  const plain = (code: string): Token[] => code ? [{ text: code }] : [];
  const cacheKey = (context: HighlightContext, language: string) => `${context.id}\0${context.version}\0${language}`;
  const dropCompleted = (key: string, entry: CacheEntry) => {
    cache.delete(key);
    const keys = versions.get(entry.id)?.filter((item) => item !== key) ?? [];
    if (keys.length) versions.set(entry.id, keys);
    else versions.delete(entry.id);
  };
  const weigh = (code: string, tokens: Token[]) => code.length * 2 + tokens.reduce((sum, token) => sum + token.text.length * 2 + 32, 0);
  const remember = (key: string, context: HighlightContext, code: string, tokens: Token[]) => {
    cache.set(key, { tokens, weight: weigh(code, tokens), used: ++clock, done: context.state === "done", id: context.id, code });
    const keys = [...(versions.get(context.id) ?? []).filter((item) => item !== key), key];
    while (keys.length > 2) cache.delete(keys.shift()!);
    versions.set(context.id, keys);
    let completed = [...cache.values()].filter((entry) => entry.done);
    let bytes = completed.reduce((sum, entry) => sum + entry.weight, 0);
    while (completed.length > MAX_CACHE_BLOCKS || bytes > MAX_CACHE_BYTES) {
      const oldest = completed.sort((a, b) => a.used - b.used)[0];
      const found = [...cache].find(([, entry]) => entry === oldest);
      if (!found) break;
      dropCompleted(found[0], oldest); bytes -= oldest.weight; completed = completed.filter((entry) => entry !== oldest);
    }
  };
  // A worker's update replaces only the cached revision it was made for, and only with tokens that spell its exact code.
  const update = (context: HighlightContext, language: string, tokens: Token[]) => {
    const entry = cache.get(cacheKey(context, language));
    if (!entry || tokens.map((token) => token.text).join("") !== entry.code) return;
    entry.tokens = tokens;
    entry.weight = weigh(entry.code, tokens);
    for (const listener of listeners.get(context.id) ?? []) listener();
  };
  const post = (id: number, job: Pending) => {
    watchdog ??= setTimeout(failWorker, WORKER_SILENCE_MS);
    worker!.postMessage({ type: "highlight", requestId: id, code: job.code, language: job.language, context: job.context });
  };
  const stop = () => { clearTimeout(watchdog); watchdog = undefined; worker?.terminate(); worker = undefined; };
  const giveUp = () => {
    stop();
    unavailable = true;
    for (const job of pending.values()) job.resolve(plain(job.code));
    pending.clear();
    if (!disposed) queueMicrotask(() => options.onHighlightUnavailable?.());
  };
  const failWorker = () => {
    stop();
    if (restarted) return giveUp();
    restarted = true;
    restart = setTimeout(() => {
      restart = undefined;
      if (disposed) return;
      if (!startWorker()) return giveUp();
      for (const [id, job] of pending) post(id, job);
    }, RESTART_BACKOFF_MS);
  };
  const startWorker = (): boolean => {
    if (typeof Worker === "undefined" && !options.workerFactory) return false;
    try {
      const next = options.workerFactory?.() ?? new Worker(new URL("./worker.js", import.meta.url), { type: "module" }) as unknown as WorkerLike;
      worker = next;
      next.onmessage = (event) => {
        if (worker !== next || disposed) return;
        if ("update" in event.data) { update(event.data.update, event.data.language, event.data.tokens); return; }
        const job = pending.get(event.data.requestId);
        if (!job) return;
        pending.delete(event.data.requestId);
        clearTimeout(watchdog);
        watchdog = pending.size ? setTimeout(failWorker, WORKER_SILENCE_MS) : undefined;
        // An error for one block (the worker is alive) leaves that block plain.
        job.resolve("tokens" in event.data ? event.data.tokens : plain(job.code));
      };
      next.onerror = () => { if (worker === next) failWorker(); };
      return true;
    } catch { return false; }
  };

  const highlight = ((code: string, lang: string | undefined, context?: HighlightContext) => {
    if (disposed || unavailable) return plain(code);
    const language = normalizeLanguage(lang);
    if (!language) return null;
    if (code.length > MAX_BLOCK || (code.match(/\n/g)?.length ?? 0) + 1 > MAX_LINES) return plain(code);
    const actual = context ?? { id: `finished:${language}:${code}`, version: 0, state: "done" as const };
    const key = cacheKey(actual, language);
    if (actual.version >= (latestVersion.get(actual.id) ?? -Infinity)) {
      latestVersion.set(actual.id, actual.version);
      current.set(actual.id, key);
    }
    const hit = cache.get(key);
    if (hit && hit.code === code) { hit.used = ++clock; return hit.tokens; }
    if (hit) dropCompleted(key, hit);
    const active = inflightCode.get(key) === code ? inflight.get(key) : undefined;
    if (active) return active;
    if (!worker && !restart && !startWorker()) { giveUp(); return plain(code); }
    const result = new Promise<Token[]>((resolve) => {
      const id = ++requestId;
      const job = { resolve, code, language, context: actual };
      pending.set(id, job);
      if (worker) post(id, job); // while a restart waits, the job is posted to the new worker
    });
    const tracked = result.then((tokens): Token[] | Promise<Token[]> => {
      // Only the newest request under a key may fill its cache entry: an older one for other content that lands later
      // must not replace a newer, already-cached result (that would only cost a needless retokenize, never wrong colors).
      const newest = inflight.get(key) === tracked;
      if (newest) { inflight.delete(key); inflightIds.delete(key); inflightCode.delete(key); }
      const currentKey = current.get(actual.id);
      if (!disposed && currentKey === key) {
        if (newest && !unavailable) remember(key, actual, code, tokens); // plain for want of a worker is never cached
        if ([...inflightIds].some(([otherKey, id]) => id === actual.id && otherKey !== key)) latestSettled.set(actual.id, { key, tokens });
        return tokens;
      }
      const settled = latestSettled.get(actual.id);
      if (settled && settled.key === currentKey) {
        if (![...inflightIds.values()].includes(actual.id)) latestSettled.delete(actual.id);
        return settled.tokens;
      }
      return currentKey ? inflight.get(currentKey) ?? cache.get(currentKey)?.tokens ?? plain(code) : plain(code);
    });
    inflight.set(key, tracked);
    inflightIds.set(key, actual.id);
    inflightCode.set(key, code);
    return tracked;
  }) as Highlight;
  highlight.subscribe = (id, listener) => {
    const set = listeners.get(id) ?? new Set();
    listeners.set(id, set.add(listener));
    return () => { set.delete(listener); if (!set.size && listeners.get(id) === set) listeners.delete(id); };
  };
  highlight.dispose = () => {
    disposed = true;
    worker?.postMessage({ type: "dispose" });
    stop();
    clearTimeout(restart);
    for (const job of pending.values()) job.resolve(plain(job.code));
    pending.clear(); cache.clear(); inflight.clear(); inflightCode.clear(); inflightIds.clear(); latestSettled.clear(); versions.clear(); current.clear(); latestVersion.clear(); listeners.clear();
  };
  return highlight;
}
