import { expect, test } from "bun:test";
import {
  PATH_COMPLETION_FEATURE,
  completePath,
  type PathCompletionClient,
  type PathCompletionResult,
  type RequestOptions,
  type ZetaClient,
} from "../src/index.js";

// Zeta 2c378ecb docs/serve-protocol.md:1566-1582 and tests/test_server_path_completion.py:60-190 define this result shape.
const entry = { text: "src/", display: "@src/", kind: "directory", start_position: -2 } as const;
const result = (entries: readonly unknown[] = [entry], truncated = false) => ({ entries, truncated });

const clientFor = (reply: unknown, features: readonly string[] = [PATH_COMPLETION_FEATURE]) => {
  const calls: Array<[string, Record<string, unknown>, RequestOptions | undefined]> = [];
  const client: PathCompletionClient = {
    features,
    request(method, params, options) {
      calls.push([method, params ?? {}, options]);
      return Promise.resolve(reply);
    },
  };
  return { client, calls };
};

type SuccessCase = {
  readonly name: string;
  readonly text: string;
  readonly reply: unknown;
  readonly expected: PathCompletionResult;
};

// Each reply mirrors Zeta 2c378ecb tests/test_server_path_completion.py:60-190; the combining row follows path_completion.py:127-139.
const successCases: readonly SuccessCase[] = [
  {
    name: "astral code point",
    text: "see @😀",
    reply: result([{ text: "😀folder/", display: "@😀folder/", kind: "directory", start_position: -1 }]),
    expected: { kind: "entries", entries: [{ text: "😀folder/", display: "@😀folder/", kind: "directory", startPosition: -2 }], truncated: false },
  },
  {
    name: "combining mark",
    text: "x @😀e\u0301",
    reply: result([{ text: "😀e\u0301.txt", display: "@😀e\u0301.txt", kind: "file", start_position: -3 }]),
    expected: { kind: "entries", entries: [{ text: "😀e\u0301.txt", display: "@😀e\u0301.txt", kind: "file", startPosition: -4 }], truncated: false },
  },
  {
    name: "quoted hidden directory and truncation",
    text: "open @.s",
    reply: result([{ text: '".secret folder/', display: '@".secret folder/', kind: "directory", start_position: -2 }], true),
    expected: { kind: "entries", entries: [{ text: '".secret folder/', display: '@".secret folder/', kind: "directory", startPosition: -2 }], truncated: true },
  },
];

test.each(successCases)("completePath maps $name through the public export", async (row) => {
  const { client, calls } = clientFor(row.reply);
  const options = { timeoutMs: 250 };
  const actual = await completePath(client, "session-1", row.text, options);
  expect(actual).toEqual(row.expected);
  expect(calls).toEqual([["path_complete", { session_id: "session-1", text_before_cursor: row.text }, options]]);
  if (row.name === "combining mark" && actual.kind === "entries") {
    const offset = actual.entries[0]!.startPosition;
    expect(row.text.slice(0, row.text.length + offset) + actual.entries[0]!.text).toBe("x @😀e\u0301.txt");
  }
});

type NoSendCase = {
  readonly name: string;
  readonly text: string;
  readonly features?: readonly string[];
  readonly sessionId?: string;
  readonly expected: PathCompletionResult;
};

const noSendCases: readonly NoSendCase[] = [
  { name: "missing feature", text: "@src", features: [], expected: { kind: "unavailable", feature: PATH_COMPLETION_FEATURE } },
  { name: "empty session", text: "@src", sessionId: "", expected: { kind: "malformed" } },
  { name: "unpaired high surrogate", text: "@\ud800", expected: { kind: "malformed" } },
  { name: "unpaired low surrogate", text: "@\udc00", expected: { kind: "malformed" } },
  { name: "4,097 UTF-8 bytes", text: `${"é".repeat(2048)}a`, expected: { kind: "malformed" } },
];

test.each(noSendCases)("completePath does not send for $name", async (row) => {
  const { client, calls } = clientFor(result(), row.features);
  expect(await completePath(client, row.sessionId ?? "session-1", row.text)).toEqual(row.expected);
  expect(calls).toHaveLength(0);
});

test("completePath sends exactly 4,096 multibyte UTF-8 bytes", async () => {
  const boundaryText = "é".repeat(2048);
  const boundary = clientFor(result([], false));
  await expect(completePath(boundary.client, "session-1", boundaryText)).resolves.toEqual({ kind: "entries", entries: [], truncated: false });
  expect(boundary.calls).toEqual([["path_complete", { session_id: "session-1", text_before_cursor: boundaryText }, undefined]]);
});

// These are deliberately malformed variants of the Zeta 2c378ecb result documented at docs/serve-protocol.md:1570-1577.
const malformedReplies: readonly [string, unknown][] = [
  ["null envelope", null],
  ["array envelope", []],
  ["missing entries", { truncated: false }],
  ["non-array entries", { entries: {}, truncated: false }],
  ["missing truncated", { entries: [] }],
  ["non-boolean truncated", { entries: [], truncated: 0 }],
  ["non-object row", result([null])],
  ["bad text", result([{ ...entry, text: 1 }])],
  ["bad display", result([{ ...entry, display: null }])],
  ["bad kind", result([{ ...entry, kind: "symlink" }])],
  ["positive position", result([{ ...entry, start_position: 1 }])],
  ["position beyond code points", result([{ ...entry, start_position: -4 }])],
  ["fractional position", result([{ ...entry, start_position: -1.5 }])],
  ["unsafe position", result([{ ...entry, start_position: Number.MIN_SAFE_INTEGER - 1 }])],
];

test.each(malformedReplies)("completePath rejects malformed reply: %s", async (_name, reply) => {
  const { client, calls } = clientFor(reply);
  expect(await completePath(client, "session-1", "abc")).toEqual({ kind: "malformed" });
  expect(calls).toHaveLength(1);
});

// Zeta 2c378ecb docs/serve-protocol.md:1578-1582,1745,1761-1767 define these RPC codes.
const rpcError = (code: number) => Object.assign(new Error(`rpc ${code}`), { code });

const rpcMappings = [
  [-32601, { kind: "unavailable", feature: PATH_COMPLETION_FEATURE }],
  [-32008, { kind: "observer" }],
  [-32602, { kind: "malformed" }],
] as const;

test.each(rpcMappings)("completePath maps RPC code %i without retry", async (code, expected) => {
  const calls: string[] = [];
  const client: PathCompletionClient = {
    features: [PATH_COMPLETION_FEATURE],
    request(method) { calls.push(method); return Promise.reject(rpcError(code)); },
  };
  await expect(completePath(client, "session-1", "@src")).resolves.toEqual(expected);
  expect(calls).toEqual(["path_complete"]);
});

const unchangedErrors = [rpcError(-32003), rpcError(-32004), new Error("disconnect")];
test.each(unchangedErrors)("completePath rejects $message unchanged without retry", async (error) => {
  let calls = 0;
  const client: PathCompletionClient = {
    features: [PATH_COMPLETION_FEATURE],
    request() { calls++; return Promise.reject(error); },
  };
  expect(await completePath(client, "session-1", "@src").catch((caught) => caught)).toBe(error);
  expect(calls).toBe(1);
});

test("completePath rejects aborts before send and releases an aborted pending request", async () => {
  const before = new AbortController();
  before.abort();
  const notSent = clientFor(result());
  const beforeError = await completePath(notSent.client, "session-1", "@src", { signal: before.signal }).catch((error) => error);
  expect(beforeError).toMatchObject({ name: "AbortError" });
  expect(notSent.calls).toHaveLength(0);

  const during = new AbortController();
  let pending = 0;
  let calls = 0;
  const client: PathCompletionClient = {
    features: [PATH_COMPLETION_FEATURE],
    request(_method, _params, options) {
      calls++;
      pending++;
      return new Promise((_resolve, reject) => {
        const abort = () => {
          pending--;
          reject(Object.assign(new Error("request aborted"), { name: "AbortError" }));
        };
        options?.signal?.addEventListener("abort", abort, { once: true });
      });
    },
  };
  const request = completePath(client, "session-1", "@src", { signal: during.signal });
  expect(pending).toBe(1);
  during.abort();
  expect(await request.catch((error) => error)).toMatchObject({ name: "AbortError" });
  expect({ calls, pending }).toEqual({ calls: 1, pending: 0 });
});

type ZetaClientSatisfiesPathCompletionClient = ZetaClient extends PathCompletionClient ? true : false;
const zetaClientSatisfiesPathCompletionClient: ZetaClientSatisfiesPathCompletionClient = true;
void zetaClientSatisfiesPathCompletionClient;
