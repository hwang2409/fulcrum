import { expect, test } from "bun:test";
import { createRunStore, type TextChunk, type TextSourceSnapshot } from "../src/index.js";
import { findText, type TextFindOptions, type TextFindSource, type TextFindUpdate, type TextMatch } from "../src/text.js";
import { fold } from "../src/fold.js";

/** A source made of `parts` laid end to end, each one chunk; a `null` part is an omitted gap of 10 units. */
function sourceOf(parts: Array<string | null>, protocolTruncated = false): TextFindSource {
  const chunks: TextChunk[] = [];
  let start = 0;
  let line = 0;
  let omitted = false;
  for (const part of parts) {
    if (part === null) {
      start += 10;
      line += 1;
      omitted = true;
      continue;
    }
    chunks.push({ start, line, text: part });
    start += part.length;
    line += part.split("\n").length - 1;
  }
  return {
    chunks: () => chunks.values(),
    omission: omitted ? { kind: "omitted", reason: "item-cap", start: 0, end: 0, bytes: 0, whole: false } : null,
    protocolTruncated,
  };
}
async function collect(source: TextFindSource, query: string, options?: TextFindOptions) {
  const updates: TextFindUpdate[] = [];
  for await (const update of findText(source, query, options)) updates.push(update);
  return { updates, matches: updates.flatMap((update) => update.matches), last: updates.at(-1)! };
}
/** The reference: the whole text folded at once, non-overlapping matches left to right. */
function reference(text: string, query: string): TextMatch[] {
  const { folded, starts, ends } = fold(text);
  const needle = fold(query).folded;
  const out: TextMatch[] = [];
  for (let index = folded.indexOf(needle); index >= 0; index = folded.indexOf(needle, index + needle.length)) {
    const start = starts[index]!;
    out.push({ start, end: ends[index + needle.length - 1]!, line: text.slice(0, start).split("\n").length - 1 });
  }
  return out;
}

test("matches across every chunk edge equal one search of the whole text, with length-changing folds", async () => {
  // ß folds to "ss", İ to "i̇" (two units), 𝐀 is a surrogate pair, the Kelvin sign folds to k.
  const text = "a\nStraße STRASSE\nİstanbul i̇stanbul 𝐀𝐁 KELVIN\nstrasse";
  for (const query of ["strasse", "SS", "i̇stanbul", "𝐀𝐁", "kelvin", "n\nstr", "s"]) {
    const expected = reference(text, query);
    expect(expected.length).toBeGreaterThan(0);
    for (let cut = 1; cut < text.length; cut++) {
      // Never split a surrogate pair: chunks of a real source never do.
      if (/[\uDC00-\uDFFF]/.test(text[cut]!)) continue;
      const { matches } = await collect(sourceOf([text.slice(0, cut), text.slice(cut)]), query);
      expect({ query, cut, matches }).toEqual({ query, cut, matches: expected });
    }
  }
});

test("a match maps to original UTF-16 units and lines in a piece-split chunk", async () => {
  // One chunk far longer than a work piece: matches straddle the internal piece edges too.
  const unit = "ßeta x\n";
  const text = unit.repeat(5_000);
  const { matches } = await collect(sourceOf([text]), "SSeta");
  expect(matches).toEqual(reference(text, "SSeta"));
  expect(matches.length).toBe(5_000);
  expect(matches[4_999]).toEqual({ start: 4_999 * unit.length, end: 4_999 * unit.length + 4, line: 4_999 });
});

test("case-sensitive find does not fold", async () => {
  const { matches } = await collect(sourceOf(["Abc abc ABC"]), "abc", { caseSensitive: true });
  expect(matches).toEqual([{ start: 4, end: 7, line: 0 }]);
});

test("a match never spans an omission", async () => {
  const { matches, last } = await collect(sourceOf(["xx abc", null, "def yy"]), "cde");
  expect(matches).toEqual([]);
  expect(last).toMatchObject({ done: true, complete: false, capped: false });
  // Each side still matches, at its logical offset past the gap.
  const both = await collect(sourceOf(["xx abc", null, "def yy"]), "de");
  expect(both.matches).toEqual([{ start: 16, end: 18, line: 1 }]);
});

test("updates are deltas of at most 256 matches", async () => {
  const text = "ab ".repeat(3_000);
  const { updates, matches } = await collect(sourceOf([text]), "ab");
  expect(updates.every((update) => update.matches.length <= 256)).toBe(true);
  expect(updates.filter((update) => update.done).length).toBe(1);
  expect(updates.at(-1)!.done).toBe(true);
  expect(updates.slice(0, -1).every((update) => !update.done && !update.complete && !update.capped)).toBe(true);
  expect(matches).toEqual(reference(text, "ab"));
  expect(new Set(matches.map((match) => match.start)).size).toBe(3_000);
  expect(updates.at(-1)!.scanned).toBe(text.length);
});

test("a large scan yields at least every 256 KiB of text", async () => {
  const chunk = "x".repeat(32 * 1024);
  const { updates } = await collect(sourceOf(Array.from({ length: 64 }, () => chunk)), "needle");
  expect(updates.length).toBeGreaterThanOrEqual(8);
  for (let index = 1; index < updates.length; index++) expect(updates[index]!.scanned - updates[index - 1]!.scanned).toBeLessThanOrEqual(256 * 1024);
});

test("final facts: complete, omitted, protocol-truncated, capped, exactly at the limit, empty query", async () => {
  const done = async (source: TextFindSource, query: string, options?: TextFindOptions) => (await collect(source, query, options)).last;
  expect(await done(sourceOf(["a a a"]), "a")).toMatchObject({ done: true, complete: true, capped: false });
  expect(await done(sourceOf(["a a", null, "a"]), "a")).toMatchObject({ done: true, complete: false, capped: false });
  expect(await done(sourceOf(["a a a"], true), "a")).toMatchObject({ done: true, complete: false, capped: false });
  const capped = await collect(sourceOf(["a a a"]), "a", { limit: 2 });
  expect(capped.matches.length).toBe(2);
  expect(capped.last).toMatchObject({ done: true, complete: false, capped: true });
  const exact = await collect(sourceOf(["a a a"]), "a", { limit: 3 });
  expect(exact.matches.length).toBe(3);
  expect(exact.last).toMatchObject({ done: true, complete: true, capped: false });
  const empty = await collect(sourceOf(["a a a"]), "");
  expect(empty.updates).toEqual([{ matches: [], scanned: 0, done: true, complete: true, capped: false }]);
  expect((await collect(sourceOf(["a", null]), "")).last.complete).toBe(false);
});

test("a real cut source: matches keep logical offsets and lines past the cut", async () => {
  const store = createRunStore((flush) => flush(), { toolOutputItemBytes: 4 * 1024 });
  const tool_call = { id: "t", name: "shell", arguments: {} };
  const lines = Array.from({ length: 2_000 }, (_, index) => `line ${index} marker\n`).join("");
  store.dispatch({ type: "tool_output", tool_call, output: lines });
  const item = store.getItem("tool:t");
  if (item?.type !== "tool") throw new Error("missing tool");
  const source: TextSourceSnapshot = item.output;
  expect(source.omission).not.toBeNull();
  const { matches, last } = await collect(source, "MARKER");
  const { start, end } = source.omission!;
  const expected = reference(lines, "marker").filter((match) => match.end <= start || match.start >= end);
  expect(expected.length).toBeGreaterThan(100);
  expect(matches).toEqual(expected);
  expect(matches.at(-1)).toMatchObject({ line: 1_999 });
  expect(last.complete).toBe(false);
});

test("queries over 64 KiB of UTF-8 and bad limits throw before scanning", () => {
  const source = sourceOf(["text"]);
  expect(() => findText(source, "é".repeat(33_000))).toThrow(RangeError); // 33,000 units, 66,000 bytes
  expect(() => findText(source, "x".repeat(64 * 1024))).not.toThrow();
  expect(() => findText(source, "x", { limit: 0 })).toThrow(RangeError);
  expect(() => findText(source, "x", { limit: 1.5 })).toThrow(RangeError);
});

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";
// 10 MiB of retained text, as a whole run's tool outputs hold at the run cap.
const runWide = () => sourceOf(Array.from({ length: 320 }, (_, index) => `${String(index).padStart(8, "0")}${"y".repeat(32 * 1024 - 9)}\n`));

test("abort before start rejects the first step and leaves nothing running", async () => {
  const controller = new AbortController();
  controller.abort();
  const iterator = findText(runWide(), "y", { signal: controller.signal })[Symbol.asyncIterator]();
  const error = await iterator.next().then(() => undefined, (reason: unknown) => reason);
  expect(isAbort(error)).toBe(true);
  expect(await iterator.next()).toEqual({ done: true, value: undefined });
});

test("abort during a 10 MiB scan, between updates, and while a step waits: AbortError, no stale update", async () => {
  // Between updates: abort after an update arrived, before asking for the next.
  {
    const controller = new AbortController();
    const iterator = findText(runWide(), "yyyy", { signal: controller.signal })[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value.done).toBe(false);
    controller.abort();
    const error = await iterator.next().then(() => undefined, (reason: unknown) => reason);
    expect(isAbort(error)).toBe(true);
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  }
  // While a step waits for its next task: the pending step rejects; it never resolves with an update.
  {
    const controller = new AbortController();
    const iterator = findText(runWide(), "00000100", { signal: controller.signal })[Symbol.asyncIterator]();
    await iterator.next();
    const step = iterator.next();
    controller.abort();
    const error = await step.then((value) => value, (reason: unknown) => reason);
    expect(isAbort(error)).toBe(true);
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  }
  // During a for-await consumer: the loop ends with AbortError after the abort and receives no update past it.
  {
    const controller = new AbortController();
    let after = 0;
    let aborted = false;
    const error = await (async () => {
      for await (const _ of findText(runWide(), "y", { signal: controller.signal, limit: 1_000_000 })) {
        if (aborted) after++;
        if (!aborted) { controller.abort(); aborted = true; }
      }
    })().then(() => undefined, (reason: unknown) => reason);
    expect(isAbort(error)).toBe(true);
    expect(after).toBe(0);
  }
});
