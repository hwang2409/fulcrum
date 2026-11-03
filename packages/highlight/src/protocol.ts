import type { HighlightContext, Token } from "./types.js";
export type HighlightRequest = { type: "highlight"; requestId: number; code: string; language: string; context: HighlightContext };
export type DisposeRequest = { type: "dispose" };
export type WorkerRequest = HighlightRequest | DisposeRequest;
// `provisional`: an update for the same block follows once its grammar is warm. An update carries the block's context.
export type WorkerResponse =
  | { requestId: number; tokens: Token[]; provisional: boolean }
  | { requestId: number; error: string }
  | { update: HighlightContext; language: string; tokens: Token[] };
