import { expect, test } from "bun:test";
import { createStreamingDocument } from "../src/index.js";
import { PENDING_INLINE_SUFFIX as PENDING_INLINE_SUFFIX_BUDGET } from "../src/pending-inline.js";
import { expectGrowthBelow } from "../../../test-support/scaling.js";

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

function streamContinuation(line: string, from: number, to: number, document = createStreamingDocument()) {
  if (from === 0) document.append("first paragraph\n");
  for (let offset = from; offset < to; offset += 64) {
    document.append(line.slice(offset, offset + 64));
    document.render();
  }
  return document;
}

const continuationLine = "word **b** `c` and more ".repeat(420_000);

test("continuation preview copies a bounded amount per delta at any line length", () => {
  for (const size of [32_000, 1_024_000]) {
    const { copiedCharacters } = streamContinuation(continuationLine, 0, size).stats;
    // Each character is copied once as delta and once when it settles, plus at most the provisional suffix per delta.
    expect(copiedCharacters, `${size} characters`).toBeLessThanOrEqual(2 * size + Math.ceil(size / 64) * PENDING_INLINE_SUFFIX_BUDGET);
  }
});

test("continuation preview delta cost stays flat as the line grows", () => {
  // Times the next 128k of 64-byte deltas on a 32k or an 8,192k line. The size argument spans 256x, so the limit is
  // 256^0.28 = 4.7, but the line lengths the deltas see span only ~86x: the small line restarts every sample and grows
  // 32k -> 160k during its window (mean ~96k), while the large one stays near 8,200k. Measured: clean 0.94-1.19x;
  // a whole-line `lastIndexOf` per delta 19-24x. The limit is near their geometric middle, ~4x from each side.
  // A long window (~50 ms) keeps one scheduler stall a small part of a sample. The large line is built once and
  // each sample continues it; a line is rebuilt only after it doubles, so the small one restarts every sample.
  const window = 128_000;
  const lines = new Map<number, { document: ReturnType<typeof createStreamingDocument>; end: number }>();
  expectGrowthBelow([32_000, 8_192_000], (size) => {
    let line = lines.get(size);
    if (!line || line.end + window > 2 * size) {
      const document = createStreamingDocument();
      document.append("first paragraph\n");
      // Setup arrives in large chunks: same stable state as 64-byte deltas, a fraction of the time.
      for (let offset = 0; offset < size; offset += 16_384) {
        document.append(continuationLine.slice(offset, Math.min(size, offset + 16_384)));
        document.render();
      }
      lines.set(size, line = { document, end: size });
    }
    const from = line.end;
    line.end += window;
    Bun.gc(true);
    return () => streamContinuation(continuationLine, from, from + window, line.document);
  }, { exponent: 0.28, samples: 5 });
}, 60_000);

test("frozen blocks retain identity while only the open path is rebuilt", () => {
  const document = createStreamingDocument();
  document.append("frozen\n\nopen\nnext");
  const frozen = document.render()[0];
  document.append(" grows");
  expect(document.render()[0]).toBe(frozen);
});
