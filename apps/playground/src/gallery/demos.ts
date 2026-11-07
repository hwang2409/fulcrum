import { resolveToolView, type ContentBlock, type RunEvent, type SubAgentEvent, type ToolCall, type ToolView } from "@fulcrum/core";
import { zetaTools } from "@fulcrum/zeta";
import { CHART_PNG } from "./chart";

/**
 * `part` is the `@fulcrum/react` export the demo shows. `live` replays `events` in a loop, one event per `live` ms.
 * `runs` are child runs by id, shown in a RunNavigator: a sub-agent row whose run is missing here is unavailable. A
 * live demo with runs streams every run in step and stops at the end instead of looping, so a drill-in is never reset.
 */
/** `open`: the demo's tool cards start open, for a demo about what their body says. `markdownAll`: user text renders as markdown too. */
export type Demo = { id: string; part: string; title: string; description: string; events: RunEvent[]; live?: number; runs?: Record<string, RunEvent[]>; open?: boolean; markdownAll?: boolean };

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, name, arguments: args });
const text = (role: string, value: string) => ({ role, content: [{ type: "text", text: value }] });
const stream = (id: string, value: string): RunEvent[] => [
  ...value.match(/\S+\s*/g)!.map((delta): RunEvent => ({ type: "message_delta", message_id: id, delta })),
  { type: "message_commit", message_id: id, message: text("assistant", value) },
];

const answer =
  "The build fails because `vite.config.ts` imports `node:path` in a browser bundle. " +
  "Move the import into the config's server block, or use `new URL(..., import.meta.url)` instead.";
const userParityText = "Why does the playground build fail on CI after the dependency cache is restored on a fresh runner, while the same command passes locally with the locked Bun version and a clean install? Please compare the generated package output, compiler diagnostics, and environment settings before changing any dependency versions.";
const markdownDemo = [
  "The build fails because `vite.config.ts` imports `node:path` in a browser bundle. Move the import into the config's server block, or use `new",
  "`",
  "",
  "# fix summary",
  "",
  "- keep `vite.config.ts` on the server",
  "- use a URL instead of `node:path`",
  "",
  "| check | result |",
  "| --- | ---: |",
  "| typecheck | pass |",
  "| tests | pass |",
  "",
  "```ts",
  "const outDir = new URL(\"./dist\", import.meta.url).pathname;",
  "```",
  "",
  "```diff",
  "-import { resolve } from \"node:path\";",
  "+const outDir = new URL(\"./dist\", import.meta.url).pathname;",
  "```",
].join("\n");
const longText =
  "Here is the full trace you asked for. Long tokens must wrap instead of pushing the layout sideways:\n\n" +
  "https://example.com/very/long/path/that/keeps/going/and/going/until/it/is/wider/than/any/reasonable/column?query=" +
  "a".repeat(80) +
  "\n\nsupercalifragilisticexpialidocious_" +
  "x".repeat(120) +
  "\n\n" +
  "Ordinary prose wraps across several lines when the column is narrow, and keeps its paragraph breaks. ".repeat(3);

// A message that streams its parts in order (a string is text, word by word; `reasoning` streams the same way; a block
// arrives whole), then commits the same content, as an adapter does.
type Piece = string | { reasoning: string } | ContentBlock;
const words = (value: string) => value.match(/\S+\s*/g) ?? [];
const blockStream = (id: string, pieces: Piece[]): RunEvent[] => {
  const events: RunEvent[] = [];
  const content: ContentBlock[] = [];
  for (const piece of pieces) {
    if (typeof piece === "string") {
      events.push(...words(piece).map((delta): RunEvent => ({ type: "message_delta", message_id: id, delta })));
      content.push({ type: "text", text: piece });
    } else if ("reasoning" in piece && typeof piece.reasoning === "string") {
      events.push(...words(piece.reasoning).map((delta): RunEvent => ({ type: "message_delta", message_id: id, kind: "reasoning", delta })));
      content.push({ type: "reasoning", text: piece.reasoning });
    } else {
      events.push({ type: "message_block", message_id: id, block: piece as ContentBlock });
      content.push(piece as ContentBlock);
    }
  }
  return [...events, { type: "message_commit", message_id: id, message: { role: "assistant", content } }];
};
const committed = (id: string, pieces: Piece[]) => blockStream(id, pieces).slice(-1);

const thinking = { reasoning: "The failing import is node:path in vite.config.ts. The config runs in node, so the import is fine there; the browser bundle must be pulling the config in through the shared constants file. Check who imports constants.ts before changing anything." };
const docs = { type: "source", kind: "source", url: "https://vite.dev/config/shared-options#resolve-alias", title: "Vite: shared options, resolve.alias" };
const issue = { type: "source", kind: "source", url: "https://github.com/vitejs/vite/issues/9200", title: "node:path in a client bundle" };
const guide = { type: "source", kind: "source", mediaType: "application/pdf", title: "Build guide", filename: "build-guide.pdf" };
const report = { type: "file", kind: "file", url: "https://example.com/artifacts/bundle-report.html", mediaType: "text/html", filename: "bundle-report.html", size: 48_213 };
const trace = { type: "file", kind: "file", url: "data:application/json;base64,eyJ0cmFjZSI6W119", mediaType: "application/json", filename: "trace.json", size: 12 };
const chart = { type: "image", url: CHART_PNG, mediaType: "image/png", alt: "bundle size per entry, in kB", width: 640, height: 360, size: 2_940 };
const unsized = { type: "image", url: CHART_PNG, mediaType: "image/png", filename: "chart.png" };
const blocked = { type: "image", url: "data:image/svg+xml;base64,PHN2Zy8+", filename: "logo.svg" };
const custom = { type: "chart-spec", spec: { mark: "bar", encoding: { x: "entry", y: "kB" } }, rows: 7 };
const contentPieces: Piece[] = [thinking, "The browser bundle imports `node:path` through `constants.ts`. ", docs, issue, "Here is the size of each entry after the fix:\n\n", chart, report, "Move the alias into the config's server block."];

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
const storeSource = [
  'import type { RunEvent } from "./events.js";',
  'import { reduce, type RunState } from "./reducer.js";',
  "",
  "/** Batches events and notifies subscribers once per frame. */",
  "export function createRunStore(schedule = requestAnimationFrame) {",
  "  let state: RunState = { items: [], itemsById: new Map() };",
  "  const pending: RunEvent[] = [];",
  "  const listeners = new Set<() => void>();",
  "  let scheduled = false;",
  "",
  "  const flush = () => {",
  "    scheduled = false;",
  "    for (const event of pending.splice(0)) state = reduce(state, event);",
  "    listeners.forEach((listener) => listener());",
  "  };",
  "",
  "  return {",
  "    dispatch(event: RunEvent) {",
  "      pending.push(event);",
  "      if (!scheduled) { scheduled = true; schedule(flush); }",
  "    },",
  "    getState: () => (pending.length ? (flush(), state) : state),",
  "    subscribe(listener: () => void) {",
  "      listeners.add(listener);",
  "      return () => listeners.delete(listener);",
  "    },",
  "  };",
  "}",
  "",
].join("\n");
const benchSource = [
  "#!/usr/bin/env python3",
  '"""Replays a fixture and reports p50/p95 frame times."""',
  "import json",
  "import statistics",
  "from pathlib import Path",
  "",
  "",
  "def load(path: Path) -> list[dict]:",
  "    with path.open() as handle:",
  "        return [json.loads(line) for line in handle if line.strip()]",
  "",
  "",
  "def report(frames: list[float]) -> str:",
  "    p95 = statistics.quantiles(frames, n=20)[18]",
  '    return f"p50 {statistics.median(frames):.1f} ms, p95 {p95:.1f} ms"',
  "",
  "",
  'if __name__ == "__main__":',
  '    events = load(Path("fixtures/run.jsonl"))',
  '    print(report([e["ms"] for e in events if e.get("kind") == "frame"]))',
  "",
].join("\n");
const ESC = "\x1b";
const testOutput = [
  `${ESC}[1mbun test${ESC}[22m ${ESC}[2mv1.3.13${ESC}[22m`,
  "",
  `${ESC}[7m${ESC}[1m${ESC}[32m PASS ${ESC}[39m${ESC}[22m${ESC}[27m packages/core/test/store.test.ts:`, // inverse (SGR 7), as jest prints it
  `${ESC}[32m✓${ESC}[39m batches events per frame ${ESC}[2m[0.41ms]${ESC}[22m`,
  `${ESC}[32m✓${ESC}[39m flushes on read ${ESC}[2m[0.08ms]${ESC}[22m`,
  `${ESC}[32m✓${ESC}[39m unsubscribes ${ESC}[2m[0.03ms]${ESC}[22m`,
  "",
  `${ESC}[32m 42 pass${ESC}[39m`,
  `${ESC}[2m 0 fail${ESC}[22m`,
  `Ran 42 tests across 4 files. ${ESC}[2m[380.00ms]${ESC}[22m`,
  "",
].join("\n");
const buildStdout = `${ESC}[36mvite v8.3.5${ESC}[39m ${ESC}[32mbuilding for production...${ESC}[39m\ntransforming...\n${ESC}[32m✓${ESC}[39m 41 modules transformed.\n`;
const buildStderr = [
  `${ESC}[31m✗${ESC}[39m Build failed in 312ms`,
  `${ESC}[1m${ESC}[31merror${ESC}[39m${ESC}[22m: ${ESC}[31m[vite]: Rollup failed to resolve import ${ESC}[1m"node:path"${ESC}[22m from ${ESC}[36m"apps/playground/vite.config.ts"${ESC}[39m.${ESC}[39m`,
  `${ESC}[2mThis is most likely unintended because it can break your application at runtime.${ESC}[22m`,
  `${ESC}[33mhint${ESC}[39m: move the import into the config's server block`,
  `${ESC}[41m${ESC}[30m FAIL ${ESC}[39m${ESC}[49m script ${ESC}[1m"build"${ESC}[22m exited with code ${ESC}[31m1${ESC}[39m`,
  "",
].join("\n");
const repoJson = JSON.stringify({ id: 912345678, name: "fulcrum", full_name: "hwang2409/fulcrum", private: true, description: "fast, minimal react components for agent runs", default_branch: "main", stargazers_count: 0, topics: ["agents", "react", "virtualization"], license: null, pushed_at: "2026-11-02T21:59:13Z" });
const exampleHtml = '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>Example Domain</title>\n  <style>body { margin: 0 auto; max-width: 40em; }</style>\n</head>\n<body>\n  <h1>Example Domain</h1>\n  <p>This domain is for use in illustrative examples in documents.</p>\n  <p><a href="https://www.iana.org/domains/example">More information...</a></p>\n</body>\n</html>\n';
const grepLines = [
  "packages/core/src/store.ts:12:  // TODO: cap the pending queue\n",
  "packages/core/src/store.ts:57:  // TODO: drop listeners on dispose\n",
  "packages/core/src/reducer.ts:88:  const receipts = new Map<string, number>(); // TODO: bounded receipts\n",
  "docs/roadmap.md:14:- [ ] TODO: retry with backoff in `connectZeta`\n",
  "docs/roadmap.md:15:- [ ] **TODO**: history pager for long runs\n",
];
const testLines = Array.from(
  { length: 120 },
  (_, i) => `${String(i + 1).padStart(4, "0")}  ${ESC}[32mok${ESC}[39m  packages/core/test/reducer.test.ts > case ${i + 1} ${ESC}[2m(${(i % 7) + 1}ms)${ESC}[22m\n`,
);

// One call per card, reused across the state demos. Ids are per demo, since every demo has its own store.
const calls = (p: string) => ({
  bash: call(`${p}-bash`, "bash", { command: "bun test packages/core", timeout: 120 }),
  read: call(`${p}-read`, "read", { path: "packages/core/src/store.ts", offset: 0, limit: 40 }),
  readPy: call(`${p}-read-py`, "read", { path: "scripts/bench.py" }),
  edit: call(`${p}-edit`, "edit", { path: "packages/core/src/store.ts", old_string: "      pending.push(event);\n      if (!scheduled) { scheduled = true; schedule(flush); }", new_string: "      if (pending.length < MAX_PENDING) pending.push(event);\n      if (!scheduled) { scheduled = true; schedule(flush); }" }),
  write: call(`${p}-write`, "write", { path: "docs/notes.md", content: "# notes\n\n- cap the **pending** queue at `MAX_PENDING`\n- retry with backoff\n\n```ts\nconst MAX_PENDING = 10_000;\n```\n" }),
  grep: call(`${p}-grep`, "grep", { pattern: "TODO", path: "packages/ docs/" }),
  fetch: call(`${p}-fetch`, "fetch", { url: "https://api.github.com/repos/hwang2409/fulcrum" }),
  fetchHtml: call(`${p}-fetch-html`, "fetch", { url: "https://example.com/" }),
  todo: call(`${p}-todo`, "todo", { items: [{ content: "cap the pending queue", status: "in_progress" }] }),
});
const grepView = (tool: ToolCall): ToolView => ({ kind: "search", pattern: String(tool.arguments.pattern), path: String(tool.arguments.path) });
const every = (p: string) => {
  const c = calls(p);
  return [c.bash, c.read, c.readPy, c.edit, c.write, c.grep, c.fetch, c.fetchHtml, c.todo].map((tool) => ({ tool, view: tool.name === "grep" ? grepView(tool) : undefined }));
};
const key = (tool: ToolCall) => tool.id.slice(tool.id.indexOf("-") + 1);
const finished: Record<string, string> = {
  bash: testOutput,
  read: storeSource,
  "read-py": benchSource,
  edit: "edited packages/core/src/store.ts: 2.1 kB → 2.1 kB",
  write: "wrote docs/notes.md",
  grep: grepLines.join(""),
  fetch: repoJson,
  "fetch-html": exampleHtml,
  todo: JSON.stringify({ todos: [{ content: "cap the pending queue", status: "in_progress" }], updated: 1 }),
};
// The view a harness reports at the end: exit codes, split streams, HTTP status and type.
const finishedView = (tool: ToolCall): ToolView | undefined => {
  const name = key(tool);
  if (name === "bash") return { kind: "shell", command: String(tool.arguments.command), exitCode: 0, durationMs: 1840 };
  if (name === "fetch") return { kind: "fetch", url: String(tool.arguments.url), status: 200, contentType: "application/json; charset=utf-8", bytes: repoJson.length, durationMs: 212 };
  if (name === "fetch-html") return { kind: "fetch", url: String(tool.arguments.url), status: 200, contentType: "text/html; charset=UTF-8", title: "Example Domain", bytes: exampleHtml.length, durationMs: 96 };
  return undefined;
};
const failed: Record<string, string> = {
  bash: "",
  read: "could not read file: packages/core/src/store.ts: permission denied",
  "read-py": "could not read file: scripts/bench.py: no such file or directory",
  edit: "old_string not found in packages/core/src/store.ts",
  write: "could not write file: docs/notes.md: read-only file system",
  grep: "grep: packages/: No such file or directory",
  fetch: '{"message":"Not Found","documentation_url":"https://docs.github.com/rest","status":"404"}',
  "fetch-html": "request failed: HTTP 503 Service Unavailable",
  todo: "invalid todo status",
};
const failedView = (tool: ToolCall): ToolView | undefined => {
  const name = key(tool);
  if (name === "bash") return { kind: "shell", command: "bun run --cwd apps/playground build", exitCode: 1, stdout: buildStdout, stderr: buildStderr, durationMs: 312 };
  if (name === "fetch") return { kind: "fetch", url: String(tool.arguments.url), status: 404, contentType: "application/json", durationMs: 88 };
  if (name === "fetch-html") return { kind: "fetch", url: String(tool.arguments.url), status: 503, durationMs: 30_000 };
  return undefined;
};

const longCommand = "rg --json --hidden --glob '!node_modules' --glob '!dist' 'TODO|FIXME' packages apps scripts | jq -r 'select(.type == \"match\") | \"\\(.data.path.text):\\(.data.line_number)\"' | sort | uniq -c | sort -rn | head -50";
const heredoc = "cat > scripts/release.sh <<'EOF'\n#!/usr/bin/env bash\nset -euo pipefail\nversion=\"$1\"\nbun install --frozen-lockfile\nbunx tsc -b\nbun test\nbun run build:packages\nfor pkg in packages/*/; do\n  (cd \"$pkg\" && npm version \"$version\" --no-git-tag-version)\ndone\ngit commit -am \"release $version\"\ngit tag \"v$version\"\nEOF\nchmod +x scripts/release.sh";
const huge = Array.from({ length: 40_000 }, (_, i) => `[${String(i).padStart(5, "0")}] GET /api/runs/${i % 97} 200 ${(i * 7) % 300}ms ${"·".repeat(20)}\n`).join("");
const twoHunks = "--- a/packages/react/src/parts.tsx\n+++ b/packages/react/src/parts.tsx\n@@ -12,4 +12,4 @@\n const pre = { whiteSpace: \"pre-wrap\" } as const;\n-const SHORT_OUTPUT_LINES = 8;\n+const SHORT_OUTPUT_LINES = 12;\n \n export const Message = memo(function Message({ id }) {\n@@ -88,3 +88,5 @@\n   const state = toolState(tool);\n+  // The body reads the view; the header stays shared.\n+  const output = toolOutput(tool);\n   return (\n";

// One read per grammar family the token check covers beyond the cards above.
const languageFiles: Array<[string, string]> = [
  ["crates/runs/src/main.rs", 'use std::collections::HashMap;\n\nfn main() {\n    let mut counts: HashMap<&str, u32> = HashMap::new();\n    *counts.entry("runs").or_insert(0) += 1;\n    println!("{counts:?}");\n}\n'],
  ["cmd/runs/main.go", 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfor i := 0; i < 3; i++ {\n\t\tfmt.Println("run", i)\n\t}\n}\n'],
  ["db/schema.sql", "CREATE TABLE runs (\n  id INTEGER PRIMARY KEY,\n  status TEXT NOT NULL DEFAULT 'running'\n);\nSELECT status, count(*) FROM runs GROUP BY status;\n"],
  ["Dockerfile", 'FROM oven/bun:1 AS build\nWORKDIR /app\nCOPY package.json bun.lock ./\nRUN bun install --frozen-lockfile\nCMD ["bun", "run", "start"]\n'],
  ["scripts/deploy.sh", '#!/usr/bin/env bash\nset -euo pipefail\nfor host in web-1 web-2; do\n  rsync -a dist/ "$host:/srv/app"\ndone\necho "deployed $(date +%s)"\n'],
];

const run = calls("run");
const build = call("run-build", "bash", { command: "bun run --cwd apps/playground build" });
const readConfig = call("run-config", "read", { path: "apps/playground/vite.config.ts" });
const deploy = call("ap-deploy", "bash", { command: "rm -rf dist && bun run build && rsync -a --delete dist/ prod:/srv/app", cwd: "/srv/checkout" });
const bigArgs = call("ap-big", "write_file", {
  path: "fixtures/session.json",
  options: { overwrite: true, mode: "0644", encoding: "utf8" },
  rows: Array.from({ length: 24 }, (_, i) => ({ id: i, name: `row-${i}`, tags: ["alpha", "beta", "gamma"], score: i * 1.5 })),
});

// Sub-agents. Elapsed times count from page load, so a running row reads like a live one.
const ago = (seconds: number) => new Date(Date.now() - seconds * 1_000).toISOString();
const agent = (childRunId: string, status: SubAgentEvent["status"], facts: Omit<SubAgentEvent, "type" | "childRunId" | "status"> = {}): RunEvent => ({ type: "sub_agent", childRunId, status, ...facts });
const note = (id: string, value: string): RunEvent => ({ type: "message_commit", message_id: id, message: text("assistant", value) });
const navTree = call("nav-tree", "bash", { command: "tree src/auth test/auth" });
const navRead = call("nav-read", "read", { path: "src/auth/session.ts" });
const reviewerRg = call("rv-rg", "bash", { command: "rg -n 'refresh_token' src/auth" });
const reviewerRead = call("rv-read", "read", { path: "src/auth/session.ts" });
const testerRead = call("ts-read", "read", { path: "test/auth/session.test.ts" });
const testerRun = call("ts-run", "bash", { command: "rm -rf .cache && bun test test/auth" });
const researcherFetch = call("rs-fetch", "fetch", { url: "https://datatracker.ietf.org/doc/html/rfc6819" });
const researcherSearch = call("rs-search", "websearch", { query: "refresh token rotation reuse detection" });
const sessionSource = 'export async function refresh(token: string) {\n  const session = await store.get(token);\n  if (!session) {\n    log.warn("refresh failed", { token });\n    throw new AuthError("expired");\n  }\n  return rotate(session);\n}\n';
const subAgentStates: RunEvent[] = [
  agent("st-run", "running", { name: "reviewer", task: "audit src/auth for token leaks", startedAt: ago(134), toolCount: 7, latestActivity: "$ bun test test/auth" }),
  agent("st-approve", "waiting_approval", { urgency: "approval", name: "deployer", task: "ship the preview build", startedAt: ago(48), toolCount: 3, latestActivity: "wants to run: vercel deploy --prebuilt" }),
  agent("st-input", "waiting_input", { urgency: "input", name: "planner", task: "pick a cache strategy", startedAt: ago(301), toolCount: 2, latestActivity: "asked: keep redis, or move to sqlite?" }),
  agent("st-idle", "idle", { name: "watcher", task: "watch CI for flaky tests", startedAt: ago(4_000), toolCount: 18, latestActivity: "no new failures in the last 3 runs" }),
  agent("st-done", "done", { name: "researcher", task: "find prior art for refresh-token rotation", startedAt: "2026-11-02T10:00:00Z", endedAt: "2026-11-02T10:03:41Z", toolCount: 12, summary: "3 sources agree: rotate on every use, revoke the family on reuse" }),
  agent("st-error", "error", { name: "fixer", task: "fix the flaky transport test", startedAt: "2026-11-02T10:00:00Z", endedAt: "2026-11-02T10:01:09Z", toolCount: 5, summary: "bun test: 2 failing in transport.test.ts" }),
  agent("st-canceled", "canceled", { name: "migrator", task: "rename the sessions table", startedAt: "2026-11-02T10:00:00Z", endedAt: "2026-11-02T10:00:12Z", toolCount: 1, summary: "canceled by the parent" }),
  agent("st-old", "done", { name: "docs", task: "update docs/auth.md", toolCount: 4, summary: "updated 3 sections" }),
  agent("st-long", "running", { name: "dependency-upgrade-coordinator", task: "upgrade every workspace package to the latest minor version, run the full test suite after each one, and roll back any upgrade that breaks a test or the bundle size budget", startedAt: ago(1_260), toolCount: 143, latestActivity: "$ bun update --latest @types/node typescript vite playwright @happy-dom/global-registrator && bun test && bun run size:check" }),
];
const stateRuns = Object.fromEntries(["st-run", "st-approve", "st-input", "st-idle", "st-done", "st-error", "st-canceled", "st-long"].map((id) => [id, [note(`${id}-note`, `The ${id.slice(3)} child run's own transcript opens here.`)]]));

// A run whose end the host could not observe: the transport dropped output before the run ended.
const unknownEnd: RunEvent[] = [
  { type: "run_start" },
  { type: "user_message", text: "Rebuild the docs site and tell me what changed.", mode: "default" },
  ...stream("unknown-m1", "Rebuilding the docs site now; the output is long, so this takes a minute."),
  { type: "run_end", outcome: "unknown" },
];

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
        view: { kind: "shell", command: String(build.arguments.command), exitCode: 1, stdout: buildStdout, stderr: buildStderr, durationMs: 312 },
      }),
      start(readConfig),
      end(readConfig, config),
      start(run.grep, grepView(run.grep)),
      ...grepLines.map((line) => out(run.grep, line)),
      end(run.grep, grepLines.join("")),
      ask("r-edit", run.edit),
      { type: "approval_end", request_id: "r-edit", decision: "approve" },
      start(run.edit),
      end(run.edit, finished.edit),
      start(run.bash),
      out(run.bash, testOutput),
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
    id: "message-user-long",
    part: "Message",
    title: "user role, wrapping",
    description: "A long user message: the prompt mark hangs in its own column and every line starts at the text edge.",
    events: [{ type: "message_commit", message_id: "m-user-long", message: text("user", userParityText) }],
  },
  {
    id: "message-user-dropped",
    part: "Message",
    title: "user role, dropped-delivery text",
    description: "The committed-message geometry reference for a dropped user_message row.",
    events: [{ type: "message_commit", message_id: "m-user-dropped", message: text("user", `${userParityText} · not delivered · abort`) }],
  },
  {
    id: "message-user-markdown",
    part: "Message",
    title: "user role, markdown",
    description: "markdownFor=\"all\": user text renders as markdown and keeps the same prompt column.",
    events: [{ type: "message_commit", message_id: "m-user-md", message: text("user", "Please check why the **transport tests** fail on CI but pass locally, then compare the retry timing with `reconnect()`.") }],
    markdownAll: true,
  },
  {
    id: "message-long",
    part: "Message",
    title: "long text",
    description: "Paragraphs, a very long URL, and a very long word.",
    events: [{ type: "message_commit", message_id: "m-long", message: text("assistant", longText) }],
  },
  {
    id: "markdown-streaming",
    part: "Message",
    title: "markdown and code, streaming",
    description: "The real @fulcrum/markdown renderer streams inline code, blocks, tables, and highlighted TypeScript and diff fences.",
    events: stream("markdown-live", markdownDemo),
    live: 45,
  },
  {
    id: "markdown-done",
    part: "Message",
    title: "markdown and code, done",
    description: "The same real markdown and highlight stack after the message commits.",
    events: [{ type: "message_commit", message_id: "markdown-done", message: text("assistant", markdownDemo) }],
  },
  {
    id: "markdown-large",
    part: "Message",
    title: "markdown, a large code block",
    description: "A fence over 200 lines or 10,000 characters is the shared code viewer: a scroll box that mounts and highlights only its visible rows, with a line count and a copy control for the whole text.",
    events: [{ type: "message_commit", message_id: "markdown-large", message: text("assistant", "The whole generated table:\n\n```ts\n" + Array.from({ length: 400 }, (_, i) => `export const value${i} = compute(${i}, "item-${i}"); // row ${i}`).join("\n") + "\n```\n") }],
  },
  {
    id: "markdown-crossing",
    part: "Message",
    title: "markdown, a fence that becomes the viewer",
    description: "A fence streams past 40 lines and becomes the bounded viewer at the same height, keeping its colors and following its newest line.",
    events: [
      ...Array.from({ length: 60 }, (_, i): RunEvent => ({ type: "message_delta", message_id: "markdown-crossing", delta: (i ? "" : "Generating the table:\n\n```ts\n") + `export const value${i} = compute(${i}, "item-${i}");\n` })),
      { type: "message_commit", message_id: "markdown-crossing", message: text("assistant", "Generating the table:\n\n```ts\n" + Array.from({ length: 60 }, (_, i) => `export const value${i} = compute(${i}, "item-${i}");\n`).join("") + "```\n") },
    ],
    live: 60,
  },
  {
    id: "markdown-large-constructs",
    part: "Message",
    title: "markdown, constructs across ranges",
    description: "A large fence colors its visible ranges first, then the whole block in the background: a 2,000-character block comment and a python docstring keep their colors past every range edge.",
    events: [{ type: "message_commit", message_id: "markdown-large-constructs", message: text("assistant", "A license header, then a docstring:\n\n```cpp\n/*\n" + Array.from({ length: 28 }, () => " *" + " lorem".repeat(12)).join("\n") + "\n */\n" + Array.from({ length: 220 }, (_, i) => `int value${i} = ${i};`).join("\n") + "\n```\n\n```python\n\"\"\"\n" + Array.from({ length: 28 }, () => "   " + " ipsum".repeat(12)).join("\n") + "\n\"\"\"\n" + Array.from({ length: 220 }, (_, i) => `value_${i} = ${i}`).join("\n") + "\n```\n") }],
  },
  {
    id: "user-block-indent",
    part: "Message",
    title: "user attachment, aligned",
    description: "The sent text keeps its prompt mark while the attachment row starts at the content edge.",
    events: [{ type: "message_commit", message_id: "user-block-indent", message: { role: "user", content: [{ type: "text", text: "please inspect this image" }, { type: "file", filename: "image.png", mediaType: "image/png", size: 12 }] } }],
  },
  {
    id: "user-first-blocks",
    part: "Message",
    title: "user role, first blocks",
    description: "Whatever block starts a user message, the prompt sits on its first text line, or at the top of an image.",
    events: [...[
      "# Release notes\n\nplease check these",
      "## Two problems\n\nboth on CI",
      "- the first item\n- the second item",
      "> the quoted line\n\nwhy does this fail?",
      "```ts\nconst retries = 3;\n```\n\nwhat does this do?",
      "```\nnpm test\n```",
      "```ts\n" + Array.from({ length: 48 }, (_, i) => `const value${i} = ${i};`).join("\n") + "\n```",
      "| test | time |\n| --- | --- |\n| transport | 2s |",
      { type: "file", filename: "image.png", mediaType: "image/png", size: 12 },
      chart,
      docs,
      { type: "reasoning", text: "the alias is wrong" },
    ].map((block, i): RunEvent => ({ type: "message_commit", message_id: `user-first-${i}`, message: { role: "user", content: [typeof block === "string" ? { type: "text", text: block } : block] } })),
      { type: "message_commit", message_id: "user-first-empty-file", message: { role: "user", content: [{ type: "text", text: "" }, { type: "file", filename: "empty-first.txt", mediaType: "text/plain", size: 0 }] } },
      { type: "message_commit", message_id: "user-first-empty-stream", message: { role: "user", content: [{ type: "text", text: "" }] } },
    ],
    markdownAll: true,
  },
  {
    id: "content-streaming",
    part: "Message",
    title: "content blocks, streaming",
    description: "Reasoning, text, sources, an image, and a file stream into one message in the order they arrive; the commit keeps that order.",
    events: blockStream("content-live", contentPieces),
    live: 70,
  },
  {
    id: "content-done",
    part: "Message",
    title: "content blocks, done",
    description: "The same message after it commits: reasoning closes to its word count, every other block keeps its place.",
    events: committed("content-done", contentPieces),
  },
  {
    id: "reasoning-streaming",
    part: "ReasoningBlock",
    title: "reasoning, streaming",
    description: "A closed disclosure that says \"thinking\" and shows its newest words; a screen reader hears \"reasoning finished\" once, when it ends.",
    events: blockStream("reasoning-live", [thinking]),
    live: 90,
  },
  {
    id: "reasoning-done",
    part: "ReasoningBlock",
    title: "reasoning, done and redacted",
    description: "Finished reasoning shows its word count and opens on click; redacted reasoning (encrypted by the provider) says so.",
    events: committed("reasoning-done", [thinking, { type: "reasoning", text: "", redacted: true }, "The alias belongs in the server block."]),
  },
  {
    id: "source-streaming",
    part: "SourceBlock",
    title: "sources, streaming",
    description: "Sources arrive whole, in their place among the text.",
    events: blockStream("source-live", ["Both fixes are documented. ", docs, issue, guide, "The first is the one to use."]),
    live: 120,
  },
  {
    id: "source-done",
    part: "SourceBlock",
    title: "sources, done",
    description: "A web page links out (http, https, mailto only), a document shows its type, and an unsafe address is not a link.",
    events: committed("source-done", [docs, guide, { type: "source", kind: "source", url: "mailto:build@example.com", title: "build team" }, { type: "source", kind: "source", url: "javascript:alert(1)", title: "unsafe link, shown as text" }]),
  },
  {
    id: "file-streaming",
    part: "FileBlock",
    title: "files, streaming",
    description: "A generated file arrives mid-answer.",
    events: blockStream("file-live", ["The bundle report is ready: ", report, "Open it to see each chunk."]),
    live: 120,
  },
  {
    id: "file-done",
    part: "FileBlock",
    title: "files, done",
    description: "Name, media type, and size; open goes through the host's onOpen, else the file's http(s) link. An inline file with no host callback has no link.",
    events: committed("file-done", [report, trace]),
  },
  {
    id: "image-streaming",
    part: "ImageBlock",
    title: "images, streaming",
    description: "The image's box is reserved before it loads, so the text after it never moves.",
    events: blockStream("image-live", ["Bundle size per entry: ", chart, "The largest entry is the editor."]),
    live: 120,
  },
  {
    id: "image-done",
    part: "ImageBlock",
    title: "images, done",
    description: "A known size reserves its exact shape; an unknown size gets a fixed frame; an unsafe address (an inline svg) is not drawn. Click an image to open it.",
    events: committed("image-done", [chart, unsized, blocked]),
  },
  {
    id: "tool-images",
    part: "ToolResultBlocks",
    title: "tool result images",
    description: "A tool's image results show under its output, in a box reserved before they load; the card opens for them. zeta sends these as tool_result.content_blocks (a read of a png, an MCP chart with a caption and size).",
    events: (() => {
      const tool = call("tool-images", "render_chart", { entries: 7 });
      return [start(tool), { type: "tool_end", tool_call: tool, tool_result: { tool_call_id: tool.id, content: "[image block] media_type=image/png dimensions=640x360 bytes=2940 caption=bundle size per entry, in kB", is_error: false, blocks: [chart] } }];
    })(),
  },
  {
    id: "unknown-streaming",
    part: "UnknownBlock",
    title: "unsupported block, streaming",
    description: "A block type the renderer does not know arrives mid-stream: it keeps its place and its data.",
    events: blockStream("unknown-live", ["Here is the chart spec: ", custom, "Render it with your charting tool."]),
    live: 120,
  },
  {
    id: "unknown-done",
    part: "UnknownBlock",
    title: "unsupported block, done",
    description: "Its type on one line; \"show json\" reveals the whole block and copy takes it, so nothing an adapter sent is lost.",
    events: committed("unknown-done", [custom]),
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
    events: every("done").flatMap(({ tool, view }) => [start(tool, view), end(tool, finished[key(tool)]!, { view: finishedView(tool) })]),
  },
  {
    id: "tools-error",
    part: "ToolCall",
    title: "every card, failed",
    description: "Each result has is_error=true: the reason shows in the body, the rail and the status word say failed.",
    events: every("error").flatMap(({ tool, view }) => [
      start(tool, view),
      end(tool, failed[key(tool)]!, { error: true, view: failedView(tool) }),
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
    description: "The header cuts the command to one line (up to four on narrow screens); the body repeats it in full above the output, up to 8 lines, then a control shows the rest.",
    events: (() => {
      const tool = call("long", "bash", { command: longCommand });
      const script = call("long-script", "bash", { command: heredoc });
      return [
        start(tool), end(tool, "  14 packages/core/src/store.ts:12\n   9 packages/zeta/src/client.ts:41\n"),
        start(script), end(script, "wrote scripts/release.sh\n"),
      ];
    })(),
  },
  {
    id: "tool-huge",
    part: "ToolCall",
    open: true,
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
    open: true,
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
    id: "tool-languages",
    part: "ToolCall",
    title: "read, more languages",
    description: "Rust, Go, SQL, a Dockerfile, and a shell script, each colored from its first line.",
    events: languageFiles.flatMap(([path, source], index) => {
      const tool = call(`lang-${index}`, "read", { path });
      return [start(tool), end(tool, source)];
    }),
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
    description: "After approval_end the buttons go away and the row says how it ended: approved (folded into its tool card once the call runs, so one call is one row), denied, or the reason, such as a lost connection.",
    events: (() => {
      const c = calls("ap");
      return [
        ask("r-done", c.edit), { type: "approval_end", request_id: "r-done", decision: "approve" }, start(c.edit), end(c.edit, "1 replacement"),
        ask("r-deny", c.bash), { type: "approval_end", request_id: "r-deny", decision: "deny" },
        ask("r-lost", c.write), { type: "approval_end", request_id: "r-lost", decision: "abort", data: { reason: "controller_disconnected" } },
      ];
    })(),
  },
  {
    id: "approval-endings",
    part: "Approval",
    title: "every ending, on every card state",
    description: "Each way an approval ends (approved, denied, a lost connection, an abort with no reason, an end with no decision), folded into a call that finished, failed, was canceled, or still runs. Every word is readable in every theme.",
    events: (() => {
      const endings = [{ decision: "approve" }, { decision: "deny" }, { decision: "abort", data: { reason: "controller_disconnected" } }, { decision: "abort" }, {}] as const;
      const states = ["done", "error", "canceled", "running"] as const;
      return endings.flatMap((ending, e) => states.flatMap((state, s): RunEvent[] => {
        const tool = call(`ending-${e}-${s}`, "bash", { command: `bun run step-${e}-${s}` });
        const id = `r-ending-${e}-${s}`;
        const asked: RunEvent[] = [ask(id, tool), { type: "approval_end", request_id: id, ...ending }, start(tool)];
        if (state === "running") return asked;
        return [...asked, end(tool, state === "canceled" ? "canceled by user" : state === "error" ? "exit 1" : "ok\n", { error: state === "error", canceled: state === "canceled" })];
      }));
    })(),
  },
  {
    id: "subagent-states",
    part: "SubAgent",
    title: "every state",
    description: "One fixed-height row per child run: state, name, task, elapsed time, tool count, and the latest activity. Waiting on you is a warn badge. Click a row (or Enter) to open its run; \"docs\" started before child runs were recorded, so it says why it cannot open.",
    events: subAgentStates,
    runs: stateRuns,
  },
  {
    id: "run-status-outcome",
    part: "RunStatus",
    title: "running, then outcome unknown",
    description: "The compact header status: running while the run streams, then \"outcome unknown\" in the warn color when the run ended where the host could not see how. The next run start clears it.",
    live: 300,
    events: unknownEnd,
  },
  {
    id: "run-end-marker-unknown",
    part: "RunEndMarker",
    title: "outcome unknown",
    description: "The compact marker a host places after the transcript. It renders only for an unknown outcome and has screen-reader text \"run ended while disconnected; outcome unknown\".",
    events: unknownEnd,
  },
  {
    id: "run-navigator-nested",
    part: "RunNavigator",
    title: "nested drill-in, streaming",
    description: "A run with three sub-agents streaming in step. Open reviewer, then its tester, and approve or deny there: the badge clears on every level. Back, Escape, or browser back return to where you were reading.",
    live: 450,
    events: [
      { type: "user_message", text: "Audit the auth module for token leaks and check how others rotate refresh tokens.", mode: "default" },
      start(navTree),
      end(navTree, "src/auth\n├── rotate.ts\n├── session.ts\n└── tokens.ts\ntest/auth\n└── session.test.ts\n", { view: { kind: "shell", command: String(navTree.arguments.command), exitCode: 0, durationMs: 12 } }),
      start(navRead),
      end(navRead, sessionSource),
      ...stream("nav-m1", "I will split this: a reviewer audits src/auth, a researcher reads prior art, and the docs agent from yesterday stays as it was."),
      agent("docs-old", "done", { name: "docs", task: "update docs/auth.md", toolCount: 4, summary: "updated 3 sections" }),
      agent("reviewer", "running", { name: "reviewer", task: "audit src/auth for token leaks", startedAt: ago(95), toolCount: 0, latestActivity: "starting" }),
      agent("researcher", "running", { name: "researcher", task: "find prior art for refresh-token rotation", startedAt: ago(95), toolCount: 0, latestActivity: "starting" }),
      agent("reviewer", "running", { toolCount: 1, latestActivity: "$ rg -n 'refresh_token' src/auth" }),
      agent("researcher", "running", { toolCount: 1, latestActivity: "fetch datatracker.ietf.org/doc/html/rfc6819" }),
      agent("reviewer", "running", { toolCount: 2, latestActivity: "read src/auth/session.ts" }),
      agent("researcher", "running", { toolCount: 2, latestActivity: "search \"refresh token rotation reuse detection\"" }),
      agent("reviewer", "running", { latestActivity: "found a leak: the refresh token is logged on failure" }),
      agent("researcher", "done", { endedAt: ago(20), summary: "rotate on every use; revoke the whole family on reuse" }),
      agent("reviewer", "running", { latestActivity: "started tester to confirm the fix" }),
      agent("reviewer", "waiting_approval", { urgency: "approval", latestActivity: "tester needs approval: rm -rf .cache && bun test test/auth" }),
      ...stream("nav-m2", "The researcher is done. The reviewer's tester is waiting for your approval before it runs the auth tests."),
    ],
    runs: {
      reviewer: [
        { type: "user_message", text: "Audit src/auth for token leaks.", mode: "default" },
        start(reviewerRg),
        end(reviewerRg, "src/auth/session.ts:4:    log.warn(\"refresh failed\", { token });\nsrc/auth/rotate.ts:12:  return { refresh_token: next };\n", { view: { kind: "shell", command: String(reviewerRg.arguments.command), exitCode: 0, durationMs: 41 } }),
        start(reviewerRead),
        end(reviewerRead, sessionSource),
        ...stream("rv-m1", "Line 4 logs the raw refresh token when a refresh fails. I will drop it from the log and start a tester to confirm nothing else depends on it."),
        agent("tester", "running", { name: "tester", task: "run the auth tests after the fix", startedAt: ago(60), toolCount: 0, latestActivity: "starting" }),
        agent("tester", "running", { toolCount: 1, latestActivity: "read test/auth/session.test.ts" }),
        agent("tester", "waiting_approval", { urgency: "approval", toolCount: 2, latestActivity: "wants to run: rm -rf .cache && bun test test/auth" }),
      ],
      tester: [
        { type: "user_message", text: "Run the auth tests after the fix.", mode: "default" },
        ...stream("ts-m1", "Reading the session tests first, then a clean run."),
        start(testerRead),
        end(testerRead, 'import { refresh } from "../../src/auth/session";\n\ntest("refresh rotates", async () => {\n  expect(await refresh("t1")).not.toBe("t1");\n});\n'),
        { type: "approval_request", request_id: "r-tester", tool_call: testerRun, view: viewOf(testerRun), delegated: true },
      ],
      researcher: [
        { type: "user_message", text: "Find prior art for refresh-token rotation.", mode: "default" },
        start(researcherFetch),
        end(researcherFetch, "OAuth 2.0 Threat Model and Security Considerations\n5.2.2.3. Refresh Token Rotation: the authorization server issues a new refresh token with every access token refresh response."),
        start(researcherSearch),
        end(researcherSearch, "1. Refresh token rotation - auth0.com/docs\n2. Reuse detection - datatracker.ietf.org/doc/html/draft-ietf-oauth-security-topics"),
        ...stream("rs-m1", "All three sources agree: **rotate on every use**, and when an old token is reused, revoke the whole token family."),
      ],
    },
  },
  {
    id: "fallback-user",
    part: "Fallback",
    title: "user message",
    description: "A wrapping user_message event (kind \"user\") with an attachment.",
    events: [{
      type: "user_message",
      text: userParityText,
      mode: "default",
      attachments: [{ type: "file", kind: "file", filename: "ci-build.log", mediaType: "text/plain", size: 12_345 }],
    }],
  },
  {
    id: "fallback-user-parity",
    part: "Fallback",
    title: "user message parity",
    description: "The same wrapping text as the committed Message fixture, without an attachment.",
    events: [{ type: "user_message", text: userParityText, mode: "default" }],
  },
  {
    id: "fallback-user-dropped",
    part: "Fallback",
    title: "dropped steer",
    description: "A dropped steer keeps the shared user layout and adds its delivery outcome.",
    events: [
      { type: "user_message", text: userParityText, mode: "steer", delivery_id: "gallery-dropped" },
      { type: "delivery_status", delivery_id: "gallery-dropped", method: "steer", status: "dropped", content: "steer dropped: abort", reason: "abort" },
    ],
  },
  {
    id: "fallback-error",
    part: "Fallback",
    title: "error",
    description: "An error event (kind \"error\").",
    events: [{ type: "error", error: { code: "rate_limited", message: "Rate limited by the model provider. Retrying in 30s." } }],
  },
  {
    id: "fallback-stopped",
    part: "Fallback",
    title: "stopped",
    description: "The user's own stop (an error event with code \"aborted\"): a neutral row, not an error.",
    events: [{ type: "error", error: { code: "aborted", message: "turn aborted" } }],
  },
  {
    id: "fallback-notification",
    part: "Fallback",
    title: "notification",
    description: "A notification event: the fallback shows its text.",
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

const viewerParams = typeof location === "undefined" ? null : new URLSearchParams(location.search);
const viewerFixture = viewerParams?.get("viewerFixture") ?? null;
// `read` is a 1,000,000-line TypeScript file, highlighted row by row as the viewer mounts them.
if (viewerFixture === "single" || viewerFixture === "lines" || viewerFixture === "read") {
  const statements = ["let a = 1;\n", "a++;\n", "f(a);\n", "// c\n"];
  const requestedLines = Number(viewerParams?.get("viewerLines"));
  const readLines = Number.isInteger(requestedLines) && requestedLines > 0 ? Math.min(requestedLines, 1_000_000) : 1_000_000;
  const fixture = viewerFixture === "single" ? "x".repeat(2_000_000) : viewerFixture === "lines" ? "x\n".repeat(1_000_000) : Array.from({ length: readLines }, (_, i) => statements[i % 4]).join("");
  const tool = call("viewer-check", "bash", { command: "stream fixture" });
  const view: ToolView = viewerFixture === "read" ? { kind: "read", path: "src/huge.ts" } : { kind: "shell", command: "stream fixture" };
  demos.splice(0, demos.length, {
    id: "text-viewer-check",
    part: "ToolCall",
    title: `${viewerFixture} text viewer check`,
    description: "browser-only layout fixture for measured text viewer behavior",
    events: [start(tool, view), out(tool, fixture)],
  });
}
// `edit` is a 40,000-line TypeScript diff and `search` 20,000 matches in 400 files: the viewer keeps their structure.
if (viewerFixture === "edit" || viewerFixture === "search") {
  const tool = call("viewer-check", viewerFixture === "edit" ? "edit" : "grep", {});
  const diff = Array.from({ length: 10_000 }, (_, i) => `@@ -${i * 3 + 1},2 +${i * 3 + 1},2 @@\n const a${i} = 1;\n-let count = ${i};\n+let count = ${i + 1};\n`).join("");
  const matches = Array.from({ length: 20_000 }, (_, i) => (i % 100 < 50 ? `src/f${(i / 50) | 0}.ts:${i}:  const todo = "TODO ${i}";` : `docs/n${(i / 50) | 0}.md:${i}:- FIXME **later** ${i}`)).join("\n");
  const view: ToolView = viewerFixture === "edit" ? { kind: "edit", path: "src/huge.ts", diff } : { kind: "search", pattern: "TODO|FIXME" };
  demos.splice(0, demos.length, {
    id: "text-viewer-check",
    part: "ToolCall",
    title: `${viewerFixture} structured viewer check`,
    description: "browser-only layout fixture: a large structured tool output keeps its rows in the viewer",
    events: viewerFixture === "edit" ? [start(tool, view)] : [start(tool, view), out(tool, matches)],
  });
}
