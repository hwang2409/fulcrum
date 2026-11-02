export const TOKEN_TYPES = ["keyword", "string", "number", "comment", "function", "type", "variable", "constant", "operator", "punctuation", "tag", "attribute", "regexp", "inserted", "deleted"] as const;
export type TokenType = (typeof TOKEN_TYPES)[number];
export type Token = { text: string; type?: TokenType };
export type HighlightContext = { id: string; version: number; state: "streaming" | "done" };
export type Highlight = ((code: string, lang: string | undefined, context?: HighlightContext) => Token[] | Promise<Token[]> | null) & { dispose(): void };
