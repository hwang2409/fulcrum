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

test("continuation preview stays near-linear as the line grows", () => {
  const measure = (length: number) => {
    const document = createStreamingDocument();
    const source = "first paragraph\n" + "word **b** `c` and more ".repeat(Math.ceil(length / 24)).slice(0, length);
    const start = performance.now();
    for (let offset = 0; offset < source.length; offset += 64) {
      document.append(source.slice(offset, offset + 64));
      document.render();
    }
    return performance.now() - start;
  };
  const samples = Array.from({ length: 3 }, () => [measure(48_000), measure(192_000)] as const);
  const ratios = samples.map(([small, large]) => large / Math.max(small, 0.1)).sort((a, b) => a - b);
  expect(ratios[1]!).toBeLessThan(7.5);
});

test("frozen blocks retain identity while only the open path is rebuilt", () => {
  const document = createStreamingDocument();
  document.append("frozen\n\nopen\nnext");
  const frozen = document.render()[0];
  document.append(" grows");
  expect(document.render()[0]).toBe(frozen);
});
