import { expect, test } from "bun:test";
import { zetaToolView, type ToolCall, type ToolResult } from "../src/index.js";

const call = (name: string, arguments_: Record<string, unknown>): ToolCall => ({
  id: `call-${name}`,
  name,
  arguments: arguments_,
});

const cases = [
  ["bash", { command: "pwd", cwd: "/repo" }, { kind: "shell", command: "pwd", cwd: "/repo" }],
  ["read", { path: "src/a.ts", offset: 4, limit: 20 }, { kind: "read", path: "src/a.ts", range: { offset: 4, limit: 20 } }],
  ["edit", { path: "src/a.ts", old_string: "old\n", new_string: "new\n" }, { kind: "edit", path: "src/a.ts", diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new\n" }],
  ["write", { path: "src/a.ts", content: "hello" }, { kind: "write", path: "src/a.ts", bytes: 5 }],
  ["grep", { pattern: "TODO", path: "src" }, { kind: "search", pattern: "TODO", path: "src" }],
  ["glob", { pattern: "**/*.ts", path: "src" }, { kind: "search", pattern: "**/*.ts", path: "src" }],
  ["fetch", { url: "https://example.com" }, { kind: "fetch", url: "https://example.com" }],
  ["websearch", { query: "fulcrum" }, { kind: "fetch", query: "fulcrum" }],
  ["agent", { prompt: "inspect", description: "code review" }, { kind: "agent", description: "code review" }],
] as const;

for (const [name, args, expected] of cases) {
  test(`maps ${name} arguments to an agent-neutral view`, () => {
    expect(zetaToolView(call(name, args))).toEqual(expected);
  });
}

const otherZetaTools = [
  "agent_cancel", "mcp_discover", "ask_parent", "inbox", "skill", "request_attention",
  "session_push", "run_background", "task_output", "task_input", "task_kill", "agent_send",
  "agent_status", "agent_output", "todo", "project", "finish", "resolve_attention",
];
for (const name of otherZetaTools) {
  test(`${name} has no specialized view`, () => {
    expect(zetaToolView(call(name, {}))).toBeUndefined();
  });
}

test("tool results add structured shell and agent details", () => {
  const shellResult = { tool_call_id: "call-bash", content: "ok", is_error: false, structured_content: { exit_code: 0 } } as ToolResult;
  expect(zetaToolView(call("bash", { command: "true" }), shellResult)).toEqual({ kind: "shell", command: "true", exitCode: 0 });

  const agentResult = {
    tool_call_id: "call-agent",
    content: "running",
    is_error: false,
    structured_content: { child_instance_id: "child-1", status: "running", description: "code review" },
  } as ToolResult;
  expect(zetaToolView(call("agent", { prompt: "inspect", description: "code review" }), agentResult)).toEqual({
    kind: "agent", childRunId: "child-1", status: "running", description: "code review",
  });
});

test("adapter attaches the view to tool events", async () => {
  const { fromZetaEvent } = await import("../src/index.js");
  const [event] = fromZetaEvent({ event: "tool_start", tool_call: call("bash", { command: "ls" }) });
  expect(event).toMatchObject({ type: "tool_start", view: { kind: "shell", command: "ls" } });
});
