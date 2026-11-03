import { createStreamingDocument, parseMarkdown, type Block, type Inline } from "../src/index.js";

type Random = () => number;
type FuzzFailure = { source: string; splitSeed: number; reason: string };
export type FuzzStats = { eofReferences: number; visibilityFailures: number };

const fixedLeaves = [
  "plain **strong** *emphasis* ~~strike~~ `code` and AT&amp;T.",
  "# heading",
  "setext heading\n===",
  "---",
  "```ts\nconst value = '<safe>';\n```",
  "~~~sh\nprintf safe\n~~~",
  "| check | result |\n| :--- | ---: |\n| package | **passing** |",
  "| one |\n| - |",
  "[shared]: https://example.com/docs\n\nUse [shared].",
  "Use [shared].\n\n[shared]: https://example.com/docs",
  "Use [shared].\n\n[shared]: https://example.com/docs \"inline title\"",
  "Use [shared].\n\n[shared]: https://example.com/docs 'inline title'",
  "Use [shared].\n\n[shared]: https://example.com/docs (inline title)",
  "Use [shared].\n\n[shared]: https://example.com/docs\n\"next title\"",
  "Use [shared].\n\n[shared]: https://example.com/docs\n'next title'",
  "Use [shared].\n\n[shared]: https://example.com/docs\n(next title)",
  "<div class=\"safe\">html-like text</div>",
  "<https://example.com> and <agent@example.com>",
  "line with two spaces  \nhard break and backslash\\\nsecond line",
  "    indented code\n    second line",
  "- [x] complete\n- [ ] pending",
  "3. third\n4. fourth",
] as const;

function random(seed: number): Random {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

const pick = <Value>(rng: Random, values: readonly Value[]) => values[Math.floor(rng() * values.length)]!;

function nest(source: string, depth: number, rng: Random) {
  for (let level = 0; level < depth; level++) {
    const lines = source.split("\n");
    const kind = Math.floor(rng() * 3);
    if (kind === 0) source = lines.map((line) => `> ${line}`).join("\n");
    else {
      const marker = kind === 1 ? "- " : `${1 + Math.floor(rng() * 4)}. `;
      source = lines.map((line, index) => `${index ? " ".repeat(marker.length) : marker}${line}`).join("\n");
    }
  }
  return source;
}

export function generateDocument(index: number, rng: Random) {
  const blocks = 1 + Math.floor(rng() * 4);
  const sources: string[] = [];
  for (let block = 0; block < blocks; block++) {
    const leaf = block === 0 ? fixedLeaves[index % fixedLeaves.length]! : pick(rng, fixedLeaves);
    sources.push(nest(leaf, block === 0 ? index % 9 : Math.floor(rng() * 9), rng));
  }
  let source = sources.join(rng() < 0.35 ? "\n" : "\n\n");
  if (rng() < 0.5) source += "\n";
  if (rng() < 0.08) source += pick(rng, [" ", "   ", "\t"] as const);
  return source;
}

function inlineVisible(nodes: readonly Inline[], includeProvisional = true): string {
  return nodes.map((node) => node.type === "pending-reference" ? includeProvisional ? node.value : ""
    : node.type === "text" || node.type === "code" ? node.value
    : node.type === "image" ? node.alt
    : node.type === "break" ? "\n"
    : inlineVisible(node.children, includeProvisional)).join("");
}

// Line-edge spaces select block indentation or a break style; they are syntax, not rendered characters.
const paragraphVisible = (nodes: readonly Inline[], includeProvisional: boolean) =>
  inlineVisible(nodes, includeProvisional).replace(/(^|\n)[ \t]+/g, "$1").replace(/[ \t]+(?=\n|$)/g, "");

// Table layout owns cell-edge spacing, so only table-cell whitespace is normalized.
const tableCellVisible = (nodes: readonly Inline[], includeProvisional: boolean) =>
  inlineVisible(nodes, includeProvisional).replace(/[ \t\r\n]+/g, " ").trim();

function visible(blocks: readonly Block[], includeProvisional = true): string {
  return blocks.map((block) => block.type === "paragraph" || block.type === "heading"
    ? paragraphVisible(block.children, includeProvisional)
    : block.type === "code" ? block.value
    : block.type === "blockquote" ? visible(block.children, includeProvisional)
    : block.type === "list" ? block.items.map((item) => visible(item.children, includeProvisional)).join("")
    : block.type === "table" ? [...block.header, ...block.rows.flat()].map((cell) => tableCellVisible(cell, includeProvisional)).join("")
    : "").join("");
}

function isSubsequence(needle: string, haystack: string) {
  const wanted = [...needle];
  let offset = 0;
  for (const character of haystack) if (character === wanted[offset]) offset++;
  return offset === wanted.length;
}

function equalValue(active: unknown, expected: unknown, pending: { count: number }, allowPending = false): boolean {
  if (Array.isArray(active) || Array.isArray(expected)) {
    return Array.isArray(active) && Array.isArray(expected) && active.length === expected.length
      && active.every((value, index) => equalValue(value, expected[index], pending, allowPending));
  }
  if (!active || !expected || typeof active !== "object" || typeof expected !== "object") return active === expected;
  const actual = active as Record<string, unknown>;
  const wanted = expected as Record<string, unknown>;
  if (allowPending && actual.type === "pending-reference" && wanted.type === "link" && Array.isArray(wanted.children)
    && inlineVisible(wanted.children as Inline[]) === actual.value) {
    pending.count++;
    return true;
  }
  const actualKeys = Object.keys(actual).filter((key) => key !== "open" && (!allowPending || key !== "tight"));
  const expectedKeys = Object.keys(wanted).filter((key) => key !== "open" && (!allowPending || key !== "tight"));
  return actualKeys.length === expectedKeys.length && actualKeys.every((key) => expectedKeys.includes(key) && equalValue(actual[key], wanted[key], pending, allowPending));
}

const provisionalDefinitionAtEof = (source: string) => {
  let line = source.slice(source.lastIndexOf("\n") + 1);
  for (;;) {
    const marker = /^[ \t]*(?:> ?|(?:[-+*]|\d{1,9}[.)])[ \t]+)/.exec(line)?.[0];
    if (!marker) return /^\s*\[[^\]\n]+\]:[^\n]*$/.test(line);
    line = line.slice(marker.length);
  }
};

function matchesActiveException(active: readonly Block[], expected: readonly Block[], source: string) {
  const pending = { count: 0 };
  return provisionalDefinitionAtEof(source) && equalValue(active, expected, pending, true) && pending.count > 0;
}

function checkSource(source: string, splitSeed: number, stats?: FuzzStats): string | undefined {
  const document = createStreamingDocument();
  const rng = random(splitSeed);
  let previousStableVisible = "";
  try {
    for (let offset = 0; offset < source.length;) {
      const size = 1 + Math.floor(rng() * Math.min(24, source.length - offset));
      document.append(source.slice(offset, offset + size));
      offset += size;
      const rendered = document.render();
      // Block wrappers do not render separator text; table cells alone normalize layout-owned edge whitespace.
      const currentStableVisible = visible(rendered, false);
      if (!isSubsequence(previousStableVisible, currentStableVisible)) {
        if (stats) stats.visibilityFailures++;
        return `visible text disappeared or reordered: ${JSON.stringify(previousStableVisible)} -> ${JSON.stringify(currentStableVisible)}`;
      }
      previousStableVisible = currentStableVisible;
    }
    const active = document.render();
    const expected = parseMarkdown(source);
    if (!isSubsequence(visible(active, false), visible(expected)))
      return `active render reveals non-final text: ${JSON.stringify(active)} != ${JSON.stringify(expected)}`;
    if (!equalValue(active, expected, { count: 0 }) && matchesActiveException(active, expected, source) && stats) stats.eofReferences++;
    document.finish();
    const finished = document.render();
    if (!equalValue(finished, expected, { count: 0 }))
      return `finish differs: ${JSON.stringify(finished)} != ${JSON.stringify(expected)}`;
  } catch (error) {
    return `render threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
  }
}

function minimize(failure: FuzzFailure) {
  let source = failure.source;
  const failureKind = failure.reason.split(":", 1)[0];
  let granularity = 2;
  while (source.length > 1) {
    const size = Math.ceil(source.length / granularity);
    let reduced = false;
    for (let start = 0; start < source.length; start += size) {
      const candidate = source.slice(0, start) + source.slice(start + size);
      const reason = candidate && checkSource(candidate, failure.splitSeed);
      if (reason?.startsWith(failureKind)) {
        source = candidate;
        granularity = Math.max(2, granularity - 1);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= source.length) break;
      granularity = Math.min(source.length, granularity * 2);
    }
  }
  return { source, reason: checkSource(source, failure.splitSeed)! };
}

export function runMarkdownFuzz(seed: number, count: number) {
  const rng = random(seed);
  const stats: FuzzStats = { eofReferences: 0, visibilityFailures: 0 };
  let shortest: FuzzFailure | undefined;
  for (let index = 0; index < count; index++) {
    const source = generateDocument(index, rng);
    const splitSeed = Math.floor(rng() * 0x1_0000_0000) >>> 0;
    const reason = checkSource(source, splitSeed, stats);
    if (reason && (!shortest || source.length < shortest.source.length)) shortest = { source, splitSeed, reason };
  }
  if (shortest) {
    const reduced = minimize(shortest);
    throw new Error(`markdown fuzz failed\nseed: 0x${seed.toString(16)}\nsplit seed: 0x${shortest.splitSeed.toString(16)}\noriginal repro: ${JSON.stringify(shortest.source)}\noriginal failure: ${shortest.reason}\nsmallest repro: ${JSON.stringify(reduced.source)}\n${reduced.reason}`);
  }
  return stats;
}

if (import.meta.main) {
  const count = Number(Bun.argv[2] ?? "10000");
  const seed = Bun.argv[3] ? Number(Bun.argv[3]) : (Date.now() ^ Math.floor(performance.now() * 1000)) >>> 0;
  console.log(`markdown fuzz seed=0x${seed.toString(16)} count=${count}`);
  const stats = runMarkdownFuzz(seed, count);
  console.log(`markdown fuzz passed ${count} documents (provisional eof references=${stats.eofReferences}, visibility failures=${stats.visibilityFailures})`);
}
