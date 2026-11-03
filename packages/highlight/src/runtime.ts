import type { GrammarState, HighlighterCore, ThemedToken } from "@shikijs/types";
import type { HighlightContext, Token } from "./types.js";
import { loadLanguage } from "./languages.js";
import { appendToken, semanticTheme } from "./scopes.js";

const THEME = "fulcrum-semantic";
const MAX_LINE = 20_000;
const MAX_SESSIONS = 32;
const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_SLICE_MS = 4;
const TOKENIZE_TIME_LIMIT_MS = 10;
type Session = { language: string; version: number; code: string; finalizedLength: number; tokens: Token[]; state?: GrammarState; used: number; bytes: number };

function nextCompleteLength(code: string, done: boolean): number {
  if (done) return code.length;
  const newline = code.lastIndexOf("\n");
  return newline < 0 ? 0 : newline + 1;
}

function sourceLines(source: string): string[] {
  const lines = source.match(/.*(?:\n|$)/g)?.filter(Boolean) ?? [];
  return lines;
}

export class TokenizerRuntime {
  private highlighter?: HighlighterCore;
  private readonly sessions = new Map<string, Session>();
  private readonly retired = new Set<HighlighterCore>();
  private clock = 0;
  private epoch = 0;
  private activeJobs = 0;
  private scanners = 0;

  // Shared promises: concurrent first requests must wait for the one engine and the one grammar load, not race to
  // create their own (each racer would load its grammar into a different engine).
  private enginePromise?: Promise<HighlighterCore>;
  private readonly languages = new Map<string, Promise<void>>();

  private engine(): Promise<HighlighterCore> {
    this.enginePromise ??= (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
        import("shiki/core"), import("@shikijs/engine-javascript"),
      ]);
      // Counts scanners (textmate builds one per rule, once, and compiles its patterns then), so tokenizeLine can tell
      // a cold grammar's one-time setup from a runaway line.
      const engine = createJavaScriptRegexEngine();
      const createScanner = engine.createScanner.bind(engine);
      engine.createScanner = (patterns) => { this.scanners++; return createScanner(patterns); };
      this.highlighter = await createHighlighterCore({ engine, langs: [], themes: [semanticTheme] });
      return this.highlighter;
    })();
    return this.enginePromise;
  }

  private async ensureLanguage(language: string): Promise<HighlighterCore> {
    const highlighter = await this.engine();
    let loading = this.languages.get(language);
    if (!loading) {
      loading = (async () => highlighter.loadLanguage(...await loadLanguage(language)))();
      this.languages.set(language, loading);
      loading.catch(() => this.languages.delete(language)); // a failed load can be retried
    }
    await loading;
    return highlighter;
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
    const work = async () => {
      const tokens: Token[] = [];
      let grammarState = state;
      let yieldStart = performance.now();
      for (const line of sourceLines(code.slice(start, completeLength))) {
        if (line.replace(/\n$/, "").length > MAX_LINE) {
          appendToken(tokens, line);
          grammarState = undefined;
        } else {
          const result = this.tokenizeLine(highlighter, line, language, grammarState);
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
        const result = this.tokenizeLine(highlighter, line, language, grammarState);
        if (!result) { appendToken(tokens, line); grammarState = undefined; }
        else { this.appendShiki(tokens, result, line); grammarState = highlighter.getLastGrammarState(result); }
      }
    }
    return finish(tokens, grammarState);
  }

  /**
   * One line's tokens, or undefined for a runaway line (one that stays over the time limit). Shiki stops a line at the
   * limit without saying so, and the limit also counts building the scanners a cold grammar meets for the first time,
   * so a slow attempt that built new scanners is tried again: each rule's scanner is built once, so this ends.
   */
  private tokenizeLine(highlighter: HighlighterCore, line: string, language: string, grammarState: GrammarState | undefined): ThemedToken[][] | undefined {
    for (;;) {
      const scanners = this.scanners;
      const started = performance.now();
      const result = highlighter.codeToTokensBase(line, { lang: language, theme: THEME, grammarState, tokenizeMaxLineLength: MAX_LINE, tokenizeTimeLimit: TOKENIZE_TIME_LIMIT_MS });
      if (performance.now() - started < TOKENIZE_TIME_LIMIT_MS) return result;
      if (this.scanners === scanners) return undefined;
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
  }
}

async function yieldTask(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  if (typeof MessageChannel === "undefined") return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
    channel.port2.postMessage(undefined);
  });
}
