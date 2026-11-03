import { createStreamingDocument, parseMarkdown, type Block, type Inline } from "../src/index.js";

type Random = () => number;
type FuzzFailure = { source: string; splitSeed: number; reason: string };
export type FuzzStats = { eofReferences: number; nestedPipeTransitions: number };

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

function inlineVisible(nodes: readonly Inline[]): string {
  return nodes.map((node) => node.type === "text" || node.type === "pending-reference" || node.type === "code"
    ? node.value
    : node.type === "image" ? node.alt
    : node.type === "break" ? "\n"
    : inlineVisible(node.children)).join("");
}

function visible(blocks: readonly Block[]): string {
  return blocks.map((block) => block.type === "paragraph" || block.type === "heading" ? inlineVisible(block.children)
    : block.type === "code" ? block.value
    : block.type === "blockquote" ? visible(block.children)
    : block.type === "list" ? block.items.map((item) => visible(item.children)).join("")
    : block.type === "table" ? [...block.header, ...block.rows.flat()].map(inlineVisible).join("")
    : "").join("").replace(/\s/g, "");
}

function isSubsequence(needle: string, haystack: string) {
  let offset = 0;
  for (const character of haystack) if (character === needle[offset]) offset++;
  return offset === needle.length;
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
  const actualKeys = Object.keys(actual).filter((key) => key !== "open");
  const expectedKeys = Object.keys(wanted).filter((key) => key !== "open");
  return actualKeys.length === expectedKeys.length && actualKeys.every((key) => expectedKeys.includes(key) && equalValue(actual[key], wanted[key], pending, allowPending));
}

const provisionalDefinitionAtEof = (source: string) => /(?:^|\n)(?: {0,3}> ?)*(?: {0,3}(?:[-+*]|\d{1,9}[.)])\s+)?\[[^\]\n]+\]:[^\n]*(?:\n(?: {0,3}> ?)*)?$/.test(source);

function matchesActiveException(active: readonly Block[], expected: readonly Block[], source: string) {
  const pending = { count: 0 };
  return provisionalDefinitionAtEof(source) && equalValue(active, expected, pending, true) && pending.count > 0;
}

function pipeLedContainerLine(source: string) {
  const body = source.endsWith("\n") ? source.slice(0, -1) : source;
  let line = body.slice(body.lastIndexOf("\n") + 1);
  let containers = 0;
  for (;;) {
    const marker = /^(?: {0,3}> ?| {0,3}(?:[-+*]|\d{1,9}[.)])\s+)/.exec(line)?.[0];
    if (!marker) break;
    containers++;
    line = line.slice(marker.length);
  }
  return containers > 0 && line.trimStart().startsWith("|");
}

function matchesNestedPipeTransition(previous: string, current: string, source: string) {
  return previous.includes("|") && pipeLedContainerLine(source)
    && isSubsequence(previous.replaceAll("|", ""), current);
}

function checkSource(source: string, splitSeed: number, stats?: FuzzStats): string | undefined {
  const document = createStreamingDocument();
  const rng = random(splitSeed);
  let previousVisible = "";
  try {
    for (let offset = 0; offset < source.length;) {
      const size = 1 + Math.floor(rng() * Math.min(24, source.length - offset));
      document.append(source.slice(offset, offset + size));
      offset += size;
      const currentVisible = visible(document.render());
      if (!isSubsequence(previousVisible, currentVisible)) {
        if (!matchesNestedPipeTransition(previousVisible, currentVisible, source.slice(0, offset)))
          return `visible text disappeared at offset ${offset}: ${JSON.stringify(previousVisible)} -> ${JSON.stringify(currentVisible)}`;
        if (stats) stats.nestedPipeTransitions++;
      }
      previousVisible = currentVisible;
    }
    const active = document.render();
    const expected = parseMarkdown(source);
    if (!equalValue(active, expected, { count: 0 })) {
      if (!matchesActiveException(active, expected, source))
        return `active render differs: ${JSON.stringify(active)} != ${JSON.stringify(expected)}`;
      if (stats) stats.eofReferences++;
    }
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
  const stats: FuzzStats = { eofReferences: 0, nestedPipeTransitions: 0 };
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
  console.log(`markdown fuzz passed ${count} documents (exceptions: eof-reference=${stats.eofReferences}, nested-pipe-transition=${stats.nestedPipeTransitions})`);
}
