import { expect, test } from "bun:test";
import {
  childRunHistoryUnavailable,
  openChildRun,
  type ChildRunKey,
  type ZetaClient,
} from "../src/index.js";

const key = { sessionId: "owner", runId: "owner:1" } as const;
const validator = { end: 3, entry_id: "u-new" } as const;
// Zeta afc1e088: docs/serve-protocol.md:1429-1447 and tests/test_server_child_run_history.py:145-232.
const row = (id: string, text: string) => ({
  id,
  role: "user",
  content: [{ type: "text", text }],
  tool_result: null,
});
const page = (messages: readonly unknown[], next_before: number | null, history_validator = validator) => ({
  messages,
  next_before,
  history_validator,
});
type Call = { method: string; params?: Record<string, unknown>; signal?: AbortSignal };
const client = (
  features: readonly string[],
  handler: (call: Call) => unknown | Promise<unknown>,
) => {
  const calls: Call[] = [];
  const value = {
    features,
    request(method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal }) {
      const call = { method, params, signal: options?.signal };
      calls.push(call);
      return Promise.resolve(handler(call));
    },
  } as unknown as ZetaClient;
  return { calls, value };
};
const outline = (opened: Awaited<ReturnType<typeof openChildRun>>) =>
  opened.lease.store.getOutline().map(({ id }) => id);
const settlesWithin = (promise: Promise<unknown>, timeoutMs = 20) =>
  Promise.race([promise.then(() => true, () => true), Bun.sleep(timeoutMs).then(() => false)]);

test("feature and pair validation send no child history request", async () => {
  const absent = client([], () => page([], null));
  expect(childRunHistoryUnavailable(absent.value)).toBe("child run history is unavailable");
  await expect(openChildRun(absent.value, key)).rejects.toMatchObject({ name: "ChildRunHistoryError", kind: "not_negotiated" });
  expect(absent.calls).toHaveLength(0);

  const invalid = client(["child_run_history"], () => page([], null));
  expect(childRunHistoryUnavailable(invalid.value)).toBeUndefined();
  await expect(openChildRun(invalid.value, { sessionId: "", runId: key.runId })).rejects.toMatchObject({ kind: "invalid_request" });
  await expect(openChildRun(invalid.value, { sessionId: key.sessionId, runId: "" })).rejects.toMatchObject({ kind: "invalid_request" });
  expect(invalid.calls).toHaveLength(0);
});

test("resolves at newest establishment and completes one oldest-first backfill", async () => {
  let resolveOlder!: (value: unknown) => void;
  const progress: unknown[] = [];
  const fake = client(["serve_observers", "child_run_history"], ({ params }) => {
    if (params?.before === null) return page([row("u-new", "new")], 2);
    return new Promise((resolve) => { resolveOlder = resolve; });
  });

  const opened = await openChildRun(fake.value, { sessionId: "owner", runId: "owner:1:1" }, {
    onProgress: (value) => progress.push(value),
  });
  expect(outline(opened)).toEqual(["user:message:u-new"]);
  expect(await settlesWithin(opened.complete)).toBe(false);
  expect(fake.calls[0]?.params).toEqual({ session_id: "owner", run_id: "owner:1:1", before: null });

  resolveOlder(page([row("u-old", "old")], null));
  await opened.complete;

  expect(outline(opened)).toEqual(["user:message:u-old", "user:message:u-new"]);
  expect(fake.calls[1]?.params).toEqual({
    session_id: "owner",
    run_id: "owner:1:1",
    before: 2,
    history_validator: validator,
  });
  expect(progress).toEqual([
    { messages: 1, complete: false, restart: 0 },
    { messages: 2, complete: true, restart: 0 },
  ]);
  opened.lease.release();
});

test("one pair shares its in-flight store and progress while equal child ids under different owners do not", async () => {
  let requests = 0;
  const fake = client(["child_run_history"], ({ params }) => {
    requests++;
    return page([row(`u-${params?.session_id}`, String(params?.session_id))], null);
  });
  const firstProgress: unknown[] = [];
  const secondProgress: unknown[] = [];

  const [first, second] = await Promise.all([
    openChildRun(fake.value, key, { onProgress: (progress) => firstProgress.push(progress) }),
    openChildRun(fake.value, key, { onProgress: (progress) => secondProgress.push(progress) }),
  ]);
  const other = await openChildRun(fake.value, { sessionId: "other", runId: key.runId });

  expect(requests).toBe(2);
  expect(first.lease.store).toBe(second.lease.store);
  expect(other.lease.store).not.toBe(first.lease.store);
  expect(firstProgress).toEqual([{ messages: 1, complete: true, restart: 0 }]);
  expect(secondProgress).toEqual(firstProgress);
  await Promise.all([first.complete, second.complete, other.complete]);
  first.lease.release();
  second.lease.release();
  other.lease.release();
});

test("a stale child snapshot replaces prior rows through the shared pager", async () => {
  let newest = 0;
  const fake = client(["child_run_history"], ({ params }) => {
    if (params?.before === null) {
      newest++;
      return newest === 1
        ? page([row("u-stale", "stale")], 1)
        : page([row("u-fresh", "fresh")], null, { end: 4, entry_id: "u-fresh" });
    }
    throw { code: -32009, data: { code: "stale_history_snapshot" } };
  });

  const opened = await openChildRun(fake.value, key);
  await opened.complete;

  expect(outline(opened)).toEqual(["user:message:u-fresh"]);
  opened.lease.release();
});

test("the final release aborts a pending child load and a later open starts fresh", async () => {
  let requests = 0;
  let sawAbort = false;
  const fake = client(["child_run_history"], ({ signal }) => {
    requests++;
    if (requests > 1) return page([row("u-fresh", "fresh")], null);
    return new Promise((_, reject) => signal?.addEventListener("abort", () => {
      sawAbort = true;
      reject(signal.reason);
    }, { once: true }));
  });
  const controller = new AbortController();
  const opening = openChildRun(fake.value, key, { signal: controller.signal });
  controller.abort(Object.assign(new Error("closed"), { name: "AbortError" }));
  await expect(opening).rejects.toMatchObject({ name: "AbortError" });
  expect(sawAbort).toBe(true);

  const reopened = await openChildRun(fake.value, key);
  expect(requests).toBe(2);
  expect(outline(reopened)).toEqual(["user:message:u-fresh"]);
  await reopened.complete;
  reopened.lease.release();
});

test("maps documented child history errors and preserves their causes", async () => {
  const cases: Array<[unknown, string]> = [
    [{ code: -32601 }, "not_negotiated"],
    [{ code: -32602 }, "invalid_request"],
    [{ code: -32003 }, "owner_not_active"],
    [{ code: -32012, data: { code: "child_run_not_found" } }, "not_found"],
    [{ code: -32000, data: { code: "corrupt_transcript", repair: "path" } }, "corrupt_transcript"],
  ];
  for (const [cause, kind] of cases) {
    const fake = client(["child_run_history"], () => { throw cause; });
    try {
      await openChildRun(fake.value, key);
      throw new Error("expected child history error");
    } catch (error) {
      expect(error).toMatchObject({ name: "ChildRunHistoryError", kind, cause });
    }
  }
});

test("maps the shared stale budget once and does not retry automatically", async () => {
  let requests = 0;
  const fake = client(["child_run_history"], ({ params }) => {
    requests++;
    if (params?.before === null) return page([row(`u-${requests}`, "new")], 1, { end: requests, entry_id: `u-${requests}` });
    throw { code: -32009, data: { code: "stale_history_snapshot" } };
  });

  const opened = await openChildRun(fake.value, key);
  await expect(opened.complete).rejects.toMatchObject({
    name: "ChildRunHistoryError",
    kind: "history_kept_changing",
    message: "history kept changing; retry",
  });
  expect(requests).toBe(8);
  opened.lease.release();
});
