export const TOKEN_TYPES = ["keyword", "string", "number", "comment", "function", "type", "variable", "constant", "operator", "punctuation", "tag", "attribute", "regexp", "inserted", "deleted"] as const;
export type TokenType = (typeof TOKEN_TYPES)[number];
export type Token = { text: string; type?: TokenType };
export type HighlightContext = { id: string; version: number; state: "streaming" | "done" };
export type Completion = { status: "pending" | "complete" | "unavailable"; reason?: "grammar" | "size" | "watchdog" | "worker" };
export type CompletionNotice = Completion & { version: number };
/** `subscribe` reports cache replacement and terminal completion for the requested block id. */
export type Highlight = ((code: string, lang: string | undefined, context?: HighlightContext) => Token[] | Promise<Token[]> | null) & {
  dispose(): void;
  subscribe(id: string, listener: (completion: CompletionNotice) => void): () => void;
  awaitCompletion(id: string, version: number): Promise<CompletionNotice>;
};
