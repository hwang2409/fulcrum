import { describe, expect, test } from "bun:test";
import { createStreamingDocument, parseMarkdown } from "../src/index.js";
import { PendingInline, type DelimiterWorkStats } from "../src/pending-inline.js";

const families = [
  ["nested brackets then emphasis", (n: number) => "[".repeat(n) + "a" + "*".repeat(n) + "]x".repeat(n)],
  ["mixed delimiters", (n: number) => "[".repeat(n) + "a" + "*_".repeat(n) + "]x".repeat(n)],
  ["strike delimiters", (n: number) => "[".repeat(n) + "a" + "~~".repeat(n) + "]x".repeat(n)],
  ["image floors", (n: number) => "![q".repeat(n) + "a" + "*".repeat(n) + "]x".repeat(n)],
  ["nested emphasis", (n: number) => "*a ".repeat(n) + "z" + " b*".repeat(n)],
  ["closers across repeated floors", (n: number) => " *[".repeat(n) + "a" + "*".repeat(n) + "b" + "]x".repeat(n)],
] as const;
const counters: Array<keyof DelimiterWorkStats> = ["delimiterRecords", "delimiterVisits", "floorOperations", "slotReads", "slotWrites", "slotShifts"];

const expectedRecords = (source: string) => {
  let records = 0;
  for (const run of source.matchAll(/\*+|_+|~+/g)) records += run[0][0] === "~" ? Math.floor(run[0].length / 2) : run[0].length;
  return records;
};

const streamOneCharacter = (source: string) => {
  const pending = new PendingInline((text) => text ? [{ type: "text", value: text }] : []);
  for (const character of source) pending.append(character);
  return pending.delimiterStats;
};

describe("persistent delimiter owner work", () => {
  for (const [name, sourceAt] of families) test(`${name} stays linear from 1k through 8k records`, () => {
    let previous: DelimiterWorkStats | undefined;
    for (const scale of [1_000, 2_000, 4_000, 8_000]) {
      const source = sourceAt(scale);
      const stats = streamOneCharacter(source);
      const records = expectedRecords(source);
      const floors = (source.match(/\[/g) ?? []).length;
      expect(stats.delimiterRecords, `${name} records at ${scale}`).toBe(records);
      expect(stats.delimiterVisits, `${name} visits at ${scale}`).toBeLessThanOrEqual(12 * records + 8 * floors + 64);
      expect(stats.floorOperations, `${name} floors at ${scale}`).toBeLessThanOrEqual(10 * records + 8 * floors + 64);
      expect(stats.slotReads, `${name} reads at ${scale}`).toBeLessThanOrEqual(12 * records + 8 * floors + 128);
      expect(stats.slotWrites, `${name} writes at ${scale}`).toBeLessThanOrEqual(12 * records + 8 * floors + 128);
      expect(stats.slotShifts, `${name} shifts at ${scale}`).toBe(0);
      if (previous) for (const counter of counters) {
        if (previous[counter] === 0) continue;
        expect(stats[counter] / previous[counter], `${name} ${counter} doubles at ${scale}`).toBeLessThanOrEqual(2.1);
      }
      previous = stats;
    }
    const source = sourceAt(1_000);
    const document = createStreamingDocument();
    document.append(source);
    document.finish();
    expect(JSON.stringify(document.render()), `${name} final tree`).toBe(JSON.stringify(parseMarkdown(source)));
  });
});
