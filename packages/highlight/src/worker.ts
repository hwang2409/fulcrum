import { PROGRESS_MS, type WorkerRequest, type WorkerResponse } from "./protocol.js";
import type { HighlightContext } from "./types.js";
import { TokenizerRuntime } from "./runtime.js";

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(value: WorkerResponse): void;
  close(): void;
};
let progressOf: HighlightContext | null | undefined;
let progressAt = 0;
const progress = (context: HighlightContext | null) => {
  const now = performance.now();
  if (context === progressOf && now - progressAt < PROGRESS_MS) return;
  progressOf = context; progressAt = now;
  scope.postMessage({ progress: context });
};
const runtime = new TokenizerRuntime((update, language, tokens) => scope.postMessage({ update, language, tokens }), progress);
scope.onmessage = async (event) => {
  if (event.data.type === "dispose") { runtime.dispose(); scope.close(); return; }
  const { requestId, code, language, context } = event.data;
  try {
    const tokens = await runtime.tokenize(code, language, context);
    scope.postMessage({ requestId, tokens, provisional: runtime.willUpdate(context) });
  } catch (cause) {
    scope.postMessage({ requestId, error: cause instanceof Error ? cause.message : String(cause) });
  }
};
