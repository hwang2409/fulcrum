import { expect, test } from "bun:test";
import { applyToolMap, defineToolMap, lineDiff, resolveToolView, type RunItem, type ToolCall } from "../src/index.js";

const claudeCode = defineToolMap({
  Bash: (args) => {
    const command = args.string("command");
    return command ? { kind: "shell", command } : undefined;
  },
  Read: (args) => {
    const path = args.string("file_path");
    return path ? { kind: "read", path } : undefined;
  },
  Edit: (args) => {
    const path = args.string("file_path");
    const oldText = args.string("old_string");
    const newText = args.string("new_string");
    return path && oldText !== undefined && newText !== undefined
      ? { kind: "edit", path, diff: lineDiff(oldText, newText) }
      : undefined;
  },
});

const call = (name: string, arguments_: Record<string, unknown>): ToolCall => ({ id: "1", name, arguments: arguments_ });

test("a non-zeta harness maps its own tool names", () => {
  expect(resolveToolView(claudeCode, call("Bash", { command: "pwd" }))).toEqual({ kind: "shell", command: "pwd" });
  expect(resolveToolView(claudeCode, call("Read", { file_path: "README.md" }))).toEqual({ kind: "read", path: "README.md" });
  expect(resolveToolView(claudeCode, call("Edit", { file_path: "a.ts", old_string: "old", new_string: "new" }))).toEqual({
    kind: "edit",
    path: "a.ts",
    diff: "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file",
  });
});

test("invalid arguments and resolver errors produce no view", () => {
  expect(resolveToolView(claudeCode, call("Bash", { command: 42 }))).toBeUndefined();
  expect(resolveToolView(claudeCode, call("Unknown", {}))).toBeUndefined();
  const unsafe = defineToolMap({ Broken: () => { throw new Error("bad input"); } });
  expect(resolveToolView(unsafe, call("Broken", {}))).toBeUndefined();
});

test("applyToolMap adds a hint without mutating the tool item", () => {
  const item: Extract<RunItem, { type: "tool" }> = {
    id: "tool:1", type: "tool", tool_call: call("Bash", { command: "pwd" }), output: "", version: 1,
    active: true, is_error: false, canceled: false,
  };
  const mapped = applyToolMap(claudeCode, item);
  expect(mapped).not.toBe(item);
  expect(mapped.view).toEqual({ kind: "shell", command: "pwd" });
  expect(item.view).toBeUndefined();
});

test("lineDiff writes conventional hunks and preserves final newlines", () => {
  expect(lineDiff("a\nb\nc", "a\nB\nc")).toBe("@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n\\ No newline at end of file");
  expect(lineDiff("keep\n", "keep\nmore\n")).toBe("@@ -1 +1,2 @@\n keep\n+more");
  expect(lineDiff("", "new")).toBe("@@ -0,0 +1 @@\n+new\n\\ No newline at end of file");
  expect(lineDiff("x\ny", "")).toBe("@@ -1,2 +0,0 @@\n-x\n-y\n\\ No newline at end of file");
  expect(lineDiff("a\n", "a")).toBe("@@ -1 +1 @@\n-a\n+a\n\\ No newline at end of file");
  expect(lineDiff("a", "a\n")).toBe("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a");

  const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const after = [...before];
  after[1] = "changed 2";
  after[17] = "changed 18";
  expect(lineDiff(before.join("\n") + "\n", after.join("\n") + "\n")).toBe([
    "@@ -1,5 +1,5 @@", " line 1", "-line 2", "+changed 2", " line 3", " line 4", " line 5",
    "@@ -15,6 +15,6 @@", " line 15", " line 16", " line 17", "-line 18", "+changed 18", " line 19", " line 20",
  ].join("\n"));
});

const applyDiff = (before: string, diff: string) => {
  const ending = /^\\ Line endings changed from (CRLF|LF) to (CRLF|LF)(?:\n|$)/.exec(diff);
  if (ending) {
    before = ending[1] === "CRLF" ? before.replaceAll("\r\n", "\n") : before;
    diff = diff.slice(ending[0].length);
  }
  const old = before === "" ? [] : before.split("\n").map((text) => ({ text, newline: true }));
  if (before.endsWith("\n")) old.pop();
  else if (old.length) old.at(-1)!.newline = false;
  const result: Array<{ text: string; newline: boolean }> = [];
  let oldIndex = 0;
  let previous = "";
  for (const line of diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@$/.exec(line);
    if (header) {
      const start = Number(header[1]) - (Number(header[2] ?? 1) === 0 ? 0 : 1);
      result.push(...old.slice(oldIndex, start));
      oldIndex = start;
    } else if (line.startsWith(" ")) result.push({ ...old[oldIndex++]! });
    else if (line.startsWith("-")) oldIndex++;
    else if (line.startsWith("+")) result.push({ text: line.slice(1), newline: true });
    else if (line === "\\ No newline at end of file" && (previous.startsWith("+") || previous.startsWith(" "))) result.at(-1)!.newline = false;
    previous = line;
  }
  result.push(...old.slice(oldIndex));
  const value = result.map((line) => line.text + (line.newline ? "\n" : "")).join("");
  return ending?.[2] === "CRLF" ? value.replaceAll("\n", "\r\n") : value;
};

test("lineDiff hunks reconstruct 5,000 randomized texts", () => {
  let seed = 0x5eed;
  const random = () => ((seed = (seed * 1_664_525 + 1_013_904_223) >>> 0) / 2 ** 32);
  for (let trial = 0; trial < 5_000; trial++) {
    const length = trial % 500 === 0 ? 400 : Math.floor(random() * 30);
    const before = Array.from({ length }, (_, index) => length > 30 ? `unique ${index}` : String.fromCharCode(97 + Math.floor(random() * 6)));
    const after = [...before];
    const edits = length > 30 ? 80 : 1 + Math.floor(random() * 6);
    for (let edit = 0; edit < edits; edit++) {
      const at = Math.floor(random() * (after.length + 1));
      if (random() < 0.5 && after.length) after.splice(Math.min(at, after.length - 1), 1);
      else after.splice(at, 0, `added ${trial} ${edit} ${Math.floor(random() * 6)}`);
    }
    const oldText = before.join("\n") + (before.length && random() < 0.5 ? "\n" : "");
    const newText = after.join("\n") + (after.length && random() < 0.5 ? "\n" : "");
    expect(applyDiff(oldText, lineDiff(oldText, newText))).toBe(newText);
  }
});

test("lineDiff anchors scattered replacements and moved blocks", () => {
  const before = Array.from({ length: 3_000 }, (_, index) => `line ${index}`);
  const after = [...before];
  for (let index = 5; index < 3_000; index += 10) after[index] = `changed ${index}`;
  const scattered = lineDiff(`${before.join("\n")}\n`, `${after.join("\n")}\n`);
  expect(scattered.match(/^@@/gm)).toHaveLength(300);
  expect(scattered.split("\n").filter((line) => line.startsWith("-"))).toHaveLength(300);
  expect(applyDiff(`${before.join("\n")}\n`, scattered)).toBe(`${after.join("\n")}\n`);

  const first = Array.from({ length: 500 }, (_, index) => `first ${index}`);
  const second = Array.from({ length: 500 }, (_, index) => `second ${index}`);
  const movedBefore = `${[...first, ...second].join("\n")}\n`;
  const movedAfter = `${[...second, ...first].join("\n")}\n`;
  const moved = lineDiff(movedBefore, movedAfter);
  expect(moved.split("\n").filter((line) => line.startsWith("-"))).toHaveLength(500);
  expect(moved.split("\n").filter((line) => line.startsWith("+"))).toHaveLength(500);
  expect(applyDiff(movedBefore, moved)).toBe(movedAfter);
});

test("lineDiff normalizes whole-file line endings with a visible note", () => {
  const before = `${Array.from({ length: 3_000 }, (_, index) => `line ${index}`).join("\r\n")}\r\n`;
  const after = before.replaceAll("\r\n", "\n");
  const diff = lineDiff(before, after);
  expect(diff).toBe("\\ Line endings changed from CRLF to LF");
  expect(applyDiff(before, diff)).toBe(after);
});

test("lineDiff fallback reports every changed line", () => {
  const before = Array.from({ length: 1_000 }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: 1_000 }, (_, i) => `new ${i}`).join("\n");
  const diff = lineDiff(before, after);
  expect(diff.split("\n").filter((line) => line.startsWith("-"))).toHaveLength(1_000);
  expect(diff.split("\n").filter((line) => line.startsWith("+"))).toHaveLength(1_000);
  expect(applyDiff(before, diff)).toBe(after);
});

test("lineDiff stays bounded on pathological repeated and shuffled lines", () => {
  const repeated = `${Array.from({ length: 10_000 }, () => "same").join("\n")}\n`;
  expect(lineDiff(repeated, repeated)).toBe("");
  const unique = Array.from({ length: 10_000 }, (_, index) => `unique ${index}`);
  const before = `${unique.join("\n")}\n`;
  const after = `${unique.reverse().join("\n")}\n`;
  const started = performance.now();
  const diff = lineDiff(before, after);
  expect(performance.now() - started).toBeLessThan(100);
  expect(applyDiff(before, diff)).toBe(after);
});

test("lineDiff stays within a generous CI budget on large sparse edits", () => {
  const cases: Array<[string[], string[]]> = [];
  const scatteredBefore = Array.from({ length: 3_000 }, (_, i) => `line ${i}`);
  const scatteredAfter = [...scatteredBefore];
  for (let index = 5; index < 3_000; index += 10) scatteredAfter[index] = `changed ${index}`;
  cases.push([scatteredBefore, scatteredAfter]);
  const sparseBefore = Array.from({ length: 10_000 }, (_, i) => `line ${i}`);
  const sparseAfter = [...sparseBefore];
  sparseAfter[20] = "changed near start";
  sparseAfter[9_980] = "changed near end";
  cases.push([sparseBefore, sparseAfter]);

  for (const [before, after] of cases) {
    const started = performance.now();
    const diff = lineDiff(`${before.join("\n")}\n`, `${after.join("\n")}\n`);
    expect(performance.now() - started).toBeLessThan(100);
    expect(applyDiff(`${before.join("\n")}\n`, diff)).toBe(`${after.join("\n")}\n`);
  }
});
