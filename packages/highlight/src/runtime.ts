import type { GrammarState, HighlighterCore, LanguageInput, ThemedToken } from "@shikijs/types";
import type { HighlightContext, Token } from "./types.js";
import type { GrammarProvenance } from "./protocol.js";
import { loadLanguage, loadRegexRecipes } from "./languages.js";
import { normalizeLanguage } from "./names.js";
import { appendToken, semanticTheme } from "./scopes.js";
import { EmulatedRegExp } from "oniguruma-to-es";
import { grammarPatterns, REGEX_TARGET, type RegexRecipe, type RegexRecipes } from "./regex.js";

const THEME = "fulcrum-semantic";
const MAX_SESSIONS = 32;
const MAX_SESSION_BYTES = 8 * 1024 * 1024;
// tokenization budgets may schedule work, but never choose the final token semantics. the worker watchdog handles a
// truly pathological scanner; a slow machine must keep trying until the pinned grammar returns its full result.
type Session = { language: string; version: number; code: string; finalizedLength: number; tokens: Token[]; state?: GrammarState; used: number; bytes: number };

export function regexFromRecipe([source, flags, options]: RegexRecipe): RegExp {
  return options ? new EmulatedRegExp(source, flags, options) : new RegExp(source, flags);
}

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

// The runtime runs only in the highlight worker: the page's thread never tokenizes (see controller.ts). Warm-up yields to the worker's
// message queue after WARM_SLICE_MS, so a new request waits at most one slice plus one pattern (in Chromium the most
// costly bundled pattern, in cpp, converts and compiles in about 21 ms).
const WARM_SLICE_MS = 8;
const WARM_SAMPLE = 'x = f("s", 1); // c';
type Provisional = { code: string; context: HighlightContext; provenance: GrammarProvenance; dependencies: string[] };
export type TokenizeResult = { tokens: Token[]; provenance: GrammarProvenance };
/**
 * Where the runtime sends a block again, colored, once its grammar is warm. Until then a block is answered at once
 * with its exact plain text: tokenizing with a cold grammar builds each rule's scanner, which compiles all of that rule's
 * patterns in one call that cannot yield (a cold cpp document blocked the worker 335 ms in Chromium).
 */
export type OnUpdate = (context: HighlightContext, provenance: GrammarProvenance, tokens: Token[]) => void;
/** Called as work goes on: with the block being tokenized (at its start and after each line), or null while a grammar compiles. */
export type OnProgress = (context: HighlightContext | null) => void;

function sourceLines(source: string): string[] {
  const lines = source.match(/.*(?:\n|$)/g)?.filter(Boolean) ?? [];
  return lines;
}

// Markdown can reach dozens of grammars, so load only supported languages named after a possible fence marker.
// This is deliberately conservative: an extra load is safe, but missing a nested fence would make `complete` false.
function embeddedLanguages(code: string, language: string): string[] {
  if (language !== "markdown") return [];
  const dependencies = new Set<string>();
  for (const match of code.matchAll(/(?:`{3,}|~{3,})[ \t]*([^\s`~]+)/g)) {
    const dependency = normalizeLanguage(match[1]);
    if (dependency && dependency !== language) dependencies.add(dependency);
  }
  return [...dependencies];
}

export class TokenizerRuntime {
  private highlighter?: HighlighterCore;
  private cache?: RegexCache;
  private readonly recipes = new Map<string, RegexRecipes[string]>();
  private readonly sessions = new Map<string, Session>();
  private clock = 0;
  private epoch = 0;
  private readonly warming = new Map<string, Promise<void>>();
  // Grammars warm one at a time, in the order they were first asked for: the first grammar asked for is colored first,
  // and a request waits behind one slice, not one slice per grammar warming at once.
  private warmQueue = Promise.resolve();
  private readonly warmed = new Set<string>();
  // The newest revision of each block asked for while its grammar was cold, until that grammar is warm.
  private readonly provisional = new Map<string, Provisional>();

  /**
   * The runtime warms each grammar it loads, in slices, answers blocks for a cold grammar with plain text, and sends
   * each such block again, colored, through `onUpdate` once warm. `onProgress` lets a watchdog tell slow work from a hang.
   */
  constructor(private readonly onUpdate: OnUpdate, private readonly onProgress: OnProgress = () => {}) {}

  // Shared promises: concurrent first requests must wait for the one engine and the one grammar load, not race to
  // create their own (each racer would load its grammar into a different engine).
  private enginePromise?: Promise<HighlighterCore>;
  private readonly languages = new Map<string, Promise<void>>();

  private engine(): Promise<HighlighterCore> {
    this.enginePromise ??= (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine, defaultJavaScriptRegexConstructor }] = await Promise.all([
        import("shiki/core"), import("@shikijs/engine-javascript"),
      ]);
      const cache = this.cache = new RegexCache();
      const engine = createJavaScriptRegexEngine({
        cache,
        target: REGEX_TARGET,
        regexConstructor: (pattern) => {
          const recipe = this.recipes.get(pattern);
          return recipe ? regexFromRecipe(recipe) : defaultJavaScriptRegexConstructor(pattern, { target: REGEX_TARGET });
        },
      });
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
        const [grammars, recipes] = await Promise.all([loadLanguage(language), loadRegexRecipes(language)]);
        for (const [pattern, recipe] of Object.entries(recipes)) this.recipes.set(pattern, recipe);
        await highlighter.loadLanguage(...grammars);
        const patterns = grammarPatterns(grammars);
        for (const pattern of patterns) cache.grammar.add(pattern);
        // Not awaited: requests are answered while the grammar warms, with plain text until it is warm.
        const grammarLanguages = grammars.flatMap((grammar) => {
          const name = (grammar as { name?: unknown }).name;
          return typeof name === "string" ? [name] : [];
        });
        this.warming.set(language, this.warmQueue = this.warmQueue.then(() => this.warm(language, grammarLanguages, patterns, highlighter, cache, epoch)).catch(() => {}));
      })();
      this.languages.set(language, loading);
      loading.catch(() => this.languages.delete(language)); // a failed load can be retried
    }
    await loading;
    return highlighter;
  }

  // `epoch` is the one the grammar was loaded in: a warm-up queued before dispose must not run after it.
  private async warm(language: string, grammarLanguages: string[], patterns: Set<string>, highlighter: HighlighterCore, cache: RegexCache, epoch: number): Promise<void> {
    await this.compile(patterns, cache, epoch);
    if (epoch !== this.epoch) return;
    // A language chunk can contain embedded grammars. Prime each real scanner so final tokens do not depend on load order.
    for (const grammarLanguage of new Set(grammarLanguages))
      highlighter.codeToTokensBase(WARM_SAMPLE, { lang: grammarLanguage, theme: THEME });
    this.warmed.add(language);
    await this.flushProvisional(language, epoch);
  }

  // Compiles and warms each grammar pattern not yet cached, yielding to the worker's queue after each WARM_SLICE_MS.
  // Warming matters for correctness, not only latency. Observed under CPU load: when a plain `v`-flag RegExp (the recipe
  // path) reached Shiki's scanner cold, its first exec produced a missed match. The scanner caches each regex's first
  // search per line and reuses that "no match" for the rest of the line, so one cold miss drops a token for the whole
  // line (e.g. TypeScript `(:)(?=\s*\S)` missed at `id:`, merging `id: number };` into one token). Running one exec per
  // pattern here, before any real block reaches a scanner, removes that cold first exec and the miss with it: on
  // identical code the lazy path fails 5/14 under load while this warm path passes 22/22.
  // This is observed scanner behavior, not a confirmed engine bug. A standalone wrong exec did not reproduce (Bun:
  // millions of execs within one process and 1500 fresh processes; WebKit JSC: 9.15M cold contexts; all 0 wrong); the
  // miss appears only through the full scanner harness under load.
  private async compile(patterns: Set<string>, cache: RegexCache, epoch: number): Promise<void> {
    const { defaultJavaScriptRegexConstructor } = await import("@shikijs/engine-javascript");
    let sliceStart = performance.now();
    for (const pattern of patterns) {
      if (epoch !== this.epoch) return;
      this.onProgress(null);
      if (!cache.static.has(pattern)) {
        // The engine caches a failed compile the same way and throws it at use.
        try {
          const recipe = this.recipes.get(pattern);
          const regex = recipe ? regexFromRecipe(recipe) : defaultJavaScriptRegexConstructor(pattern, { target: REGEX_TARGET });
          regex.exec(""); // burn the cold first exec; the scanner only ever sees the warmed regex
          regex.lastIndex = 0;
          cache.set(pattern, regex);
        } catch (cause) { cache.set(pattern, cause instanceof Error ? cause : new Error(String(cause))); }
      }
      if (performance.now() - sliceStart >= WARM_SLICE_MS) { await nextTask(); sliceStart = performance.now(); }
    }
  }

  // Sends each block answered plain while `language` was cold again, colored, one per task.
  private async flushProvisional(language: string, epoch: number): Promise<void> {
    for (const [id, block] of [...this.provisional]) {
      if (block.provenance.language !== language && !block.dependencies.includes(language)) continue;
      this.provisional.delete(id);
      const result = await this.tokenizeWithProvenance(block.code, block.context, block.provenance.language, block.provenance.generation);
      if (epoch !== this.epoch) return;
      this.onUpdate(block.context, result.provenance, result.tokens);
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

  async tokenize(code: string, language: string, context: HighlightContext): Promise<Token[]> {
    return (await this.tokenizeWithProvenance(code, context, language, 0)).tokens;
  }

  async tokenizeWithProvenance(code: string, context: HighlightContext, language: string, generation: number): Promise<TokenizeResult> {
    const epoch = this.epoch;
    const dependencies = embeddedLanguages(code, language);
    const highlighterLoading = this.ensureLanguage(language);
    const dependencyLoading = dependencies.map((dependency) => this.ensureLanguage(dependency));
    const highlighter = await highlighterLoading;
    if (dependencyLoading.length) await Promise.all(dependencyLoading);
    const fullyLoaded = this.warmed.has(language) && dependencies.every((dependency) => this.warmed.has(dependency));
    const provenance = { language, generation, fullyLoaded };
    if (epoch !== this.epoch) return { tokens: code ? [{ text: code }] : [], provenance: { ...provenance, fullyLoaded: false } };
    const known = this.provisional.get(context.id);
    const newest = !known || known.context.version <= context.version;
    if (!fullyLoaded) {
      if (newest) this.provisional.set(context.id, { code, context, provenance, dependencies });
      return { tokens: code ? [{ text: code }] : [], provenance };
    }
    if (newest) this.provisional.delete(context.id); // this revision replaces the plain one
    return { tokens: this.tokenizeLoaded(code, language, context, highlighter, epoch), provenance };
  }

  private tokenizeLoaded(code: string, language: string, context: HighlightContext, highlighter: HighlighterCore, epoch: number): Token[] {
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
    const tokens: Token[] = [];
    let grammarState = state;
    this.onProgress(context);
    for (const line of sourceLines(code.slice(start, completeLength))) {
      {
        const result = this.tokenizeLine(highlighter, line, language, grammarState);
        this.appendShiki(tokens, result, line); grammarState = highlighter.getLastGrammarState(result);
      }
      this.onProgress(context);
    }
    return finish(tokens, grammarState);
  }

  /** A slow attempt is retried. Plain text is provisional only; it is never a terminal result. */
  private tokenizeLine(highlighter: HighlighterCore, line: string, language: string, grammarState: GrammarState | undefined): ThemedToken[][] {
    return highlighter.codeToTokensBase(line, { lang: language, theme: THEME, grammarState });
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
    this.highlighter?.dispose();
    this.highlighter = undefined;
    this.enginePromise = undefined;
    this.languages.clear();
    this.cache?.clear();
    this.cache = undefined;
    this.recipes.clear();
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
