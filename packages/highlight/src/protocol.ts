import type { HighlightContext, Token } from "./types.js";
export type HighlightRequest = { type: "highlight"; requestId: number; code: string; language: string; context: HighlightContext };
export type DisposeRequest = { type: "dispose" };
export type WorkerRequest = HighlightRequest | DisposeRequest;
// `progress`: the worker is alive and busy, with this block (null: compiling a grammar). Sent when the block changes,
// and otherwise at most every PROGRESS_MS.
export const PROGRESS_MS = 100;
// `provisional`: an update for the same block follows once its grammar is warm. An update carries the block's context.
export type WorkerResponse =
  | { requestId: number; tokens: Token[]; provisional: boolean }
  | { requestId: number; error: string }
  | { update: HighlightContext; language: string; tokens: Token[] }
  | { progress: HighlightContext | null };
