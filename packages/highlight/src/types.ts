export const TOKEN_TYPES = ["keyword", "string", "number", "comment", "function", "type", "variable", "constant", "operator", "punctuation", "tag", "attribute", "regexp", "inserted", "deleted"] as const;
export type TokenType = (typeof TOKEN_TYPES)[number];
export type Token = { text: string; type?: TokenType };
export type HighlightContext = { id: string; version: number; state: "streaming" | "done" };
/**
 * `subscribe(id, listener)` calls `listener` when the cached tokens of block `id` were replaced (a line left plain while
 * its grammar was cold is now colored); ask again for the new tokens. Returns the unsubscribe function.
 */
export type Highlight = ((code: string, lang: string | undefined, context?: HighlightContext) => Token[] | Promise<Token[]> | null) & {
  dispose(): void;
  subscribe(id: string, listener: () => void): () => void;
};
