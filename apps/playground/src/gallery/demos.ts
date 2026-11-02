import { resolveToolView, type RunEvent, type ToolCall, type ToolView } from "@fulcrum/core";
import { zetaTools } from "@fulcrum/zeta";

/** `part` is the `@fulcrum/react` export the demo shows. `live` replays `events` in a loop, one event per `live` ms.
    `preview` renders a static markup fixture instead of a timeline. */
export type Demo = { id: string; part: string; title: string; description: string; events: RunEvent[]; live?: number; preview?: "markdown" };

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, name, arguments: args });
const text = (role: string, value: string) => ({ role, content: [{ type: "text", text: value }] });
const stream = (id: string, value: string): RunEvent[] => [
  ...value.match(/\S+\s*/g)!.map((delta): RunEvent => ({ type: "message_delta", message_id: id, delta })),
  { type: "message_commit", message_id: id, message: text("assistant", value) },
];

const answer =
  "The build fails because `vite.config.ts` imports `node:path` in a browser bundle. " +
  "Move the import into the config's server block, or use `new URL(..., import.meta.url)` instead.";
const longText =
  "Here is the full trace you asked for. Long tokens must wrap instead of pushing the layout sideways:\n\n" +
  "https://example.com/very/long/path/that/keeps/going/and/going/until/it/is/wider/than/any/reasonable/column?query=" +
  "a".repeat(80) +
  "\n\nsupercalifragilisticexpialidocious_" +
  "x".repeat(120) +
  "\n\n" +
  "Ordinary prose wraps across several lines when the column is narrow, and keeps its paragraph breaks. ".repeat(3);


// Tool events get their view the way an adapter attaches it: zeta's tool map, or an explicit view for a tool zeta
// does not have (grep). Approvals pass the same view, so they show the same body.
const viewOf = (tool: ToolCall, view?: ToolView) => view ?? resolveToolView(zetaTools, tool);
const start = (tool: ToolCall, view?: ToolView): RunEvent => ({ type: "tool_start", tool_call: tool, view: viewOf(tool, view) });
const out = (tool: ToolCall, output: string): RunEvent => ({ type: "tool_output", tool_call: tool, output });
const end = (tool: ToolCall, content: string, flags: { error?: boolean; canceled?: boolean; view?: ToolView } = {}): RunEvent => ({
  type: "tool_end",
  tool_call: tool,
  view: flags.view,
  tool_result: { tool_call_id: tool.id, content, is_error: flags.error ?? false, is_canceled: flags.canceled },
});
const ask = (id: string, tool: ToolCall, view?: ToolView): RunEvent => ({ type: "approval_request", request_id: id, tool_call: tool, view: viewOf(tool, view), delegated: false });

const config = 'import { defineConfig } from "vite";\nimport { resolve } from "node:path";\n\nexport default defineConfig({\n  build: { outDir: resolve("dist") },\n});\n';
const grepLines = [
  "packages/core/src/store.ts:12:  // TODO: cap pending queue\n",
  "packages/core/src/store.ts:57:  // TODO: drop listeners on dispose\n",
  "packages/core/src/reducer.ts:88:  // TODO: bounded receipts\n",
  "packages/zeta/src/client.ts:41:  // TODO: retry with backoff\n",
];
const testLines = Array.from(
  { length: 120 },
  (_, i) => `${String(i + 1).padStart(4, "0")}  ok  packages/core/test/reducer.test.ts > case ${i + 1} (${(i % 7) + 1}ms)\n`,
);
const page = "Example Domain\n\nThis domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission.\n";

// One call per card, reused across the state demos. Ids are per demo, since every demo has its own store.
const calls = (p: string) => ({
  bash: call(`${p}-bash`, "bash", { command: "bun test packages/core", timeout: 120 }),
  read: call(`${p}-read`, "read", { path: "apps/playground/vite.config.ts", offset: 0, limit: 40 }),
  edit: call(`${p}-edit`, "edit", { path: "packages/core/src/store.ts", old_string: "  pending.push(event);\n  schedule();", new_string: "  if (pending.length < MAX_PENDING) pending.push(event);\n  schedule();" }),
  write: call(`${p}-write`, "write", { path: "docs/notes.md", content: "# notes\n\n- cap the pending queue\n- retry with backoff\n" }),
  grep: call(`${p}-grep`, "grep", { pattern: "TODO", path: "packages/" }),
  fetch: call(`${p}-fetch`, "fetch", { url: "https://example.com/" }),
  todo: call(`${p}-todo`, "todo", { items: [{ content: "cap the pending queue", status: "in_progress" }] }),
});
const grepView = (tool: ToolCall): ToolView => ({ kind: "search", pattern: String(tool.arguments.pattern), path: String(tool.arguments.path) });
const every = (p: string) => {
  const c = calls(p);
  return [c.bash, c.read, c.edit, c.write, c.grep, c.fetch, c.todo].map((tool) => ({ tool, view: tool.name === "grep" ? grepView(tool) : undefined }));
};
const finished: Record<string, string> = {
  bash: " 42 pass\n 0 fail\nRan 42 tests across 4 files. [380.00ms]\n",
  read: config,
  edit: "edited packages/core/src/store.ts: 2.1 kB → 2.1 kB",
  write: "wrote docs/notes.md",
  grep: grepLines.join(""),
  fetch: page,
  todo: "1 todo in progress",
};
const failed: Record<string, string> = {
  bash: "error: script \"test\" exited with code 1",
  read: "could not read file: apps/playground/vite.config.ts: permission denied",
  edit: "old_string not found in packages/core/src/store.ts",
  write: "could not write file: docs/notes.md: read-only file system",
  grep: "grep: packages/: No such file or directory",
  fetch: "request failed: HTTP 503 Service Unavailable",
  todo: "invalid todo status",
};

const longCommand = "rg --json --hidden --glob '!node_modules' --glob '!dist' 'TODO|FIXME' packages apps scripts | jq -r 'select(.type == \"match\") | \"\\(.data.path.text):\\(.data.line_number)\"' | sort | uniq -c | sort -rn | head -50";
const huge = Array.from({ length: 40_000 }, (_, i) => `[${String(i).padStart(5, "0")}] GET /api/runs/${i % 97} 200 ${(i * 7) % 300}ms ${"·".repeat(20)}\n`).join("");
const twoHunks = "--- a/packages/react/src/parts.tsx\n+++ b/packages/react/src/parts.tsx\n@@ -12,4 +12,4 @@\n const pre = { whiteSpace: \"pre-wrap\" } as const;\n-const SHORT_OUTPUT_LINES = 8;\n+const SHORT_OUTPUT_LINES = 12;\n \n export const Message = memo(function Message({ id }) {\n@@ -88,3 +88,5 @@\n   const state = toolState(tool);\n+  // The body reads the view; the header stays shared.\n+  const output = toolOutput(tool);\n   return (\n";

const run = calls("run");
const build = call("run-build", "bash", { command: "bun run --cwd apps/playground build" });
const deploy = call("ap-deploy", "bash", { command: "rm -rf dist && bun run build && rsync -a --delete dist/ prod:/srv/app", cwd: "/srv/checkout" });
const bigArgs = call("ap-big", "write_file", {
  path: "fixtures/session.json",
  options: { overwrite: true, mode: "0644", encoding: "utf8" },
  rows: Array.from({ length: 24 }, (_, i) => ({ id: i, name: `row-${i}`, tags: ["alpha", "beta", "gamma"], score: i * 1.5 })),
});

export const demos: Demo[] = [
  {
    id: "timeline-run",
    part: "Timeline",
    title: "realistic run",
    description: "A failing build, a file read, a search, an approved edit, a passing test run, and the answer. Every tool renders as its own card.",
    events: [
      { type: "run_start" },
      { type: "user_message", text: "Why does the playground build fail on CI?", mode: "default" },
      { type: "turn_start" },
      ...stream("m1", "I will reproduce the build first, then read the config it points at."),
      start(build),
      out(build, "vite v8.3.5 building for production...\n"),
      end(build, "", {
        error: true,
        view: { kind: "shell", command: String(build.arguments.command), exitCode: 1, stdout: "vite v8.3.5 building for production...\n", stderr: '[vite]: Rollup failed to resolve import "node:path" from "vite.config.ts".\nerror: script "build" exited with code 1\n' },
      }),
      start(run.read),
      end(run.read, config),
      start(run.grep, grepView(run.grep)),
      ...grepLines.map((line) => out(run.grep, line)),
      end(run.grep, grepLines.join("")),
      ask("r-edit", run.edit),
      { type: "approval_end", request_id: "r-edit" },
      start(run.edit),
      end(run.edit, finished.edit),
      start(run.bash),
      out(run.bash, "bun test v1.3.13\n"),
      out(run.bash, finished.bash),
      end(run.bash, "", { view: { kind: "shell", command: String(run.bash.arguments.command), exitCode: 0, durationMs: 1840 } }),
      { type: "message_commit", message_id: "m2", message: text("assistant", answer) },
      { type: "turn_end" },
      { type: "usage", usage: { input_tokens: 5120, output_tokens: 384 } },
      { type: "run_end" },
    ],
  },
  { id: "timeline-empty", part: "Timeline", title: "empty", description: "No events yet: an empty container.", events: [] },
  {
    id: "message-streaming",
    part: "Message",
    title: "assistant, streaming",
    description: "Text arrives one word at a time with data-state=\"streaming\" until the commit.",
    events: stream("m-live", answer),
    live: 70,
  },
  {
    id: "message-done",
    part: "Message",
    title: "assistant, done",
    description: "A committed assistant message.",
    events: stream("m-done", answer).slice(-1),
  },
  {
    id: "message-user-role",
    part: "Message",
    title: "user role",
    description: "A committed message with role \"user\" (data-role=\"user\").",
    events: [{ type: "message_commit", message_id: "m-user", message: text("user", "Can you also check the transport tests?") }],
  },
  {
    id: "message-long",
    part: "Message",
    title: "long text",
    description: "Paragraphs, a very long URL, and a very long word.",
    events: [{ type: "message_commit", message_id: "m-long", message: text("assistant", longText) }],
  },
  {
    id: "markdown-preview",
    part: "Message",
    title: "markdown and code (preview)",
    description: "What an assistant message looks like once @fulcrum/markdown lands: static markup in @fulcrum/markdown's data-part contract with tok-* spans, styled by styles.css and the theme.",
    events: [],
    preview: "markdown",
  },
  {
    id: "tool-running",
    part: "ToolCall",
    title: "shell, streaming",
    description: "Output streams in while the tool runs (data-state=\"streaming\"); the newest line stays in view.",
    events: [start(run.bash), ...testLines.slice(0, 24).map((line) => out(run.bash, line)), end(run.bash, "")],
    live: 90,
  },
  {
    id: "tools-running",
    part: "ToolCall",
    title: "every card, running",
    description: "shell, read, edit, write, search, fetch, and a generic tool (todo) before their results arrive.",
    events: every("running").map(({ tool, view }) => start(tool, view)),
  },
  {
    id: "tools-done",
    part: "ToolCall",
    title: "every card, done",
    description: "The same calls finished: shell output, numbered lines, a unified diff, the written file, matches by file, the page, and generic json.",
    events: every("done").flatMap(({ tool, view }) => [start(tool, view), end(tool, finished[tool.name]!)]),
  },
  {
    id: "tools-error",
    part: "ToolCall",
    title: "every card, failed",
    description: "Each result has is_error=true: the reason shows in the body, the rail and the status word say failed.",
    events: every("error").flatMap(({ tool, view }) => [
      start(tool, view),
      end(tool, failed[tool.name]!, { error: true, view: tool.name === "bash" ? { kind: "shell", command: String(tool.arguments.command), exitCode: 1, stdout: " 41 pass\n", stderr: " 1 fail\nerror: script \"test\" exited with code 1\n" } : tool.name === "fetch" ? { kind: "fetch", url: String(tool.arguments.url), status: 503 } : undefined }),
    ]),
  },
  {
    id: "tools-canceled",
    part: "ToolCall",
    title: "every card, canceled",
    description: "The user canceled each call (data-state=\"canceled\"): the summary is struck through.",
    events: every("canceled").flatMap(({ tool, view }) => [start(tool, view), end(tool, "canceled by user", { canceled: true })]),
  },
  {
    id: "tool-long-command",
    part: "ToolCall",
    title: "shell, long command",
    description: "The header cuts the command to one line; the body repeats it in full above the output.",
    events: (() => {
      const tool = call("long", "bash", { command: longCommand });
      return [start(tool), end(tool, "  14 packages/core/src/store.ts:12\n   9 packages/zeta/src/client.ts:41\n")];
    })(),
  },
  {
    id: "tool-huge",
    part: "ToolCall",
    title: "shell, huge output",
    description: `${(huge.length / 1_000_000).toFixed(1)} MB of output: the first 40 and last 20 lines; show all puts at most 100 kB in the DOM and says what it left out. Copy still copies everything.`,
    events: (() => {
      const tool = call("huge", "bash", { command: "cat logs/access.log" });
      return [start(tool), end(tool, huge)];
    })(),
  },
  {
    id: "tool-empty",
    part: "ToolCall",
    title: "empty output",
    description: "A shell call with no output and exit 0, and a search with no matches: the body says so in words.",
    events: (() => {
      const touch = call("empty-sh", "bash", { command: "touch dist/.keep" });
      const none = call("empty-grep", "grep", { pattern: "FIXME", path: "packages/" });
      return [start(touch), end(touch, "", { view: { kind: "shell", command: "touch dist/.keep", exitCode: 0, stdout: "", stderr: "" } }), start(none, grepView(none)), end(none, "")];
    })(),
  },
  {
    id: "tool-diff",
    part: "ToolCall",
    title: "edit, two hunks",
    description: "A harness that sends a real unified diff: two hunks with their file line numbers and the changed word marked.",
    events: (() => {
      const tool = call("diff", "apply_patch", { patch: twoHunks });
      return [start(tool, { kind: "edit", path: "packages/react/src/parts.tsx", diff: twoHunks }), end(tool, "applied 1 patch")];
    })(),
  },
  {
    id: "tool-websearch",
    part: "ToolCall",
    title: "web search",
    description: "zeta's websearch maps to the fetch view with a query instead of a url.",
    events: (() => {
      const tool = call("ws", "websearch", { query: "virtua react virtualization", max_results: 3 });
      return [start(tool), end(tool, "1. inokawa/virtua - GitHub\n   https://github.com/inokawa/virtua\n2. virtua - npm\n   https://www.npmjs.com/package/virtua\n")];
    })(),
  },
  {
    id: "tool-large",
    part: "ToolCall",
    title: "generic, large args and output",
    description: "A tool with no view: about 9 KB of output, and the json arguments behind their own disclosure.",
    events: [start(bigArgs), end(bigArgs, testLines.join(""))],
  },
  {
    id: "approval-pending",
    part: "Approval",
    title: "pending, shell",
    description: "A shell command waiting for the user: the full command, the cwd, and the raw arguments. A second click while sending is ignored.",
    events: [ask("r-deploy", deploy)],
  },
  {
    id: "approval-edit",
    part: "Approval",
    title: "pending, edit",
    description: "The edit approval shows the whole diff it would apply.",
    events: [ask("r-edit-pending", calls("ap").edit)],
  },
  {
    id: "approval-write",
    part: "Approval",
    title: "pending, write",
    description: "The write approval shows the file it would write, with line numbers.",
    events: [ask("r-write", calls("ap").write)],
  },
  {
    id: "approval-generic",
    part: "Approval",
    title: "pending, generic tool",
    description: "A tool with no view: the full arguments are shown, never cut, so the user sees what they approve.",
    events: [ask("r-generic", bigArgs)],
  },
  {
    id: "approval-resolved",
    part: "Approval",
    title: "resolved",
    description: "After approval_end the buttons go away and data-state is \"done\".",
    events: [ask("r-done", calls("ap").edit), { type: "approval_end", request_id: "r-done" }],
  },
  {
    id: "fallback-user",
    part: "Fallback",
    title: "user message",
    description: "A user_message event (kind \"user\").",
    events: [{ type: "user_message", text: "Why does the playground build fail on CI?", mode: "default" }],
  },
  {
    id: "fallback-error",
    part: "Fallback",
    title: "error",
    description: "An error event (kind \"error\").",
    events: [{ type: "error", error: { code: "rate_limited", message: "Rate limited by the model provider. Retrying in 30s." } }],
  },
  {
    id: "fallback-notification",
    part: "Fallback",
    title: "notification",
    description: "A notification event. The fallback shows only its kind.",
    events: [{ type: "notification", notification_id: "n1", data: { text: "Context compacted" } }],
  },
  {
    id: "fallback-unknown",
    part: "Fallback",
    title: "unknown",
    description: "An event the core does not know. The fallback shows its name.",
    events: [{ type: "unknown", name: "session/checkpoint_saved", data: {} }],
  },
];

const viewerFixture = new URLSearchParams(location.search).get("viewerFixture");
if (viewerFixture === "single" || viewerFixture === "lines") {
  const fixture = viewerFixture === "single" ? "x".repeat(2_000_000) : "x\n".repeat(1_000_000);
  const tool = call("viewer-check", "bash", { command: "stream fixture" });
  demos.splice(0, demos.length, {
    id: "text-viewer-check",
    part: "ToolCall",
    title: `${viewerFixture} text viewer check`,
    description: "browser-only layout fixture for measured text viewer behavior",
    events: [start(tool, { kind: "shell", command: "stream fixture" }), out(tool, fixture)],
  });
}
