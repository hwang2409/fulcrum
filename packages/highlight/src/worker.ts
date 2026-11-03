import { PROGRESS_MS, TOKENS_PER_MESSAGE, type WorkerRequest, type WorkerResponse } from "./protocol.js";
import type { HighlightContext, Token } from "./types.js";
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
// Messages from one worker arrive in order, so the page joins the parts to the reply or update that follows them. Every
// token message goes through one queue, so another reply cannot land between the parts of a paced one (protocol.ts).
let outbox = Promise.resolve();
let acked: (() => void) | undefined;
const send = <T extends WorkerResponse & { tokens: Token[] }>(message: T) => {
  outbox = outbox.then(async () => {
    const last = Math.max(0, Math.ceil(message.tokens.length / TOKENS_PER_MESSAGE) - 1) * TOKENS_PER_MESSAGE;
    for (let start = 0; start < last; start += TOKENS_PER_MESSAGE) {
      scope.postMessage({ part: message.tokens.slice(start, start + TOKENS_PER_MESSAGE) });
      await new Promise<void>((resolve) => { acked = resolve; });
    }
    scope.postMessage(last ? { ...message, tokens: message.tokens.slice(last) } : message);
  });
};
const runtime = new TokenizerRuntime((update, language, tokens) => send({ update, language, tokens }), progress);
scope.onmessage = async (event) => {
  if (event.data.type === "ack") { acked?.(); acked = undefined; return; }
  if (event.data.type === "dispose") { runtime.dispose(); scope.close(); return; }
  const { requestId, code, language, context } = event.data;
  try {
    const tokens = await runtime.tokenize(code, language, context);
    send({ requestId, tokens, provisional: runtime.willUpdate(context) });
  } catch (cause) {
    scope.postMessage({ requestId, error: cause instanceof Error ? cause.message : String(cause) });
  }
};
