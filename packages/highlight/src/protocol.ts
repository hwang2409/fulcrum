import type { HighlightContext, Token } from "./types.js";
export type HighlightRequest = { type: "highlight"; requestId: number; code: string; language: string; context: HighlightContext };
export type DisposeRequest = { type: "dispose" };
export type WorkerRequest = HighlightRequest | DisposeRequest;
export type WorkerResponse = { requestId: number; tokens: Token[] } | { requestId: number; error: string };
