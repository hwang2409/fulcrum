import type { RunEvent, ToolCall } from "@fulcrum/core";

/** `part` is the `@fulcrum/react` export the demo shows. `live` replays `events` in a loop, one event per `live` ms. */
export type Demo = { id: string; part: string; title: string; description: string; events: RunEvent[]; live?: number };

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

const grep = call("t-grep", "grep", { pattern: "TODO", path: "packages/", glob: "*.ts" });
const grepLines = [
  "packages/core/src/store.ts:12: // TODO: cap pending queue\n",
  "packages/core/src/reducer.ts:88: // TODO: bounded receipts\n",
  "packages/zeta/src/client.ts:41: // TODO: retry with backoff\n",
];
const bash = call("t-bash", "bash", { command: "bun test packages/core", timeout: 120 });
const edit = call("t-edit", "edit", {
  path: "packages/core/src/store.ts",
  old_string: "pending.push(event);",
  new_string: "if (pending.length < MAX) pending.push(event);",
});
const deploy = call("t-deploy", "bash", { command: "rm -rf dist && bun run build && rsync -a dist/ prod:/srv/app" });
const bigArgs = call("t-big", "write_file", {
  path: "fixtures/session.json",
  options: { overwrite: true, mode: "0644", encoding: "utf8" },
  rows: Array.from({ length: 24 }, (_, i) => ({ id: i, name: `row-${i}`, tags: ["alpha", "beta", "gamma"], score: i * 1.5 })),
});
const testLines = Array.from(
  { length: 120 },
  (_, i) => `${String(i + 1).padStart(4, "0")}  ok  packages/core/test/reducer.test.ts > case ${i + 1} (${(i % 7) + 1}ms)\n`,
);
const ok = (tool: ToolCall, content: string): RunEvent => ({
  type: "tool_end",
  tool_call: tool,
  tool_result: { tool_call_id: tool.id, content, is_error: false },
});

export const demos: Demo[] = [
  {
    id: "timeline-run",
    part: "Timeline",
    title: "realistic run",
    description: "A user question, assistant messages, tools, a resolved approval, and the final answer.",
    events: [
      { type: "run_start" },
      { type: "user_message", text: "Why does the playground build fail on CI?", mode: "default" },
      { type: "turn_start" },
      ...stream("m1", "Let me search the packages for open TODOs first."),
      { type: "tool_start", tool_call: grep },
      ...grepLines.map((output): RunEvent => ({ type: "tool_output", tool_call: grep, output })),
      ok(grep, grepLines.join("")),
      { type: "approval_request", request_id: "r-edit", tool_call: edit, delegated: false },
      { type: "approval_end", request_id: "r-edit" },
      { type: "tool_start", tool_call: edit },
      ok(edit, "1 replacement"),
      { type: "tool_start", tool_call: bash },
      { type: "tool_output", tool_call: bash, output: "bun test v1.3.13\n 42 pass\n 0 fail\n" },
      ok(bash, ""),
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
    id: "tool-running",
    part: "ToolCall",
    title: "running",
    description: "Output streams in while the tool is active (data-state=\"streaming\").",
    events: [
      { type: "tool_start", tool_call: bash },
      ...testLines.slice(0, 24).map((output): RunEvent => ({ type: "tool_output", tool_call: bash, output })),
      ok(bash, ""),
    ],
    live: 90,
  },
  {
    id: "tool-done",
    part: "ToolCall",
    title: "done",
    description: "A finished tool with its output.",
    events: [{ type: "tool_start", tool_call: grep }, ok(grep, grepLines.join(""))],
  },
  {
    id: "tool-error",
    part: "ToolCall",
    title: "error",
    description: "The tool result has is_error=true.",
    events: [
      { type: "tool_start", tool_call: bash },
      {
        type: "tool_end",
        tool_call: bash,
        tool_result: { tool_call_id: bash.id, content: "error: script \"test\" exited with code 1", is_error: true },
      },
    ],
  },
  {
    id: "tool-canceled",
    part: "ToolCall",
    title: "canceled",
    description: "The user canceled the tool. The part has no separate canceled state, so it shows as done.",
    events: [
      { type: "tool_start", tool_call: bash },
      { type: "tool_output", tool_call: bash, output: "bun test v1.3.13\n" },
      {
        type: "tool_end",
        tool_call: bash,
        tool_result: { tool_call_id: bash.id, content: "canceled by user", is_error: false, is_canceled: true },
      },
    ],
  },
  {
    id: "tool-large",
    part: "ToolCall",
    title: "large args and output",
    description: "Large JSON arguments and about 9 KB of output; the output scrolls inside the part.",
    events: [{ type: "tool_start", tool_call: bigArgs }, ok(bigArgs, testLines.join(""))],
  },
  {
    id: "approval-pending",
    part: "Approval",
    title: "pending",
    description: "Waiting for the user. Approve or deny resolves it and shows the action.",
    events: [{ type: "approval_request", request_id: "r-deploy", tool_call: deploy, delegated: false }],
  },
  {
    id: "approval-resolved",
    part: "Approval",
    title: "resolved",
    description: "After approval_end the buttons go away and data-state is \"done\".",
    events: [
      { type: "approval_request", request_id: "r-done", tool_call: edit, delegated: false },
      { type: "approval_end", request_id: "r-done" },
    ],
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
