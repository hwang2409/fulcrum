import { expect, test } from "bun:test";
import { createStreamingDocument, parseMarkdown, type Block, type Inline } from "../src/index.js";
import { PendingInline } from "../src/pending-inline.js";
import { expectSinglePublicationLocation } from "./publication-reachability.js";

const inlineText = (nodes: readonly Inline[]): string => nodes.map((node) =>
  node.type === "text" || node.type === "code" ? node.value
    : node.type === "break" ? "\n"
      : node.type === "image" ? node.alt
        : "children" in node ? inlineText(node.children) : "",
).join("");

const paragraph = (blocks: readonly Block[]) => blocks[0]?.type === "paragraph" ? blocks[0].children : [];

const richLine = () => {
  const shapes = [(n: string) => `${n} `, (n: string) => `**${n}** `, (n: string) => `*${n}* `, (n: string) => `\`${n}\` `,
    (n: string) => `[${n}](https://e.com/u) `, (n: string) => `**${n} `, (n: string) => `${n}** `, (n: string) => `*${n} `,
    (n: string) => `\`${n} `, (n: string) => `${n}\` `, (n: string) => `snake_${n} `, (n: string) => `${n} * x `,
    (n: string) => `<https://e.com/${n}> `, (n: string) => `👍${n} `, (n: string) => `[${n} `, (n: string) => `${n}] `];
  let state = 7;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  const length = 200 + Math.floor(random() * 1_500);
  let source = "";
  for (let word = 0; source.length < length; word++) source += shapes[Math.floor(random() * shapes.length)]!(`q${word}z`);
  return source;
};

test("plain intervals are owned before a later opener", () => {
  const source = richLine();
  const document = createStreamingDocument();
  for (let offset = 0; offset < source.length; offset++) {
    document.append(source[offset]!);
    const frame = document.render();
    expectSinglePublicationLocation(frame, `seed-7 offset ${offset + 1}`);
    const ids = [...inlineText(paragraph(frame)).matchAll(/q(\d+)z/g)].map((match) => Number(match[1]));
    expect(ids.every((id, index) => index === 0 || id > ids[index - 1]!), `offset ${offset + 1}: ${ids.join(",")}`).toBe(true);
    if (offset + 1 >= 220 && source.slice(0, offset + 1).includes("q27z")) expect(ids, `q27z at offset ${offset + 1}`).toContain(27);
  }
});

test("live view does not parse or scan owned source", () => {
  let parserBytes = 0;
  let parserCalls = 0;
  const pending = new PendingInline((source) => {
    parserBytes += source.length;
    parserCalls++;
    return source ? [{ type: "text", value: source }] : [];
  });
  const source = `${"plain words ".repeat(80)}*open ${"tail ".repeat(80)}`;
  for (const character of source) pending.append(character);
  const before = { parserBytes, parserCalls, stats: { ...pending.delimiterStats } };
  void pending.nodes;
  void pending.nodes;
  expect(parserCalls, "view parser calls").toBe(before.parserCalls);
  expect(parserBytes, "view parser bytes").toBe(before.parserBytes);
  expect(parserBytes, "each immutable leaf range is parsed once").toBeLessThanOrEqual(source.length * 2);
  expect((pending.delimiterStats as typeof pending.delimiterStats & { sourceScanned?: number }).sourceScanned, "sole scan cursor is observable").toBeDefined();
});

test("an unmatched multiline code owner keeps literal checkpoints and converts the same tail", () => {
  const document = createStreamingDocument();
  document.append("`a  \n");
  expectSinglePublicationLocation(document.render(), "unmatched line checkpoint");
  expect(paragraph(document.render()), "unmatched line checkpoint").toEqual([
    { type: "text", value: "`a" },
    { type: "break" },
  ]);

  document.append("b`");
  expectSinglePublicationLocation(document.render(), "matching closer");
  expect(paragraph(document.render()), "matching closer converts the owner").toEqual([{ type: "code", value: "a   b" }]);
  expect(document.render()).toEqual(parseMarkdown("`a  \nb`"));
});

test("a nested literal code span disappears into its outer code owner without duplication", () => {
  const document = createStreamingDocument();
  document.append("``a  \n");
  expectSinglePublicationLocation(document.render(), "outer code line one");
  expect(paragraph(document.render()), "line one").toEqual([
    { type: "text", value: "``a" },
    { type: "break" },
  ]);

  document.append("`b`\n");
  expectSinglePublicationLocation(document.render(), "outer code line two");
  expect(paragraph(document.render()), "inner literal role").toEqual([
    { type: "text", value: "``a" },
    { type: "break" },
    { type: "code", value: "b" },
    { type: "break" },
  ]);

  document.append("  c``");
  expectSinglePublicationLocation(document.render(), "outer code close");
  expect(paragraph(document.render()), "outer conversion").toEqual([{ type: "code", value: "a   `b`   c" }]);
  expect(document.render()).toEqual(parseMarkdown("``a  \n`b`\n  c``"));
});
