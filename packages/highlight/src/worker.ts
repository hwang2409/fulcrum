import type { WorkerRequest, WorkerResponse } from "./protocol.js";
import { TokenizerRuntime } from "./runtime.js";

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(value: WorkerResponse): void;
  close(): void;
};
const runtime = new TokenizerRuntime((update, language, tokens) => scope.postMessage({ update, language, tokens }));
scope.onmessage = async (event) => {
  if (event.data.type === "dispose") { runtime.dispose(); scope.close(); return; }
  const { requestId, code, language, context } = event.data;
  try {
    const tokens = await runtime.tokenize(code, language, context, false);
    scope.postMessage({ requestId, tokens, provisional: runtime.willUpdate(context) });
  } catch (cause) {
    scope.postMessage({ requestId, error: cause instanceof Error ? cause.message : String(cause) });
  }
};
