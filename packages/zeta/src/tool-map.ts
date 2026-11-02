import { defineToolMap, lineDiff, type ToolArguments, type ToolView } from "@fulcrum/core";

const shell = (args: ToolArguments): ToolView | undefined => {
  const command = args.string("command") ?? args.string("cmd"); // `cmd` is bash's deprecated alias
  const cwd = args.string("cwd");
  return command ? { kind: "shell", command, ...(cwd ? { cwd } : {}) } : undefined;
};
const replacement = (value: unknown) => {
  const edit = value as { old_string?: unknown; new_string?: unknown } | null;
  return edit && typeof edit.old_string === "string" && typeof edit.new_string === "string" ? lineDiff(edit.old_string, edit.new_string) : undefined;
};

/** zeta's tool names and arguments (zeta/src/zeta/tools/*) mapped to fulcrum's views. Other tools get the generic card. */
export const zetaTools = defineToolMap({
  bash: shell,
  run_background: shell,
  read: (args) => {
    const path = args.string("path");
    const offset = args.number("offset");
    const limit = args.number("limit");
    if (!path) return undefined;
    return offset === undefined && limit === undefined ? { kind: "read", path } : { kind: "read", path, range: { offset, limit } };
  },
  edit: (args) => {
    const path = args.string("path");
    const edits = args.array("edits");
    const hunks = edits ? edits.map(replacement) : [replacement({ old_string: args.value("old_string"), new_string: args.value("new_string") })];
    return path && hunks.length && hunks.every(Boolean) ? { kind: "edit", path, diff: hunks.join("\n") } : undefined;
  },
  write: (args) => {
    const path = args.string("path");
    const content = args.string("content");
    return path && content !== undefined ? { kind: "write", path, content } : undefined;
  },
  fetch: (args) => {
    const url = args.string("url");
    return url ? { kind: "fetch", url } : undefined;
  },
  websearch: (args) => {
    const query = args.string("query");
    return query ? { kind: "fetch", query } : undefined;
  },
});
