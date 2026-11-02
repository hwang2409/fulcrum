import { expect, test } from "bun:test";
import { applyToolMap, defineToolMap, resolveToolView, type RunItem, type ToolCall } from "../src/index.js";

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
      ? { kind: "edit", path, diff: `-${oldText}\n+${newText}` }
      : undefined;
  },
});

const call = (name: string, arguments_: Record<string, unknown>): ToolCall => ({ id: "1", name, arguments: arguments_ });

test("a non-zeta harness maps its own tool names", () => {
  expect(resolveToolView(claudeCode, call("Bash", { command: "pwd" }))).toEqual({ kind: "shell", command: "pwd" });
  expect(resolveToolView(claudeCode, call("Read", { file_path: "README.md" }))).toEqual({ kind: "read", path: "README.md" });
  expect(resolveToolView(claudeCode, call("Edit", { file_path: "a.ts", old_string: "old", new_string: "new" }))).toEqual({ kind: "edit", path: "a.ts", diff: "-old\n+new" });
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
