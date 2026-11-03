import type { HighlightContext, Token } from "./types.js";
export type HighlightRequest = { type: "highlight"; requestId: number; code: string; language: string; context: HighlightContext };
export type DisposeRequest = { type: "dispose" };
// The page has applied the last `part`: the worker may send the next one.
export type AckRequest = { type: "ack" };
export type WorkerRequest = HighlightRequest | DisposeRequest | AckRequest;
// `progress`: the worker is alive and busy, with this block (null: compiling a grammar). Sent when the block changes,
// and otherwise at most every PROGRESS_MS.
export const PROGRESS_MS = 100;
// A reply or update with more than TOKENS_PER_MESSAGE tokens comes as `part` messages, then the reply or update with
// the last part, all with the same `of` (one id per result): the page's thread deserializes each message in one task
// (330k tokens took 133 ms in chromium). The worker sends each message after a part only once the page acks that part,
// and the page acks at most once per animation frame: 21 parts sent at once ran as one 167 ms run of back-to-back tasks
// at 4x cpu throttling. Parts of different results may interleave: the worker sends the result with the fewest tokens
// left first, so a small reply does not wait for every part of a 330k-token one (it waited 335 ms at 4x).
export const TOKENS_PER_MESSAGE = 16_384;
// `provisional`: an update for the same block follows once its grammar is warm. An update carries the block's context.
export type WorkerResponse =
  | { requestId: number; tokens: Token[]; provisional: boolean; of: number }
  | { requestId: number; error: string }
  | { update: HighlightContext; language: string; tokens: Token[]; of: number }
  | { progress: HighlightContext | null }
  | { part: Token[]; of: number };
