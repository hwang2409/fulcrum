import { expect, test } from "bun:test";
import { createStreamingDocument } from "../src/index.js";
import { PENDING_INLINE_SUFFIX as PENDING_INLINE_SUFFIX_BUDGET } from "../src/pending-inline.js";

function streamPending(source: string, chunkSize: number) {
  const document = createStreamingDocument();
  for (let offset = 0; offset < source.length; offset += chunkSize) {
    document.append(source.slice(offset, offset + chunkSize));
    document.render();
  }
  return document;
}

test("pending preview work scales with delta at depth 50", () => {
  const prefix = "> ".repeat(50);
  const smallSource = prefix + "a".repeat(100_000 - prefix.length);
  const largeSource = prefix + "a".repeat(1_000_000 - prefix.length);
  const small = streamPending(smallSource, 16_384);
  const large = streamPending(largeSource, 16_384);

  expect(small.stats.previewScannedCharacters).toBeLessThanOrEqual(smallSource.length + Math.ceil(smallSource.length / 16_384) * PENDING_INLINE_SUFFIX_BUDGET);
  expect(large.stats.previewScannedCharacters).toBeLessThanOrEqual(largeSource.length + Math.ceil(largeSource.length / 16_384) * PENDING_INLINE_SUFFIX_BUDGET);
  expect(large.stats.previewScannedCharacters / small.stats.previewScannedCharacters).toBeLessThan(10.1);
  expect(large.render()[0]?.type).toBe("paragraph");
});

test("line classification stays correct at one-character boundaries", () => {
  for (const source of [
    "leading spaces\n  continuation",
    "- item\ncontinuation",
    "# heading\ncontinuation",
    "> quote\ncontinuation",
    "1. item\ncontinuation",
    "```ts\ncode\n```\ncontinuation",
    "| name | value |\n| --- | --- |\n| one | two |",
  ]) {
    const expected = createStreamingDocument();
    expected.append(source);
    expected.finish();
    const actual = createStreamingDocument();
    for (const character of source) {
      actual.append(character);
      actual.render();
    }
    actual.finish();
    expect(JSON.stringify(actual.render())).toBe(JSON.stringify(expected.render()));
  }
});

test("reference-definition candidate scans only new characters", () => {
  const measure = (source: string) => {
    const document = createStreamingDocument();
    for (let offset = 0; offset < source.length; offset += 64) {
      document.append(source.slice(offset, offset + 64));
      document.render();
    }
    return document.stats.referenceCandidateScannedCharacters;
  };
  const open = measure(`[${"*a ".repeat(100_000)}`);
  const closedTail = measure(`[label]${"x".repeat(300_000)}`);
  expect(open).toBeLessThan(400_000);
  expect(closedTail).toBeLessThan(400_000);
});

test("continuation preview stays linear as the line grows", () => {
  const measure = () => {
    const document = createStreamingDocument();
    const line = "word **b** `c` and more ".repeat(16_000);
    document.append("first paragraph\n");
    const start = Number(process.hrtime.bigint()) / 1e6;
    const times: number[] = [];
    for (let offset = 0; offset < 384_000; offset += 64) {
      document.append(line.slice(offset, offset + 64));
      document.render();
      if (offset + 64 === 96_000 || offset + 64 === 192_000 || offset + 64 === 384_000)
        times.push(Number(process.hrtime.bigint()) / 1e6 - start);
    }
    return times as [number, number, number];
  };
  measure();
  const samples = Array.from({ length: 7 }, measure);
  const median = (values: number[]) => values.sort((a, b) => a - b)[3]!;
  expect(median(samples.map(([small, medium]) => medium / small))).toBeLessThanOrEqual(2.3);
  expect(median(samples.map(([, medium, large]) => large / medium))).toBeLessThanOrEqual(2.3);
}, 30_000);

test("frozen blocks retain identity while only the open path is rebuilt", () => {
  const document = createStreamingDocument();
  document.append("frozen\n\nopen\nnext");
  const frozen = document.render()[0];
  document.append(" grows");
  expect(document.render()[0]).toBe(frozen);
});
