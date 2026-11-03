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
// counts compiling a pattern the line meets for the first time. A slow attempt that built scanners met new patterns: it
// gets one retry while the line and the document still have time. Otherwise the line is plain, exact text, and the
// document goes on. In a worker runtime, a line left plain while its grammar is still warming is provisional: the block
// is sent again once the grammar is warm (OnUpdate). A line still over the limit with a warm grammar stays plain.
const TOKENIZE_TIME_LIMIT_MS = 10;
const LINE_ATTEMPTS = 2;
const LINE_BUDGET_MS = 25; // all attempts of one line
const DOCUMENT_RETRY_BUDGET_MS = 100; // all retries of one tokenize call
// `provisional`: some finalized line is plain only because its grammar was still cold (see OnUpdate).
type Session = { language: string; version: number; code: string; finalizedLength: number; tokens: Token[]; state?: GrammarState; used: number; bytes: number; provisional: boolean };

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
// message queue after WARM_SLICE_MS, so a new request waits at most one slice plus one pattern.
const WARM_SLICE_MS = 8;
const WARM_SAMPLE = 'x = f("s", 1); // c';
type Provisional = { code: string; language: string; context: HighlightContext };
/** Where a worker runtime sends a block again, colored, once the grammar that left some of its lines plain is warm. */
export type OnUpdate = (context: HighlightContext, language: string, tokens: Token[]) => void;

function grammarPatterns(value: unknown, patterns: Set<string>): Set<string> {
  if (Array.isArray(value)) for (const item of value) grammarPatterns(item, patterns);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && (key === "match" || key === "begin" || key === "end" || key === "while")) patterns.add(item);
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
  private scanners = 0;
  private readonly warming = new Map<string, Promise<void>>();
  private readonly warmed = new Set<string>();
  // The newest provisional revision of each block, until its grammar is warm.
  private readonly provisional = new Map<string, Provisional>();

  /**
   * Only a worker passes `onUpdate`: such a runtime warms each grammar it loads, in slices, and sends a block again when
   * its grammar's warm-up colors lines it had left plain. Without it, nothing is warmed: warm-up compiles regexes, and one
   * compile cannot be split, so it must never run on the page's thread.
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
      // Counts scanners (textmate builds one per rule, and one per resolved dynamic end), so tokenizeLine can tell a
      // slow attempt that compiled from a runaway line.
      const cache = this.cache = new RegexCache();
      const engine = createJavaScriptRegexEngine({ cache });
      const createScanner = engine.createScanner.bind(engine);
      engine.createScanner = (patterns) => { this.scanners++; return createScanner(patterns); };
      this.highlighter = await createHighlighterCore({ engine, langs: [], themes: [semanticTheme] });
      return this.highlighter;
    })();
    return this.enginePromise;
  }

  private async ensureLanguage(language: string): Promise<HighlighterCore> {
    const highlighter = await this.engine();
    const cache = this.cache!;
    let loading = this.languages.get(language);
    if (!loading) {
      loading = (async () => {
        const grammars = await loadLanguage(language);
        await highlighter.loadLanguage(...grammars);
        const patterns = grammarPatterns(grammars, new Set());
        for (const pattern of patterns) cache.grammar.add(pattern);
        // Not awaited: requests are answered while the grammar warms, and their cold lines are provisional.
        if (this.onUpdate) this.warming.set(language, this.warm(language, patterns, highlighter, cache));
      })();
      this.languages.set(language, loading);
      loading.catch(() => this.languages.delete(language)); // a failed load can be retried
    }
    await loading;
    return highlighter;
  }

  private async warm(language: string, patterns: Set<string>, highlighter: HighlighterCore, cache: RegexCache): Promise<void> {
    const epoch = this.epoch;
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
      : { language, version: context.version, code: "", finalizedLength: 0, tokens: [], used: ++this.clock, bytes: 0, provisional: false };
    const completeLength = nextCompleteLength(code, context.state === "done");
    const start = append ? session.finalizedLength : 0;
    const previousCodeLength = session.code.length;
    const prefix = append ? session.tokens : [];
    const prefixTokenCount = prefix.length;
    const state = append ? session.state : undefined;
    const cold = !!this.onUpdate && !this.warmed.has(language);
    let provisional = session.provisional;
    const finish = (suffix: Token[], grammarState: GrammarState | undefined) => {
      const tokens = prefix.length ? [...prefix, ...suffix] : suffix;
      session.language = language;
      session.version = context.version;
      session.code = code;
      session.finalizedLength = completeLength;
      session.tokens = tokens;
      session.state = grammarState;
      session.provisional = provisional;
      session.bytes = append
        ? session.bytes + (code.length - previousCodeLength + completeLength - start) * 2 + (tokens.length - prefixTokenCount) * 32
        : code.length * 2 + tokens.reduce((sum, token) => sum + token.text.length * 2 + 32, 0);
      const current = this.sessions.get(context.id);
      if (epoch === this.epoch && (!current || context.version >= current.version)) {
        this.sessions.set(context.id, session);
        this.evictSessions();
        if (provisional) this.provisional.set(context.id, { code, language, context });
        else this.provisional.delete(context.id);
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
          if (!result) { appendToken(tokens, line); grammarState = undefined; provisional ||= cold; }
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
        if (!result) { appendToken(tokens, line); grammarState = undefined; provisional ||= cold; }
        else { this.appendShiki(tokens, result, line); grammarState = highlighter.getLastGrammarState(result); }
      }
    }
    return finish(tokens, grammarState);
  }

  /** One line's tokens under the tokenize policy (top of file), or undefined: the line is plain. */
  private tokenizeLine(highlighter: HighlighterCore, line: string, language: string, grammarState: GrammarState | undefined, budget: { retryMs: number }): ThemedToken[][] | undefined {
    let spent = 0;
    for (let attempt = 1; ; attempt++) {
      const scanners = this.scanners;
      const started = performance.now();
      const result = highlighter.codeToTokensBase(line, { lang: language, theme: THEME, grammarState, tokenizeMaxLineLength: MAX_LINE, tokenizeTimeLimit: TOKENIZE_TIME_LIMIT_MS });
      const elapsed = performance.now() - started;
      spent += elapsed;
      if (attempt > 1) budget.retryMs -= elapsed;
      if (elapsed < TOKENIZE_TIME_LIMIT_MS) return result;
      const compiled = this.scanners > scanners;
      const hasTime = spent + TOKENIZE_TIME_LIMIT_MS <= LINE_BUDGET_MS && budget.retryMs >= TOKENIZE_TIME_LIMIT_MS;
      if (!compiled || attempt >= LINE_ATTEMPTS || !hasTime) return undefined;
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
