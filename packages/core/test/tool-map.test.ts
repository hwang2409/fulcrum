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
  expect(resolveToolView(claudeCode, call("Edit", { file_path: "a.ts", old_string: "old", new_string: "new" }))).toEqual({ kind: "edit", path: "a.ts", diff: "@@ -1 +1 @@\n-old\n+new" });
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

test("lineDiff writes one unified hunk with context, deletions, and insertions", () => {
  expect(lineDiff("a\nb\nc", "a\nB\nc")).toBe("@@ -1,3 +1,3 @@\n a\n-b\n+B\n c");
  expect(lineDiff("keep\n", "keep\nmore\n")).toBe("@@ -1 +1,2 @@\n keep\n+more");
  expect(lineDiff("", "new")).toBe("@@ -0,0 +1 @@\n+new");
  expect(lineDiff("x\ny", "")).toBe("@@ -1,2 +0,0 @@\n-x\n-y");
  // A line moved down: the longest common subsequence keeps the most lines as context.
  expect(lineDiff("a\nb\nc\nd", "b\nc\na\nd")).toBe("@@ -1,4 +1,4 @@\n-a\n b\n c\n+a\n d");
});

test("lineDiff stays fast on huge inputs", () => {
  const before = Array.from({ length: 5_000 }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: 5_000 }, (_, i) => `new ${i}`).join("\n");
  const started = performance.now();
  const diff = lineDiff(before, after);
  expect(performance.now() - started).toBeLessThan(500);
  expect(diff.split("\n").filter((line) => line.startsWith("-"))).toHaveLength(5_000);
  expect(diff.split("\n").filter((line) => line.startsWith("+"))).toHaveLength(5_000);
});
