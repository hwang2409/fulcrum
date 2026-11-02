import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { createRunStore, resolveToolView, type RunItem, type ToolView } from "@fulcrum/core";
import { fromZetaEvent, zetaTools } from "../src/index.js";

const call = (name: string, args: Record<string, unknown>) => ({ id: "1", name, arguments: args });

test("zeta tool names map to the agent-neutral views", () => {
  expect(resolveToolView(zetaTools, call("bash", { command: "ls", cwd: "/repo" }))).toEqual({ kind: "shell", command: "ls", cwd: "/repo" });
  expect(resolveToolView(zetaTools, call("bash", { cmd: "pwd" }))).toEqual({ kind: "shell", command: "pwd" });
  expect(resolveToolView(zetaTools, call("run_background", { command: "bun run dev" }))).toEqual({ kind: "shell", command: "bun run dev" });
  expect(resolveToolView(zetaTools, call("read", { path: "a.ts", offset: 10, limit: 40 }))).toEqual({ kind: "read", path: "a.ts", range: { offset: 10, limit: 40 } });
  expect(resolveToolView(zetaTools, call("read", { path: "a.ts" }))).toEqual({ kind: "read", path: "a.ts" });
  expect(resolveToolView(zetaTools, call("edit", { path: "a.ts", old_string: "a", new_string: "b" }))).toEqual({ kind: "edit", path: "a.ts", diff: "@@ -1 +1 @@\n-a\n+b" });
  expect(resolveToolView(zetaTools, call("edit", { path: "a.ts", edits: [{ old_string: "one", new_string: "1" }, { old_string: "two", new_string: "2" }] }))).toEqual({
    kind: "edit",
    path: "a.ts",
    diff: "@@ -1 +1 @@\n-one\n+1\n@@ -1 +1 @@\n-two\n+2",
  });
  expect(resolveToolView(zetaTools, call("write", { path: "n.md", content: "hi\n" }))).toEqual({ kind: "write", path: "n.md", content: "hi\n" });
  expect(resolveToolView(zetaTools, call("fetch", { url: "https://x.dev" }))).toEqual({ kind: "fetch", url: "https://x.dev" });
  expect(resolveToolView(zetaTools, call("websearch", { query: "virtua" }))).toEqual({ kind: "fetch", query: "virtua" });
});

test("invalid zeta arguments and unmapped tools fall back to the generic card", () => {
  expect(resolveToolView(zetaTools, call("bash", {}))).toBeUndefined();
  expect(resolveToolView(zetaTools, call("read", { path: 3 }))).toBeUndefined();
  expect(resolveToolView(zetaTools, call("edit", { path: "a.ts" }))).toBeUndefined();
  expect(resolveToolView(zetaTools, call("edit", { path: "a.ts", edits: [{ old_string: 1 }] }))).toBeUndefined();
  expect(resolveToolView(zetaTools, call("write", { path: "a.ts" }))).toBeUndefined();
  for (const name of ["agent", "todo", "task_output", "skill", "inbox"]) expect(resolveToolView(zetaTools, call(name, {}))).toBeUndefined();
});

// Every tool and approval item in every recorded fixture gets the view kind its zeta tool name implies.
const expectedKind: Record<string, ToolView["kind"] | undefined> = {
  bash: "shell",
  run_background: "shell",
  read: "read",
  edit: "edit",
  write: "write",
  fetch: "fetch",
  websearch: "fetch",
};

test("replaying the zeta fixtures gives every tool item its expected view kind", () => {
  const dir = new URL("./fixtures/", import.meta.url);
  const seen = new Set<string>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".jsonl"))) {
    const stores = new Map<string, ReturnType<typeof createRunStore>>();
    for (const line of readFileSync(new URL(file, dir), "utf8").trim().split("\n")) {
      const params = JSON.parse(line).params;
      const store = stores.get(params.session_id) ?? createRunStore(() => {});
      stores.set(params.session_id, store);
      fromZetaEvent(params).forEach(store.dispatch);
    }
    for (const store of stores.values()) {
      for (const { id } of store.getOutline()) {
        const item = store.getItem(id) as RunItem;
        const [name, view] =
          item.type === "tool" ? [item.tool_call.name, item.view]
          : item.type === "approval" && item.request.type === "approval_request" ? [item.request.tool_call.name, item.request.view]
          : [];
        if (!name) continue;
        seen.add(name);
        expect([file, name, view?.kind]).toEqual([file, name, expectedKind[name]]);
      }
    }
  }
  expect([...seen].sort()).toEqual(["agent", "bash", "edit", "fetch", "read", "run_background", "todo", "websearch", "write"]);
});

test("a finished bash call carries its exit code and split streams from structured_content", () => {
  const store = createRunStore(() => {});
  for (const line of readFileSync(new URL("./fixtures/tools.jsonl", import.meta.url), "utf8").trim().split("\n"))
    fromZetaEvent(JSON.parse(line).params).forEach(store.dispatch);
  const ok = store.getItem("tool:call-1");
  const failed = store.getItem("tool:call-2");
  expect(ok?.type === "tool" ? ok.view : undefined).toEqual({ kind: "shell", command: "ls packages", cwd: "/repo", exitCode: 0, stdout: "core\nreact\n", stderr: "" });
  expect(failed?.type === "tool" ? failed.view : undefined).toEqual({ kind: "shell", command: "bun test", exitCode: 1, stdout: "", stderr: "error: 1 failing\n" });
});

test("malformed structured_content is ignored, not trusted", () => {
  const tool_call = { id: "t", name: "bash", arguments: { command: "ls" } };
  const [event] = fromZetaEvent({ event: "tool_end", tool_call, tool_result: { tool_call_id: "t", content: "x", is_error: false, structured_content: { exit_code: "0", stdout: 4, stderr: null } } });
  expect(event).toMatchObject({ type: "tool_end", view: { kind: "shell", command: "ls" } });
  expect(event?.type === "tool_end" ? event.view : undefined).toEqual({ kind: "shell", command: "ls" });
});
