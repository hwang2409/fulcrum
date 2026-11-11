export type HistoryValidator = {
  readonly end: number;
  readonly entry_id: string | null;
  readonly [field: string]: unknown;
};

export type BackwardHistoryCursor = {
  readonly before: number | null;
  readonly historyValidator?: HistoryValidator;
};

export type BackwardHistorySnapshot = {
  readonly rows: readonly unknown[];
  readonly pageRows: readonly unknown[];
  readonly cause: "newest" | "older" | "restart";
  readonly complete: boolean;
  readonly restart: number;
};

export type BackwardHistoryRequest = (
  cursor: BackwardHistoryCursor,
  signal: AbortSignal,
) => Promise<unknown>;

type Page = {
  readonly messages: readonly unknown[];
  readonly nextBefore: number | null;
  readonly validator: HistoryValidator;
};

const invalidResponse = () => new Error("backward history response is invalid");
const invalidValidator = () => new Error("backward history response has an invalid validator");

function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right))
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equalJson(value, right[index]));
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length && keys.every((key) => Object.hasOwn(rightRecord, key) && equalJson(leftRecord[key], rightRecord[key]));
}

function parsePage(value: unknown, expectedValidator?: HistoryValidator, requestedBefore?: number): Page {
  if (!value || typeof value !== "object") throw invalidResponse();
  const page = value as { messages?: unknown; next_before?: unknown; history_validator?: unknown };
  if (!Array.isArray(page.messages) || (page.next_before !== null && (!Number.isInteger(page.next_before) || (page.next_before as number) < 0)) ||
      (requestedBefore !== undefined && typeof page.next_before === "number" && page.next_before >= requestedBefore))
    throw invalidResponse();
  const validator = page.history_validator as Record<string, unknown> | null | undefined;
  if (!validator || Array.isArray(validator) || !Number.isSafeInteger(validator.end) || (validator.end as number) < 0 ||
      (validator.entry_id !== null && typeof validator.entry_id !== "string"))
    throw invalidValidator();
  if (expectedValidator && !equalJson(validator, expectedValidator)) throw invalidValidator();
  return {
    messages: page.messages,
    nextBefore: page.next_before as number | null,
    validator: validator as HistoryValidator,
  };
}

const staleHistorySnapshot = (error: unknown) => {
  const value = error as { code?: unknown; data?: { code?: unknown } } | null;
  return value?.code === -32009 && value.data?.code === "stale_history_snapshot";
};

const MAX_STALE_RESTARTS = 3;
export class BackwardHistoryError extends Error {
  readonly name = "BackwardHistoryError";
  constructor(readonly kind: "history_kept_changing", message: string, readonly cause?: unknown) {
    super(message);
  }
}

export async function openBackwardHistory(
  request: BackwardHistoryRequest,
  options: {
    readonly signal?: AbortSignal;
    readonly onSnapshot?: (snapshot: BackwardHistorySnapshot) => void;
  } = {},
): Promise<{
  readonly snapshot: BackwardHistorySnapshot;
  readonly complete: Promise<BackwardHistorySnapshot>;
}> {
  const signal = options.signal ?? new AbortController().signal;
  let pages: Page[] = [];
  let restart = 0;
  let staleRestarts = 0;

  const keptChanging = (cause: unknown) => new BackwardHistoryError(
    "history_kept_changing",
    "history kept changing; retry",
    cause,
  );
  const abortWins = () => signal.throwIfAborted();
  const consumeRestart = (cause: unknown) => {
    abortWins();
    if (staleRestarts >= MAX_STALE_RESTARTS) throw keptChanging(cause);
    staleRestarts++;
    restart++;
  };
  const publish = (page: Page, cause: BackwardHistorySnapshot["cause"]): BackwardHistorySnapshot => {
    const snapshot = {
      rows: [...pages].reverse().flatMap(({ messages }) => messages),
      pageRows: page.messages,
      cause,
      complete: page.nextBefore === null,
      restart,
    } satisfies BackwardHistorySnapshot;
    options.onSnapshot?.(snapshot);
    return snapshot;
  };
  const newest = async (cause: "newest" | "restart") => {
    while (true) {
      abortWins();
      try {
        const response = await request({ before: null }, signal);
        abortWins();
        const page = parsePage(response);
        pages = [page];
        if (page.nextBefore === null) staleRestarts = 0;
        return publish(page, cause);
      } catch (error) {
        abortWins();
        if (!staleHistorySnapshot(error)) throw error;
        consumeRestart(error);
        cause = "restart";
      }
    }
  };

  const snapshot = await newest("newest");
  const complete = (async () => {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, 0);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    let current = snapshot;
    while (!current.complete) {
      const previous = pages.at(-1)!;
      try {
        const response = await request({ before: previous.nextBefore, historyValidator: pages[0]!.validator }, signal);
        signal.throwIfAborted();
        const page = parsePage(response, pages[0]!.validator, previous.nextBefore!);
        pages.push(page);
        current = publish(page, "older");
        staleRestarts = 0;
      } catch (error) {
        abortWins();
        if (!staleHistorySnapshot(error)) throw error;
        consumeRestart(error);
        current = await newest("restart");
      }
    }
    return current;
  })();
  return { snapshot, complete };
}
