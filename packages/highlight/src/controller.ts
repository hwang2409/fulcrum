import { normalizeLanguage } from "./languages.js";
import type { Highlight, HighlightContext, Token } from "./types.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";

const MAX_BLOCK = 512 * 1024;
const MAX_LINES = 10_000;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BLOCKS = 64;
const SYNC_BYTES = 4 * 1024;
const SYNC_LINES = 40;
type WorkerLike = { postMessage(value: WorkerRequest): void; terminate(): void; onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null; onerror: ((event: ErrorEvent) => unknown) | null };
export type HighlighterOptions = { worker?: false; workerFactory?: () => WorkerLike };
type Pending = { resolve: (tokens: Token[]) => void; timer: ReturnType<typeof setTimeout>; code: string; language: string; context: HighlightContext };
type CacheEntry = { tokens: Token[]; weight: number; used: number; done: boolean; id: string };

export function createController(options: HighlighterOptions = {}): Highlight {
  let worker: WorkerLike | undefined;
  let runtime: import("./runtime.js").TokenizerRuntime | undefined;
  let requestId = 0;
  let failures = 0;
  let disposed = false;
  let clock = 0;
  const pending = new Map<number, Pending>();
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<Token[]>>();
  const versions = new Map<string, string[]>();
  const current = new Map<string, string>();
  const latestVersion = new Map<string, number>();

  const plain = (code: string): Token[] => code ? [{ text: code }] : [];
  const cacheKey = (context: HighlightContext, language: string) => `${context.id}\0${context.version}\0${language}`;
  const dropCompleted = (key: string, entry: CacheEntry) => {
    cache.delete(key);
    const keys = versions.get(entry.id)?.filter((item) => item !== key) ?? [];
    if (keys.length) versions.set(entry.id, keys);
    else versions.delete(entry.id);
    if (current.get(entry.id) === key) { current.delete(entry.id); latestVersion.delete(entry.id); }
  };
  const remember = (key: string, context: HighlightContext, code: string, tokens: Token[]) => {
    const weight = code.length * 2 + tokens.reduce((sum, token) => sum + token.text.length * 2 + 32, 0);
    cache.set(key, { tokens, weight, used: ++clock, done: context.state === "done", id: context.id });
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
  const fallback = async (code: string, language: string, context: HighlightContext) => {
    const { TokenizerRuntime } = await import("./runtime.js");
    runtime ??= new TokenizerRuntime();
    return runtime.tokenize(code, language, context, true);
  };
  const failWorker = () => {
    failures++;
    worker?.terminate(); worker = undefined;
    for (const [id, job] of pending) {
      clearTimeout(job.timer); pending.delete(id);
      void fallback(job.code, job.language, job.context).then(job.resolve, () => job.resolve(plain(job.code)));
    }
  };
  const getWorker = (): WorkerLike | undefined => {
    if (options.worker === false || failures >= 2 || typeof Worker === "undefined" && !options.workerFactory) return undefined;
    if (worker) return worker;
    try {
      const next = options.workerFactory?.() ?? new Worker(new URL("./worker.js", import.meta.url), { type: "module" }) as unknown as WorkerLike;
      worker = next;
      next.onmessage = (event) => {
        const job = pending.get(event.data.requestId);
        if (!job) return;
        clearTimeout(job.timer); pending.delete(event.data.requestId);
        if ("tokens" in event.data) job.resolve(event.data.tokens);
        else void fallback(job.code, job.language, job.context).then(job.resolve, () => job.resolve(plain(job.code)));
      };
      next.onerror = failWorker;
      return next;
    } catch { failures++; return undefined; }
  };

  const highlight = ((code: string, lang: string | undefined, context?: HighlightContext) => {
    if (disposed) return plain(code);
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
    if (hit) { hit.used = ++clock; return hit.tokens; }
    const active = inflight.get(key);
    if (active) return active;
    if (actual.state === "done" && code.length <= SYNC_BYTES && (code.match(/\n/g)?.length ?? 0) <= SYNC_LINES && runtime?.canTokenizeSync(language)) {
      const tokens = runtime.tokenizeSync(code, language, actual); remember(key, actual, code, tokens); return tokens;
    }
    const target = getWorker();
    const result = target ? new Promise<Token[]>((resolve) => {
      const id = ++requestId;
      const timer = setTimeout(() => { pending.delete(id); failWorker(); resolve(plain(code)); }, 2_000);
      pending.set(id, { resolve, timer, code, language, context: actual });
      target.postMessage({ type: "highlight", requestId: id, code, language, context: actual });
    }) : fallback(code, language, actual);
    const tracked = result.then((tokens) => {
      inflight.delete(key);
      if (!disposed && current.get(actual.id) === key) remember(key, actual, code, tokens);
      return tokens;
    });
    inflight.set(key, tracked);
    return tracked;
  }) as Highlight;
  highlight.dispose = () => {
    disposed = true;
    if (worker) { worker.postMessage({ type: "dispose" }); worker.terminate(); }
    for (const job of pending.values()) { clearTimeout(job.timer); job.resolve(plain(job.code)); }
    pending.clear(); cache.clear(); inflight.clear(); versions.clear(); current.clear(); latestVersion.clear(); runtime?.dispose();
  };
  return highlight;
}
