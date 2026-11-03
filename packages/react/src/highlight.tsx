import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Highlight, Token } from "@fulcrum/highlight";

export const HighlightContext = createContext<Highlight | undefined>(undefined);

const length = (tokens: Token[]) => tokens.reduce((sum, token) => sum + token.text.length, 0);

/** One highlight block: what a body asks the highlighter for, and what warming asks for ahead of the body. */
export type Block = { code: string; language: string | undefined; id: string; done?: boolean };

/** The one place a block becomes a highlighter request, so a warmed block and the mounted body share one cache key. */
export function requestTokens(highlight: Highlight | undefined, { code, language, id, done = true }: Block) {
  // The version grows with appended text and once more when the text is done, so each revision has its own cache key.
  return highlight && language && code ? highlight(code, language, { id, version: code.length * 2 + (done ? 1 : 0), state: done ? "done" : "streaming" }) : null;
}

/**
 * Tokens for `code` from the RunProvider's highlighter, or null while they are on their way (render the text plain).
 * Work runs in the highlighter's worker. While a longer streamed revision is pending, the last tokens stay on its prefix,
 * so colors never drop back to plain; tokens that do not spell `code` exactly are never shown.
 */
export function useTokens(code: string, language: string | undefined, id: string, done = true): Token[] | null {
  const highlight = useContext(HighlightContext);
  const result = useMemo(() => requestTokens(highlight, { code, language, id, done }), [highlight, code, language, id, done]);
  const [settled, setSettled] = useState<{ result: unknown; tokens: Token[] }>();
  const last = useRef<{ code: string; tokens: Token[] }>(undefined);
  useEffect(() => {
    if (!(result instanceof Promise)) return;
    let live = true;
    void result.then((tokens) => { if (live) setSettled({ result, tokens }); });
    return () => { live = false; };
  }, [result]);
  const ready = Array.isArray(result) ? result : settled?.result === result ? settled!.tokens : undefined;
  if (ready && length(ready) === code.length) {
    last.current = { code, tokens: ready };
    return ready;
  }
  const prior = last.current;
  if (prior && code.length > prior.code.length && code.startsWith(prior.code)) return [...prior.tokens, { text: code.slice(prior.code.length) }];
  return null;
}

/** Typed tokens as `tok-<type>` spans, untyped ones as text. */
export function Tokens({ tokens }: { tokens: Token[] }) {
  return <>{tokens.map((token, index) => token.type ? <span key={index} className={`tok-${token.type}`}>{token.text}</span> : <Fragment key={index}>{token.text}</Fragment>)}</>;
}

/** Splits tokens at newlines into one token list per line (no trailing empty line for a final newline). */
export function tokenLines(tokens: Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const token of tokens) {
    const parts = token.text.split("\n");
    parts.forEach((text, index) => {
      if (index) lines.push([]);
      if (text) lines.at(-1)!.push(token.type ? { text, type: token.type } : { text });
    });
  }
  if (lines.length > 1 && !lines.at(-1)!.length) lines.pop();
  return lines;
}

/** Tokens with the sorted, non-overlapping [start, end) ranges of their joined text wrapped in `<mark data-part>`. */
export function MarkedTokens({ tokens, ranges, part }: { tokens: Token[]; ranges: Array<[number, number]>; part: string }) {
  if (!ranges.length) return <Tokens tokens={tokens} />;
  const out: ReactNode[] = [];
  let at = 0;
  let r = 0;
  for (const token of tokens) {
    for (let offset = 0; offset < token.text.length; ) {
      const position = at + offset;
      while (r < ranges.length && ranges[r]![1] <= position) r++;
      const range = ranges[r];
      const inside = !!range && range[0] <= position;
      const stop = inside ? range[1] : range ? range[0] : Infinity;
      const text = token.text.slice(offset, offset + Math.min(token.text.length - offset, stop - position));
      const node = token.type ? <span className={`tok-${token.type}`}>{text}</span> : text;
      out.push(inside ? <mark key={out.length} data-part={part}>{node}</mark> : <Fragment key={out.length}>{node}</Fragment>);
      offset += text.length;
    }
    at += token.text.length;
  }
  return <>{out}</>;
}

/** Text highlighted as `language` once tokens arrive; plain until then and when no highlighter is provided. */
export function Code({ text, language, id, done = true }: { text: string; language: string | undefined; id: string; done?: boolean }) {
  const tokens = useTokens(text, language, id, done);
  return tokens ? <Tokens tokens={tokens} /> : <>{text}</>;
}
