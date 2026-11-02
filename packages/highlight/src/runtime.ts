import type { GrammarState, HighlighterCore, ThemedToken } from "@shikijs/types";
import type { HighlightContext, Token } from "./types.js";
import { loadLanguage } from "./languages.js";
import { appendToken, semanticTheme } from "./scopes.js";

const THEME = "fulcrum-semantic";
const MAX_LINE = 20_000;
const MAX_SESSIONS = 32;
const MAX_SESSION_BYTES = 8 * 1024 * 1024;
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
  private readonly loaded = new Set<string>();
  private readonly warmed = new Set<string>();
  private readonly sessions = new Map<string, Session>();
  private clock = 0;

  private async engine(): Promise<HighlighterCore> {
    if (!this.highlighter) {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
        import("shiki/core"), import("@shikijs/engine-javascript"),
      ]);
      this.highlighter = await createHighlighterCore({ engine: createJavaScriptRegexEngine(), langs: [], themes: [semanticTheme] });
    }
    return this.highlighter;
  }

  private async ensureLanguage(language: string): Promise<HighlighterCore> {
    const highlighter = await this.engine();
    if (!this.loaded.has(language)) {
      await highlighter.loadLanguage(...await loadLanguage(language));
      this.loaded.add(language);
    }
    return highlighter;
  }

  canTokenizeSync(language: string): boolean { return Boolean(this.highlighter && this.loaded.has(language)); }

  tokenizeSync(code: string, language: string, context: HighlightContext): Token[] {
    return this.tokenizeLoaded(code, language, context, false) as Token[];
  }

  async tokenize(code: string, language: string, context: HighlightContext, cooperative = true): Promise<Token[]> {
    await this.ensureLanguage(language);
    // The JavaScript engine compiles regular expressions lazily. Warm small first inputs so
    // the 10 ms per-line safety limit measures matching, not one-time compilation.
    if (!this.warmed.has(language) && code.length <= 4 * 1024) {
      this.highlighter!.codeToTokensBase(code, { lang: language, theme: THEME, tokenizeTimeLimit: 0 });
      this.warmed.add(language);
    }
    return this.tokenizeLoaded(code, language, context, cooperative) as Promise<Token[]>;
  }

  private tokenizeLoaded(code: string, language: string, context: HighlightContext, cooperative: boolean): Token[] | Promise<Token[]> {
    const previous = this.sessions.get(context.id);
    const append = previous?.language === language && context.version > previous.version && code.startsWith(previous.code);
    const session: Session = append ? previous : { language, version: context.version, code: "", finalizedLength: 0, tokens: [], used: 0, bytes: 0 };
    session.used = ++this.clock;
    const completeLength = nextCompleteLength(code, context.state === "done");
    const start = append ? session.finalizedLength : 0;
    const prefix = append ? session.tokens : [];
    const state = append ? session.state : undefined;
    const finish = (tokens: Token[], grammarState: GrammarState | undefined) => {
      session.language = language;
      session.version = context.version;
      session.code = code;
      session.finalizedLength = completeLength;
      session.tokens = tokens;
      session.state = grammarState;
      session.bytes = code.length * 2 + tokens.reduce((sum, token) => sum + token.text.length * 2 + 32, 0);
      this.sessions.set(context.id, session);
      this.evictSessions();
      const output = tokens.map((token) => ({ ...token }));
      if (completeLength < code.length) appendToken(output, code.slice(completeLength));
      return output;
    };
    if (!cooperative && !append && context.state === "done" && !sourceLines(code).some((line) => line.replace(/\n$/, "").length > MAX_LINE)) {
      const result = this.highlighter!.codeToTokensBase(code, { lang: language, theme: THEME, tokenizeMaxLineLength: MAX_LINE, tokenizeTimeLimit: 0 });
      const tokens: Token[] = [];
      this.appendShiki(tokens, result, code);
      return finish(tokens, this.highlighter!.getLastGrammarState(result));
    }
    const work = async () => {
      let tokens = prefix.map((token) => ({ ...token }));
      let grammarState = state;
      let yieldStart = performance.now();
      for (const line of sourceLines(code.slice(start, completeLength))) {
        if (line.replace(/\n$/, "").length > MAX_LINE) {
          appendToken(tokens, line);
          grammarState = undefined;
        } else {
          const result = this.highlighter!.codeToTokensBase(line, { lang: language, theme: THEME, grammarState, tokenizeMaxLineLength: MAX_LINE, tokenizeTimeLimit: 0 });
          this.appendShiki(tokens, result, line);
          grammarState = this.highlighter!.getLastGrammarState(result);
        }
        if (cooperative && performance.now() - yieldStart >= 2) {
          await yieldTask();
          yieldStart = performance.now();
        }
      }
      return finish(tokens, grammarState);
    };
    if (cooperative) return work();
    let tokens = prefix.map((token) => ({ ...token }));
    let grammarState = state;
    for (const line of sourceLines(code.slice(start, completeLength))) {
      if (line.replace(/\n$/, "").length > MAX_LINE) { appendToken(tokens, line); grammarState = undefined; }
      else {
        const result = this.highlighter!.codeToTokensBase(line, { lang: language, theme: THEME, grammarState, tokenizeMaxLineLength: MAX_LINE, tokenizeTimeLimit: 0 });
        this.appendShiki(tokens, result, line);
        grammarState = this.highlighter!.getLastGrammarState(result);
      }
    }
    return finish(tokens, grammarState);
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

  dispose(): void { this.sessions.clear(); this.highlighter?.dispose(); this.highlighter = undefined; this.loaded.clear(); this.warmed.clear(); }
}

async function yieldTask(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { postTask(callback: () => void): Promise<void> } }).scheduler;
  if (scheduler?.postTask) await scheduler.postTask(() => {});
  else await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
