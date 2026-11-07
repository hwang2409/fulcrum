# use fulcrum with another harness

the cards are generic; a harness maps its own tool names to them. a tool map is the middleware layer: it reads a tool call's arguments and returns one of fulcrum's agent-neutral views, defined in `@fulcrum/core`:

| `kind` | fields | card |
| --- | --- | --- |
| `shell` | `command`, `cwd?`, `exitCode?`, `stdout?`, `stderr?` | `$ command`, output, stderr apart, exit code |
| `read` | `path`, `range?: { offset?, limit? }` (offset is lines skipped) | numbered lines |
| `edit` | `path`, `diff` (unified diff) | diff with gutters and line numbers |
| `write` | `path`, `content?`, `bytes?` | numbered written content |
| `search` | `pattern`, `path?`, `matches?` | matches grouped by file |
| `fetch` | `url` or `query`, `status?`, `title?`, `bytes?` | status, url, body |

every view can also carry `durationMs`. a tool with no view gets the generic card (output and json arguments), so nothing is lost. resolvers receive safe argument readers; missing or invalid arguments return no view instead of throwing. `lineDiff(before, after)` writes the unified diff for edit tools that take old and new strings.

zeta's map ships in `@fulcrum/zeta` as `zetaTools`, and its adapter attaches the views for you (plus `exitCode`, `stdout`, and `stderr` from bash's `structured_content`):

| zeta tool | view |
| --- | --- |
| `bash`, `run_background` | `shell` from `command` (or the old `cmd`) and `cwd` |
| `read` | `read` from `path`, `offset`, `limit` |
| `edit` | `edit`: one hunk per `old_string`/`new_string` pair, or per entry of `edits` |
| `write` | `write` from `path` and `content` |
| `fetch` | `fetch` from `url` |
| `websearch` | `fetch` from `query` |
| everything else (`agent`, `todo`, `skill`, ...) | generic |

a second harness writes its own map the same way. this one is for Claude Code's tool names, and has its own test in `packages/core/test/tool-map.test.ts`:

```ts
import { defineToolMap, lineDiff, resolveToolView } from "@fulcrum/core";

const claudeCodeTools = defineToolMap({
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
    const before = args.string("old_string");
    const after = args.string("new_string");
    return path && before !== undefined && after !== undefined ? { kind: "edit", path, diff: lineDiff(before, after) } : undefined;
  },
});

// in your adapter, for tool_start, tool_end, and approval_request:
const event = { type: "tool_start", tool_call: toolCall, view: resolveToolView(claudeCodeTools, toolCall) };
```

`applyToolMap` adds the view to an existing tool item instead. `@fulcrum/core` and `@fulcrum/react` never import a harness package.

an approval ends with `approval_end`, whose `decision` is fulcrum's one vocabulary: `"approve"`, `"deny"`, or `"abort"` (leave it unset when the harness does not say). the adapter maps its harness's words onto it: `@fulcrum/zeta` maps zeta's `allow`/`deny`/`abort`, and `@fulcrum/ai-sdk` sets `deny` on `tool-output-denied` and `approve` once an approved tool returns. the card reads only `decision` (approved in ok, denied in danger) and, for other endings, `data.reason`.
