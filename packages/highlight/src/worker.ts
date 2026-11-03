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
// Every token message goes through one paced queue (protocol.ts). A result over TOKENS_PER_MESSAGE tokens goes out as
// parts addressed by its message id (`of`), and after a part nothing is sent until the page acks it. The next message
// always comes from the result with the fewest tokens left, so a small reply waits behind at most one part of a large one.
type Result = { requestId: number; tokens: Token[]; provisional: boolean; completion: { status: "pending" | "complete" } } | { update: HighlightContext; language: string; tokens: Token[] };
type Outgoing = { of: number; message: Result; at: number };
const queue: Outgoing[] = [];
let sent = 0;
let waiting = false; // a part is out and not yet acked
const left = (entry: Outgoing) => entry.message.tokens.length - entry.at;
const pump = () => {
  while (!waiting && queue.length) {
    const next = queue.reduce((best, entry) => left(entry) < left(best) ? entry : best);
    const { of, message, at } = next;
    if (left(next) > TOKENS_PER_MESSAGE) {
      scope.postMessage({ part: message.tokens.slice(at, at + TOKENS_PER_MESSAGE), of });
      next.at += TOKENS_PER_MESSAGE;
      waiting = true;
    } else {
      queue.splice(queue.indexOf(next), 1);
      scope.postMessage({ ...message, tokens: at ? message.tokens.slice(at) : message.tokens, of });
    }
  }
};
const send = (message: Result) => { queue.push({ of: ++sent, message, at: 0 }); pump(); };
const runtime = new TokenizerRuntime((update, language, tokens) => send({ update, language, tokens }), progress);
scope.onmessage = async (event) => {
  if (event.data.type === "ack") { waiting = false; pump(); return; }
  if (event.data.type === "dispose") { runtime.dispose(); scope.close(); return; }
  const { requestId, code, language, context } = event.data;
  try {
    const tokens = await runtime.tokenize(code, language, context);
    const provisional = runtime.takeProvisionalReply(context);
    send({ requestId, tokens, provisional, completion: { status: provisional || context.state !== "done" ? "pending" : "complete" } });
  } catch (cause) {
    scope.postMessage({ requestId, error: cause instanceof Error ? cause.message : String(cause), completion: { status: "unavailable", reason: "grammar" } });
  }
};
