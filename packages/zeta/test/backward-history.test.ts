import { expect, test } from "bun:test";
import { openBackwardHistory, type BackwardHistoryCursor } from "../src/index.js";

const validator = { end: 3, entry_id: "new" } as const;
const page = (messages: string[], next_before: number | null, history_validator = validator) => ({ messages, next_before, history_validator });

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

  while (signals.length < 2) await Bun.sleep(0);
  controller.abort();
  await expect(opened.complete).rejects.toMatchObject({ name: "AbortError" });
  expect(signals).toEqual([controller.signal, controller.signal]);
  expect(rejectOlder).toBeFunction();
});
