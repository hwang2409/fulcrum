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

test("pages with an old two-field validator", async () => {
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

test("returns every validator field unchanged on older-page requests", async () => {
  const opaqueValidator = { end: 3, entry_id: "new", repair_generation: "repair-1", future: { enabled: true } } as const;
  const reorderedValidator = { future: { enabled: true }, repair_generation: "repair-1", entry_id: "new", end: 3 } as const;
  const requests: BackwardHistoryCursor[] = [];
  const opened = await openBackwardHistory(async (cursor) => {
    requests.push(cursor);
    if (cursor.before === null) return page(["new"], 2, opaqueValidator);
    if (cursor.historyValidator?.repair_generation !== opaqueValidator.repair_generation)
      throw { code: -32009, data: { code: "stale_history_snapshot" } };
    if (cursor.before === 2) return page(["middle"], 1, reorderedValidator);
    return page(["old"], null, reorderedValidator);
  });

  expect((await opened.complete).rows).toEqual(["old", "middle", "new"]);
  expect(requests.slice(1)).toEqual([
    { before: 2, historyValidator: opaqueValidator },
    { before: 1, historyValidator: opaqueValidator },
  ]);
});

test("rejects a changed opaque validator field before publishing its rows", async () => {
  const opaqueValidator = { end: 3, entry_id: "new", repair_generation: "repair-1" } as const;
  const snapshots: readonly unknown[][] = [];
  const opened = await openBackwardHistory(async ({ before }) => before === null
    ? page(["new"], 1, opaqueValidator)
    : page(["wrong snapshot"], null, { ...opaqueValidator, repair_generation: "repair-2" }),
  { onSnapshot: ({ rows }) => snapshots.push(rows) });

  await expect(opened.complete).rejects.toThrow("backward history response has an invalid validator");
  expect(snapshots).toEqual([["new"]]);
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

test("rejects malformed first pages and outside-input cursors", async () => {
  await expect(openBackwardHistory(async () => ({ messages: "not an array", next_before: null, history_validator: validator })))
    .rejects.toThrow("backward history response is invalid");
  await expect(openBackwardHistory(async () => page(["negative"], -1)))
    .rejects.toThrow("backward history response is invalid");
  await expect(openBackwardHistory(async () => page(["negative validator"], null, { end: -1, entry_id: null })))
    .rejects.toThrow("backward history response has an invalid validator");
  await expect(openBackwardHistory(async () => page(["unsafe validator"], null, { end: Number.MAX_SAFE_INTEGER + 1, entry_id: null })))
    .rejects.toThrow("backward history response has an invalid validator");
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

test("bounds consecutive stale continuation restarts and never publishes stale rows", async () => {
  const controller = new AbortController();
  const snapshots: readonly unknown[][] = [];
  let requests = 0;
  let newest = 0;
  const opened = await openBackwardHistory(async ({ before }) => {
    requests++;
    if (requests > 8) controller.abort(Object.assign(new Error("unbounded stale restarts"), { name: "AbortError" }));
    if (before === null) return page([`new-${++newest}`], 1, { end: newest, entry_id: `new-${newest}` });
    throw { code: -32009, data: { code: "stale_history_snapshot" } };
  }, { signal: controller.signal, onSnapshot: ({ rows }) => snapshots.push(rows) });

  await expect(opened.complete).rejects.toMatchObject({
    name: "BackwardHistoryError",
    kind: "history_kept_changing",
    message: "history kept changing; retry",
  });
  expect(requests).toBe(8);
  expect(snapshots).toEqual([["new-1"], ["new-2"], ["new-3"], ["new-4"]]);
});

test("stale restart-newest requests consume the same finite budget", async () => {
  const controller = new AbortController();
  let requests = 0;
  const opened = await openBackwardHistory(async ({ before }) => {
    requests++;
    if (requests > 5) controller.abort(Object.assign(new Error("unbounded newest restarts"), { name: "AbortError" }));
    if (requests === 1) return page(["new"], 1);
    throw { code: -32009, data: { code: "stale_history_snapshot" } };
  }, { signal: controller.signal });

  await expect(opened.complete).rejects.toMatchObject({
    name: "BackwardHistoryError",
    kind: "history_kept_changing",
  });
  expect(requests).toBe(5);
});

test("an advancing older page resets the stale restart budget", async () => {
  let newest = 0;
  let afterProgressRestarts = 0;
  let progress = false;
  const opened = await openBackwardHistory(async ({ before }) => {
    if (before === null) {
      newest++;
      return page([`new-${newest}`], 3, { end: newest, entry_id: `new-${newest}` });
    }
    if (!progress && newest === 1) throw { code: -32009, data: { code: "stale_history_snapshot" } };
    if (!progress) {
      progress = true;
      return page(["middle"], 2, { end: newest, entry_id: `new-${newest}` });
    }
    if (afterProgressRestarts++ < 3) throw { code: -32009, data: { code: "stale_history_snapshot" } };
    return page(["old"], null, { end: newest, entry_id: `new-${newest}` });
  });

  expect((await opened.complete).rows).toEqual(["old", `new-${newest}`]);
  expect(newest).toBe(5);
});

test("abort wins while restart-newest is pending and prevents late publication", async () => {
  const controller = new AbortController();
  const reason = new Error("viewer closed");
  const snapshots: readonly unknown[][] = [];
  let requests = 0;
  let resolveRestart!: (value: unknown) => void;
  const opened = await openBackwardHistory(async ({ before }) => {
    requests++;
    if (requests === 1) return page(["new"], 1);
    if (before !== null) throw { code: -32009, data: { code: "stale_history_snapshot" } };
    return new Promise((resolve) => { resolveRestart = resolve; });
  }, { signal: controller.signal, onSnapshot: ({ rows }) => snapshots.push(rows) });

  expect(await becomesTrueWithin(() => resolveRestart !== undefined)).toBe(true);
  controller.abort(reason);
  resolveRestart(page(["late"], null, { end: 4, entry_id: "late" }));

  await expect(opened.complete).rejects.toBe(reason);
  expect(requests).toBe(3);
  expect(snapshots).toEqual([["new"]]);
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
