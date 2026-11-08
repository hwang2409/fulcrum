export type HistoryValidator = { readonly end: number; readonly entry_id: string | null };

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

function parsePage(value: unknown, expectedValidator?: HistoryValidator, requestedBefore?: number): Page {
  if (!value || typeof value !== "object") throw invalidResponse();
  const page = value as { messages?: unknown; next_before?: unknown; history_validator?: unknown };
  if (!Array.isArray(page.messages) || (page.next_before !== null && (!Number.isInteger(page.next_before) || (page.next_before as number) < 0)) ||
      (requestedBefore !== undefined && typeof page.next_before === "number" && page.next_before >= requestedBefore))
    throw invalidResponse();
  const validator = page.history_validator as { end?: unknown; entry_id?: unknown } | null | undefined;
  if (!validator || !Number.isInteger(validator.end) || (validator.entry_id !== null && typeof validator.entry_id !== "string"))
    throw invalidValidator();
  if (expectedValidator && (validator.end !== expectedValidator.end || validator.entry_id !== expectedValidator.entry_id))
    throw invalidValidator();
  return {
    messages: page.messages,
    nextBefore: page.next_before as number | null,
    validator: { end: validator.end as number, entry_id: validator.entry_id as string | null },
  };
}

const staleHistorySnapshot = (error: unknown) => {
  const value = error as { code?: unknown; data?: { code?: unknown } } | null;
  return value?.code === -32009 && value.data?.code === "stale_history_snapshot";
};

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
    const page = parsePage(await request({ before: null }, signal));
    pages = [page];
    return publish(page, cause);
  };

  const snapshot = await newest("newest");
  const complete = (async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    let current = snapshot;
    while (!current.complete) {
      const previous = pages.at(-1)!;
      try {
        const page = parsePage(await request({ before: previous.nextBefore, historyValidator: pages[0]!.validator }, signal), pages[0]!.validator, previous.nextBefore!);
        pages.push(page);
        current = publish(page, "older");
      } catch (error) {
        if (!staleHistorySnapshot(error)) throw error;
        restart++;
        current = await newest("restart");
      }
    }
    return current;
  })();
  return { snapshot, complete };
}
