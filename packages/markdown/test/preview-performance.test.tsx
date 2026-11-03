import { expect, test } from "bun:test";
import { createStreamingDocument } from "../src/index.js";
import { PENDING_INLINE_SUFFIX_BUDGET } from "../src/resolver.js";

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

test("frozen blocks retain identity while only the open path is rebuilt", () => {
  const document = createStreamingDocument();
  document.append("frozen\n\nopen\nnext");
  const frozen = document.render()[0];
  document.append(" grows");
  expect(document.render()[0]).toBe(frozen);
});
