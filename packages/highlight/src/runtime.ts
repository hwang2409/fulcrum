import type { GrammarState, HighlighterCore, LanguageInput, ThemedToken } from "@shikijs/types";
import type { HighlightContext, Token } from "./types.js";
import { loadLanguage } from "./languages.js";
import { appendToken, semanticTheme } from "./scopes.js";

const THEME = "fulcrum-semantic";
const MAX_LINE = 20_000;
const MAX_SESSIONS = 32;
const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_SLICE_MS = 4;
// The tokenize policy, all of it. Shiki stops a line at TOKENIZE_TIME_LIMIT_MS without saying so, and that time also
// counts compiling a pattern the line meets for the first time, and any pause of the thread (a garbage collection, a
// busy machine). A slow attempt gets one retry while the document still has retry time; otherwise the line is
// plain, exact text, and the document goes on. A worker runtime tokenizes only with a warm grammar (see OnUpdate), so
// there a plain line is final: a line that a pause made slow once must get its retry.
const TOKENIZE_TIME_LIMIT_MS = 10;
const LINE_ATTEMPTS = 2; // shiki stops each attempt near TOKENIZE_TIME_LIMIT_MS, so a line costs about 2 x 10 ms
const DOCUMENT_RETRY_BUDGET_MS = 100; // all retries of one tokenize call
type Session = { language: string; version: number; code: string; finalizedLength: number; tokens: Token[]; state?: GrammarState; used: number; bytes: number };

function nextCompleteLength(code: string, done: boolean): number {
  if (done) return code.length;
  const newline = code.lastIndexOf("\n");
  return newline < 0 ? 0 : newline + 1;
}

// Regexes one runtime compiled. A grammar's own patterns (static) stay until dispose: they are bounded by the grammars
// loaded. Patterns textmate builds while it tokenizes (an end that backreferences its begin, such as a markdown fence of
// N backticks) are new per document, so only the MAX_DYNAMIC_REGEXES most recently used of them are kept.
export const MAX_DYNAMIC_REGEXES = 256;
// The map itself holds the dynamic patterns, in least recently used order.
class RegexCache extends Map<string, RegExp | Error> {
  readonly grammar = new Set<string>(); // the patterns the loaded grammars spell
  readonly static = new Map<string, RegExp | Error>();
  override get(pattern: string) {
    const known = this.static.get(pattern);
    if (known) return known;
    const recent = super.get(pattern);
    if (recent) { super.delete(pattern); super.set(pattern, recent); }
    return recent;
  }
  override set(pattern: string, regex: RegExp | Error) {
    if (this.grammar.has(pattern)) this.static.set(pattern, regex);
    else {
      super.set(pattern, regex);
      if (super.size > MAX_DYNAMIC_REGEXES) super.delete(super.keys().next().value!);
    }
    return this;
  }
  override clear() { super.clear(); this.static.clear(); this.grammar.clear(); }
}

// Warm-up compiles a grammar's patterns in the worker, so the page's thread never runs it. It yields to the worker's
// message queue after WARM_SLICE_MS, so a new request waits at most one slice plus one pattern (in Chromium the most
// costly bundled pattern, in cpp, converts and compiles in about 21 ms).
const WARM_SLICE_MS = 8;
const WARM_SAMPLE = 'x = f("s", 1); // c';
type Provisional = { code: string; language: string; context: HighlightContext };
/**
 * Where a worker runtime sends a block again, colored, once its grammar is warm. Until then a block is answered at once
 * with its exact plain text: tokenizing with a cold grammar builds each rule's scanner, which compiles all of that rule's
 * patterns in one call that cannot yield (a cold cpp document blocked the worker 335 ms in Chromium).
 */
export type OnUpdate = (context: HighlightContext, language: string, tokens: Token[]) => void;

// The sources textmate compiles for one grammar pattern (vscode-textmate's RegExpSource, pinned with shiki): `\z`
// rewritten, and for `\A` or `\G` the variant for each of "A allowed" and "G allowed", the disallowed one as \uFFFF.
function textmateSources(pattern: string): string[] {
  let source = "";
  let anchored = false;
  for (let index = 0; index < pattern.length; index++) {
    const next = pattern[index + 1];
    if (pattern[index] !== "\\" || next === undefined) { source += pattern[index]; continue; }
    source += next === "z" ? "$(?!\\n)(?<!\\n)" : `\\${next}`;
    anchored ||= next === "A" || next === "G";
    index++;
  }
  if (!anchored) return [source];
  const variant = (allowA: boolean, allowG: boolean) => source.replace(/\\([\s\S])/g, (escape, next: string) =>
    (next === "A" && !allowA) || (next === "G" && !allowG) ? "\\\uFFFF" : escape);
  return [variant(true, true), variant(true, false), variant(false, true), variant(false, false)];
}

function grammarPatterns(value: unknown, patterns: Set<string>): Set<string> {
  if (Array.isArray(value)) for (const item of value) grammarPatterns(item, patterns);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && (key === "match" || key === "begin" || key === "end" || key === "while")) for (const source of textmateSources(item)) patterns.add(source);
      else grammarPatterns(item, patterns);
    }
  }
  return patterns;
}

function sourceLines(source: string): string[] {
  const lines = source.match(/.*(?:\n|$)/g)?.filter(Boolean) ?? [];
  return lines;
}

export class TokenizerRuntime {
  private highlighter?: HighlighterCore;
  private cache?: RegexCache;
  private readonly sessions = new Map<string, Session>();
  private readonly retired = new Set<HighlighterCore>();
  private clock = 0;
  private epoch = 0;
  private activeJobs = 0;
  private readonly warming = new Map<string, Promise<void>>();
  // Grammars warm one at a time, in the order they were first asked for: the first grammar asked for is colored first,
  // and a request waits behind one slice, not one slice per grammar warming at once.
  private warmQueue = Promise.resolve();
  private readonly warmed = new Set<string>();
  // The newest revision of each block asked for while its grammar was cold, until that grammar is warm.
  private readonly provisional = new Map<string, Provisional>();

  /**
   * Only a worker passes `onUpdate`: such a runtime warms each grammar it loads, in slices, answers blocks for a cold
   * grammar with plain text, and sends each such block again, colored, once warm. Without it, nothing is warmed: warm-up
   * compiles regexes, and one compile cannot be split, so it must never run on the page's thread.
   */
  constructor(private readonly onUpdate?: OnUpdate) {}

  // Shared promises: concurrent first requests must wait for the one engine and the one grammar load, not race to
  // create their own (each racer would load its grammar into a different engine).
  private enginePromise?: Promise<HighlighterCore>;
  private readonly languages = new Map<string, Promise<void>>();

  private engine(): Promise<HighlighterCore> {
    this.enginePromise ??= (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
        import("shiki/core"), import("@shikijs/engine-javascript"),
      ]);
      const cache = this.cache = new RegexCache();
      const engine = createJavaScriptRegexEngine({ cache });
      this.highlighter = await createHighlighterCore({ engine, langs: [], themes: [semanticTheme] });
      return this.highlighter;
    })();
    return this.enginePromise;
  }

  private async ensureLanguage(language: string): Promise<HighlighterCore> {
    const highlighter = await this.engine();
    const cache = this.cache!;
    const epoch = this.epoch;
    let loading = this.languages.get(language);
    if (!loading) {
      loading = (async () => {
        const grammars = await loadLanguage(language);
        await highlighter.loadLanguage(...grammars);
        const patterns = grammarPatterns(grammars, new Set());
        for (const pattern of patterns) cache.grammar.add(pattern);
        // Not awaited: requests are answered while the grammar warms, with plain text until it is warm.
        if (this.onUpdate) this.warming.set(language, this.warmQueue = this.warmQueue.then(() => this.warm(language, patterns, highlighter, cache, epoch)).catch(() => {}));
      })();
      this.languages.set(language, loading);
      loading.catch(() => this.languages.delete(language)); // a failed load can be retried
    }
    await loading;
    return highlighter;
  }

  // `epoch` is the one the grammar was loaded in: a warm-up queued before dispose must not run after it.
  private async warm(language: string, patterns: Set<string>, highlighter: HighlighterCore, cache: RegexCache, epoch: number): Promise<void> {
    const { defaultJavaScriptRegexConstructor } = await import("@shikijs/engine-javascript");
    let sliceStart = performance.now();
    for (const pattern of patterns) {
      if (epoch !== this.epoch) return;
      if (!cache.static.has(pattern)) {
        // The engine caches a failed compile the same way and throws it at use.
        try {
          const regex = defaultJavaScriptRegexConstructor(pattern, { target: "auto" });
          regex.exec(""); // a long pattern's RegExp compiles at its first use
          regex.lastIndex = 0;
          cache.set(pattern, regex);
        } catch (cause) { cache.set(pattern, cause instanceof Error ? cause : new Error(String(cause))); }
      }
      if (performance.now() - sliceStart >= WARM_SLICE_MS) { await nextTask(); sliceStart = performance.now(); }
    }
    if (epoch !== this.epoch) return;
    // The first line through a grammar also builds its rules and runs the regex jit once; a sample does it here.
    highlighter.codeToTokensBase(WARM_SAMPLE, { lang: language, theme: THEME });
    this.warmed.add(language);
    for (const [id, block] of this.provisional) {
      if (block.language !== language) continue;
      this.provisional.delete(id);
      const tokens = await this.tokenize(block.code, language, block.context, false);
      if (epoch !== this.epoch) return;
      this.onUpdate!(block.context, language, tokens);
      await nextTask();
    }
  }

  /** Whether this runtime will send `context`'s block again (OnUpdate) once its grammar is warm. */
  willUpdate(context: HighlightContext): boolean {
    return this.provisional.get(context.id)?.context.version === context.version;
  }

  /** Entries in the regex cache: a loaded grammar's own patterns, and patterns built while tokenizing (at most MAX_DYNAMIC_REGEXES). */
  cacheSize(): { static: number; dynamic: number } {
    return { static: this.cache?.static.size ?? 0, dynamic: this.cache?.size ?? 0 };
  }

  async tokenize(code: string, language: string, context: HighlightContext, cooperative = true): Promise<Token[]> {
    const highlighter = await this.ensureLanguage(language);
    const known = this.provisional.get(context.id);
    const newest = !known || known.context.version <= context.version;
    if (this.onUpdate && !this.warmed.has(language)) {
      if (newest) this.provisional.set(context.id, { code, language, context });
      return code ? [{ text: code }] : [];
    }
    if (newest) this.provisional.delete(context.id); // this revision replaces the plain one

    const epoch = this.epoch;
    this.activeJobs++;
    try {
      return await this.tokenizeLoaded(code, language, context, cooperative, highlighter, epoch);
    } finally {
      this.activeJobs--;
      if (this.activeJobs === 0) {
        for (const retired of this.retired) retired.dispose();
        this.retired.clear();
      }
    }
  }

  private tokenizeLoaded(code: string, language: string, context: HighlightContext, cooperative: boolean, highlighter: HighlighterCore, epoch: number): Token[] | Promise<Token[]> {
    const previous = this.sessions.get(context.id);
    const append = previous?.language === language && context.version > previous.version && code.startsWith(previous.code);
    const session: Session = append
      ? { ...previous, used: ++this.clock }
      : { language, version: context.version, code: "", finalizedLength: 0, tokens: [], used: ++this.clock, bytes: 0 };
    const completeLength = nextCompleteLength(code, context.state === "done");
    const start = append ? session.finalizedLength : 0;
    const previousCodeLength = session.code.length;
    const prefix = append ? session.tokens : [];
    const prefixTokenCount = prefix.length;
    const state = append ? session.state : undefined;
    const finish = (suffix: Token[], grammarState: GrammarState | undefined) => {
      const tokens = prefix.length ? [...prefix, ...suffix] : suffix;
      session.language = language;
      session.version = context.version;
      session.code = code;
      session.finalizedLength = completeLength;
      session.tokens = tokens;
      session.state = grammarState;
      session.bytes = append
        ? session.bytes + (code.length - previousCodeLength + completeLength - start) * 2 + (tokens.length - prefixTokenCount) * 32
        : code.length * 2 + tokens.reduce((sum, token) => sum + token.text.length * 2 + 32, 0);
      const current = this.sessions.get(context.id);
      if (epoch === this.epoch && (!current || context.version >= current.version)) {
        this.sessions.set(context.id, session);
        this.evictSessions();
      }
      if (completeLength === code.length) return tokens;
      // The tail may merge into the last token, so that token is copied: the session keeps only finalized text.
      const output = [...tokens];
      if (output.length) output[output.length - 1] = { ...output.at(-1)! };
      appendToken(output, code.slice(completeLength));
      return output;
    };
    const budget = { retryMs: DOCUMENT_RETRY_BUDGET_MS };
    const work = async () => {
      const tokens: Token[] = [];
      let grammarState = state;
      let yieldStart = performance.now();
      for (const line of sourceLines(code.slice(start, completeLength))) {
        if (line.replace(/\n$/, "").length > MAX_LINE) {
          appendToken(tokens, line);
          grammarState = undefined;
        } else {
          const result = this.tokenizeLine(highlighter, line, language, grammarState, budget);
          if (!result) { appendToken(tokens, line); grammarState = undefined; }
          else { this.appendShiki(tokens, result, line); grammarState = highlighter.getLastGrammarState(result); }
        }
        if (cooperative && performance.now() - yieldStart >= MAX_SLICE_MS) {
          await yieldTask();
          yieldStart = performance.now();
        }
      }
      return finish(tokens, grammarState);
    };
    if (cooperative) return work();
    const tokens: Token[] = [];
    let grammarState = state;
    for (const line of sourceLines(code.slice(start, completeLength))) {
      if (line.replace(/\n$/, "").length > MAX_LINE) { appendToken(tokens, line); grammarState = undefined; }
      else {
        const result = this.tokenizeLine(highlighter, line, language, grammarState, budget);
        if (!result) { appendToken(tokens, line); grammarState = undefined; }
        else { this.appendShiki(tokens, result, line); grammarState = highlighter.getLastGrammarState(result); }
      }
    }
    return finish(tokens, grammarState);
  }

  /** One line's tokens under the tokenize policy (top of file), or undefined: the line is plain. */
  private tokenizeLine(highlighter: HighlighterCore, line: string, language: string, grammarState: GrammarState | undefined, budget: { retryMs: number }): ThemedToken[][] | undefined {
    for (let attempt = 1; ; attempt++) {
      const started = performance.now();
      const result = highlighter.codeToTokensBase(line, { lang: language, theme: THEME, grammarState, tokenizeMaxLineLength: MAX_LINE, tokenizeTimeLimit: TOKENIZE_TIME_LIMIT_MS });
      const elapsed = performance.now() - started;
      if (attempt > 1) budget.retryMs -= elapsed;
      if (elapsed < TOKENIZE_TIME_LIMIT_MS) return result;
      // No per-line time budget: a pause can make the first attempt long, and it must not cost the line its retry.
      if (attempt >= LINE_ATTEMPTS || budget.retryMs < TOKENIZE_TIME_LIMIT_MS) return undefined;
    }
  }

  private appendShiki(output: Token[], lines: ThemedToken[][], source: string): void {
    let consumed = 0;
    for (let index = 0; index < lines.length; index++) {
      for (const token of lines[index]) { appendToken(output, token.content, token.color); consumed += token.content.length; }
      if (index < lines.length - 1 && source[consumed] === "\n") { appendToken(output, "\n"); consumed++; }
    }
    if (consumed < source.length) appendToken(output, source.slice(consumed));
  }

  private evictSessions(): void {
    let bytes = [...this.sessions.values()].reduce((sum, session) => sum + session.bytes, 0);
    while (this.sessions.size > MAX_SESSIONS || bytes > MAX_SESSION_BYTES) {
      const oldest = [...this.sessions].sort((a, b) => a[1].used - b[1].used)[0];
      if (!oldest) break;
      bytes -= oldest[1].bytes;
      this.sessions.delete(oldest[0]);
    }
  }

  dispose(): void {
    this.epoch++;
    this.sessions.clear();
    if (this.highlighter) {
      if (this.activeJobs) this.retired.add(this.highlighter);
      else this.highlighter.dispose();
    }
    this.highlighter = undefined;
    this.enginePromise = undefined;
    this.languages.clear();
    this.cache?.clear();
    this.cache = undefined;
    this.warming.clear();
    this.warmed.clear();
    this.provisional.clear();
  }
}

// A plain task, behind any message already queued: scheduler.yield would run first, ahead of the worker's requests.
function nextTask(): Promise<void> {
  if (typeof MessageChannel === "undefined") return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
    channel.port2.postMessage(undefined);
  });
}

async function yieldTask(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  return scheduler?.yield ? scheduler.yield() : nextTask();
}
