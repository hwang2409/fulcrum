import { expect, test } from "bun:test";

// Keeps host calls behind their owners without a reviewer grep. A host call is a call of a listener, the error sink, or
// a named host callback (per file below). Each must sit inside an owner's body, inside an open `call(` on its line, or
// on a line marked `// host code: outside` (a documented "outside" row of the file's README table).
type Rule = { file: string; owners: string[]; hostCalls: RegExp[] };
const shared = [
  /(?<![\w$.])\w*[lL]istener\(/, // a bare listener call: listener(value)
  /[lL]isteners(?:\.get\([^)]*\)\??)?\.forEach\((?!call\))/, // a listener set iterated by anything but call
  /(?<![\w$.])reportError\(|\bconsole\.(?:error|warn)\(/, // the host's error sink
];
const rules: Rule[] = [
  {
    file: "packages/core/src/store.ts",
    owners: ["call", "sink"],
    hostCalls: [...shared, /(?<![\w$.])onError\(/, /(?<![\w$.])scheduler\(/],
  },
  {
    file: "packages/zeta/src/client.ts",
    owners: ["call", "deliver", "sink"],
    // Store entries rethrow a store listener's error (core README rule 4), so they are host calls here.
    hostCalls: [...shared, /(?<![\w$.])closeError\??\.?\(/, /\.hostCommands!?\(/, /(?<![\w$.])load\(/, /\.(?:dispatch|resync|resyncFailed)\(/],
  },
];

// The line range of `const <name> = ...`, from its first line to the line that closes its first brace.
function ownerLines(lines: string[], name: string): [number, number] {
  const start = lines.findIndex((line) => new RegExp(`^\\s*const ${name} = `).test(line));
  if (start < 0) throw new Error(`owner ${name}() not found`);
  let depth = 0;
  for (let index = start; index < lines.length; index++) {
    for (const char of lines[index]!) depth += char === "{" ? 1 : char === "}" ? -1 : 0;
    if (depth === 0) return [start, index];
  }
  throw new Error(`owner ${name}() never closes`);
}
const insideOpenCall = (before: string) => {
  const at = before.search(/(?<![\w$.])call\((?!.*(?<![\w$.])call\()/);
  if (at < 0) return false;
  let depth = 0;
  for (const char of before.slice(at)) depth += char === "(" ? 1 : char === ")" ? -1 : 0;
  return depth > 0;
};

function violations(source: string, rule: Rule): string[] {
  const lines = source.split("\n");
  const owned = rule.owners.map((name) => ownerLines(lines, name));
  const found: string[] = [];
  lines.forEach((line, index) => {
    if (line.includes("// host code: outside") || owned.some(([start, end]) => index >= start && index <= end)) return;
    const code = line.replace(/\/\/.*$/, "");
    for (const pattern of rule.hostCalls) {
      const match = pattern.exec(code);
      if (match && !insideOpenCall(code.slice(0, match.index))) {
        found.push(`${rule.file}:${index + 1}: host callback invoked outside its owner: \`${code.trim()}\`. ` +
          `Call it through ${rule.owners.filter((name) => name !== "sink").map((name) => `${name}()`).join(" or ")}.`);
        break;
      }
    }
  });
  return found;
}
const read = (rule: Rule) => Bun.file(new URL(`../../../${rule.file}`, import.meta.url)).text();

test.each(rules)("every host callback in $file runs through its owner", async (rule) => {
  expect(violations(await read(rule), rule)).toEqual([]);
});

// The guard's own proof: a direct listener call planted after each owner fails with a message naming the owner.
test.each(rules)("a planted direct listener call in $file fails the guard", async (rule) => {
  const lines = (await read(rule)).split("\n");
  const [, end] = ownerLines(lines, rule.owners.at(-1)!);
  lines.splice(end + 1, 0, "  listeners.forEach((listener) => listener(event));");
  const found = violations(lines.join("\n"), rule);
  expect(found).toHaveLength(1);
  expect(found[0]).toContain(`:${end + 2}: host callback invoked outside its owner`);
  expect(found[0]).toContain("Call it through call()");
});
