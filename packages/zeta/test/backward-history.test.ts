import { expect, test } from "bun:test";
import { openBackwardHistory, type BackwardHistoryCursor } from "../src/index.js";

const validator = { end: 3, entry_id: "new" } as const;
const page = (messages: string[], next_before: number | null, history_validator = validator) => ({ messages, next_before, history_validator });
const becomesTrueWithin = async (condition: () => boolean, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await Bun.sleep(1);
  return condition();
};
const settlesWithin = (promise: Promise<unknown>, timeoutMs = 1_000) =>
  Promise.race([promise.then(() => true, () => true), Bun.sleep(timeoutMs).then(() => false)]);

test("publishes newest first and complete history oldest first", async () => {
  const requests: BackwardHistoryCursor[] = [];
  const snapshots: Array<{ rows: readonly unknown[]; pageRows: readonly unknown[]; cause: string; complete: boolean }> = [];
  const opened = await openBackwardHistory(async (cursor) => {
    requests.push(cursor);
    if (cursor.before === null) return page(["new"], 2);
    if (cursor.before === 2) return page(["middle"], 1);
    return page(["old"], null);
  }, { onSnapshot: (snapshot) => snapshots.push(snapshot) });

  expect(opened.snapshot.rows).toEqual(["new"]);
  expect((await opened.complete).rows).toEqual(["old", "middle", "new"]);
  expect(snapshots).toEqual([
    { rows: ["new"], pageRows: ["new"], cause: "newest", complete: false, restart: 0 },
    { rows: ["middle", "new"], pageRows: ["middle"], cause: "older", complete: false, restart: 0 },
    { rows: ["old", "middle", "new"], pageRows: ["old"], cause: "older", complete: true, restart: 0 },
  ]);
  expect(requests).toEqual([
    { before: null },
    { before: 2, historyValidator: validator },
    { before: 1, historyValidator: validator },
  ]);
});

test("rejects a malformed continuation before publishing its rows", async () => {
  const snapshots: readonly unknown[][] = [];
  const opened = await openBackwardHistory(async ({ before }) => before === null
    ? page(["new"], 1)
    : page(["wrong snapshot"], null, { end: 4, entry_id: "other" }),
  { onSnapshot: ({ rows }) => snapshots.push(rows) });

  await expect(opened.complete).rejects.toThrow("backward history response has an invalid validator");
  expect(snapshots).toEqual([["new"]]);
});

test("rejects malformed first pages and non-decreasing continuation cursors", async () => {
  await expect(openBackwardHistory(async () => ({ messages: "not an array", next_before: null, history_validator: validator })))
    .rejects.toThrow("backward history response is invalid");
  const opened = await openBackwardHistory(async ({ before }) => before === null ? page(["new"], 1) : page(["wrong"], 1));
  await expect(opened.complete).rejects.toThrow("backward history response is invalid");
});

test("a stale continuation discards every old-snapshot row", async () => {
  let newest = 0;
  const snapshots: Array<{ rows: readonly unknown[]; cause: string; restart: number }> = [];
  const opened = await openBackwardHistory(async ({ before }) => {
    if (before === null) {
      newest++;
      return newest === 1 ? page(["old-new"], 1) : page(["fresh"], null, { end: 1, entry_id: "fresh" });
    }
    throw { code: -32009, data: { code: "stale_history_snapshot" } };
  }, { onSnapshot: (snapshot) => snapshots.push(snapshot) });

  expect((await opened.complete).rows).toEqual(["fresh"]);
  expect(snapshots).toEqual([
    { rows: ["old-new"], pageRows: ["old-new"], cause: "newest", complete: false, restart: 0 },
    { rows: ["fresh"], pageRows: ["fresh"], cause: "restart", complete: true, restart: 1 },
  ]);
});

test("uses one abort signal for every request", async () => {
  const controller = new AbortController();
  const signals: AbortSignal[] = [];
  let rejectOlder!: (error: unknown) => void;
  const opened = await openBackwardHistory(async ({ before }, signal) => {
    signals.push(signal);
    if (before === null) return page(["new"], 1);
    return new Promise((_, reject) => {
      rejectOlder = reject;
      signal.addEventListener("abort", () => reject(Object.assign(new Error("request aborted"), { name: "AbortError" })), { once: true });
    });
  }, { signal: controller.signal });

  let settled = false;
  try {
    expect(await becomesTrueWithin(() => signals.length === 2)).toBe(true);
  } finally {
    controller.abort();
    settled = await settlesWithin(opened.complete);
  }
  expect(signals.map((signal) => signal === controller.signal)).toEqual([true, true]);
  expect(settled).toBe(true);
  await expect(opened.complete).rejects.toMatchObject({ name: "AbortError" });
  expect(rejectOlder).toBeFunction();
}, 15_000);

test("rejects when aborted after a final first page", async () => {
  const controller = new AbortController();
  const opened = await openBackwardHistory(async () => page(["only"], null), { signal: controller.signal });

  controller.abort();

  await expect(opened.complete).rejects.toMatchObject({ name: "AbortError" });
});

test("does not publish a continuation that resolves after abort", async () => {
  const controller = new AbortController();
  const snapshots: readonly unknown[][] = [];
  let resolveOlder!: (value: unknown) => void;
  // A custom request callback that ignores the signal and resolves late.
  const opened = await openBackwardHistory(async ({ before }) => before === null
    ? page(["new"], 1)
    : new Promise((resolve) => { resolveOlder = resolve; }),
  { signal: controller.signal, onSnapshot: ({ rows }) => snapshots.push(rows) });

  let settled = false;
  try {
    expect(await becomesTrueWithin(() => resolveOlder !== undefined)).toBe(true);
    controller.abort();
    resolveOlder(page(["old"], null));
  } finally {
    controller.abort();
    resolveOlder?.(page(["old"], null));
    settled = await settlesWithin(opened.complete);
  }
  expect(snapshots).toEqual([["new"]]);
  expect(settled).toBe(true);
  await expect(opened.complete).rejects.toMatchObject({ name: "AbortError" });
});
