// A scripted `zeta serve --ws` for the browser gate and for trying the app without a real zeta. It speaks the subset
// of protocol 1.2 the app uses (hello, list_sessions, status, resume, session_history, approve, deny), checks the
// token and Origin like the real upgrade, and writes the discovery file under its own ZETA_HOME, never ~/.zeta.
//
// Manual use: `bun scripts/fake-zeta.ts`, then start vite with the printed ZETA_HOME.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";

type Json = Record<string, unknown>;
export type Mode = "ok" | "busy" | "incompatible" | "slow";

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const meta = (id: string, minutesAgo: number, extra: Json = {}) => ({
  version: 1, session_id: id, created_at: at(minutesAgo + 30), updated_at: at(minutesAgo), provider: "claude", model: "claude-opus-4-6",
  cwd: "/Users/dev/me/fun/fulcrum", name: "", parent_session_id: null, approval_mode: "ask", ...extra,
});

export const ACTIVE = "s-reconnect";
export const LONG = "s-long";
const sessions = [
  meta(ACTIVE, 2, { name: "fix the flaky reconnect test in packages/zeta" }),
  meta("s-themes", 45, { first_message_preview: "check every theme's muted text against 4.5:1 on the surface color" }),
  meta(LONG, 60 * 5, { first_message_preview: "profile the virtual timeline with 400 rows of history" }),
  meta("s-child", 3, { parent_session_id: ACTIVE, first_message_preview: "worker: run the zeta tests" }),
  meta("s-markdown", 60 * 26, { name: "streaming markdown: nested lists in block quotes", model: "gpt-5.1-codex" }),
  meta("s-docs", 60 * 24 * 3, { first_message_preview: "write the quickstart for @fulcrum/react" }),
  meta("s-untitled", 60 * 24 * 40),
];

const text = (value: string) => ({ type: "text", text: value });
const toolUse = (id: string, name: string) => ({ type: "tool_use", tool_call: { id, name, arguments: {} } });
const result = (id: string, content: string, extra: Json = {}) => ({ tool_call_id: id, content, is_error: false, content_blocks: [], structured_content: null, ...extra });
const histories: Record<string, Json[]> = {
  [ACTIVE]: [
    { id: "h1", role: "user", content: [text("the reconnect test in packages/zeta fails about one run in ten. find out why and fix it.")], tool_result: null },
    { id: "h2", role: "assistant", content: [{ type: "thinking", text: "start with the test and the client close path." }, text("I will read the test first, then run it in a loop."), toolUse("c1", "read")], tool_result: null },
    { id: "h3", role: "tool_result", content: [text("")], tool_result: result("c1", "import { expect, test } from \"bun:test\";\nimport { connect } from \"../src/index.js\";\n\ntest(\"reconnects\", async () => {\n  const client = connect(transport);\n  await client.hello();\n});") },
    { id: "h4", role: "assistant", content: [toolUse("c2", "bash")], tool_result: null },
    { id: "h5", role: "tool_result", content: [text("")], tool_result: result("c2", "bun test v1.3.13\n\n packages/zeta/test/rpc.test.ts:\n(fail) reconnects [5003.12ms]\n  timed out after 5000ms\n\n 4 pass\n 1 fail") },
    {
      id: "h6", role: "assistant", tool_result: null, content: [text(
        "The failure is a race in the close path:\n\n1. `transport.close()` fires `onClose` **before** pending requests reject.\n2. The test awaits `hello()`, which never settles.\n\n```ts\ntransport.onClose?.((code) => {\n  const error = rejectPending(code); // reject first\n  closeListeners.forEach((listener) => listener(error));\n});\n```\n\nI will fix the order and add a test that fails without it.",
      )],
    },
  ],
  "s-themes": [
    { id: "t1", role: "user", content: [text("check every theme's muted text against 4.5:1 on the surface color")], tool_result: null },
    { id: "t2", role: "assistant", content: [text("All 12 themes pass on `bg`. On `surface`, **solarized-light** is closest at 4.61:1.\n\n| theme | bg | surface |\n| --- | --- | --- |\n| gruvbox-dark | 5.9 | 5.4 |\n| solarized-light | 4.9 | 4.61 |")], tool_result: null },
  ],
  [LONG]: Array.from({ length: 400 }, (_, index) => index % 2 === 0
    ? { id: `l${index}`, role: "user", content: [text(`step ${index / 2 + 1}: measure frame ${index}`)], tool_result: null }
    : { id: `l${index}`, role: "assistant", content: [text(`frame ${index} took **${(index % 7) + 3} ms**; \`content-visibility\` skipped ${index * 3} rows.`)], tool_result: null }),
};

/** The live turn that runs when the active session opens: prose, code, a shell call, an approval, then a summary. */
const liveTurn = (send: (event: Json) => void, ask: () => Promise<"approve" | "deny">, wait: (ms: number) => Promise<void>, done: () => void) => async () => {
  // Committed rows also land in history, as in zeta, so a reconnect rebuilds what the live stream showed.
  const history = histories[ACTIVE]!;
  const row = (id: string, role: string, content: Json[], toolResult: Json | null = null) => history.push({ id, role, content, tool_result: toolResult });
  const e = (event: string, body: Json = {}) => send({ event, session_id: ACTIVE, ...body });
  e("agent_start");
  e("turn_start", { data: { turn: 2 } });
  for (const chunk of ["Running the test ", "in a loop to confirm ", "the race:\n\n```sh\nfor i in $(seq 20); do bun test test/rpc.test.ts; done\n```\n"]) {
    e("assistant_delta", { delta: chunk, kind: "assistant" });
    await wait(40);
  }
  e("assistant_message", { message: { role: "assistant", content: [text("Running the test in a loop to confirm the race:\n\n```sh\nfor i in $(seq 20); do bun test test/rpc.test.ts; done\n```\n")] } });
  const loop = { id: "live-1", name: "bash", arguments: { command: "for i in $(seq 20); do bun test test/rpc.test.ts; done" } };
  row("r1", "assistant", [text("Running the test in a loop to confirm the race:\n\n```sh\nfor i in $(seq 20); do bun test test/rpc.test.ts; done\n```\n"), toolUse("live-1", "bash")]);
  e("tool_start", { tool_call: loop, data: {} });
  for (let run = 1; run <= 3; run++) {
    e("tool_output", { tool_call: loop, output: `run ${run}: 5 pass, 0 fail\n`, data: {} });
    await wait(40);
  }
  row("r2", "tool_result", [text("")], result("live-1", "run 1: 5 pass, 0 fail\nrun 2: 5 pass, 0 fail\nrun 3: 5 pass, 0 fail\n"));
  e("tool_end", { tool_call: loop, tool_result: result("live-1", "run 1: 5 pass, 0 fail\nrun 2: 5 pass, 0 fail\nrun 3: 5 pass, 0 fail\n", { structured_content: { exit_code: 0, stdout: "run 1: 5 pass, 0 fail\nrun 2: 5 pass, 0 fail\nrun 3: 5 pass, 0 fail\n", stderr: "" } }), data: {} });
  const clean = { id: "live-2", name: "bash", arguments: { command: "rm -rf packages/zeta/dist && bun run build" } };
  row("r3", "assistant", [toolUse("live-2", "bash")]);
  const approval = ask();
  e("approval_request", { request_id: "approval-1", tool_call: clean, delegated: false });
  const decision = await approval;
  e("approval_end", { request_id: "approval-1", data: { decision } });
  if (decision === "approve") {
    e("tool_start", { tool_call: clean, data: {} });
    row("r4", "tool_result", [text("")], result("live-2", "built 9 packages in 2.1s\n"));
    e("tool_end", { tool_call: clean, tool_result: result("live-2", "built 9 packages in 2.1s\n", { structured_content: { exit_code: 0, stdout: "built 9 packages in 2.1s\n", stderr: "" } }), data: {} });
  }
  const summary = decision === "approve" ? "Fixed: **20 of 20** runs pass, and the new test failed before the change." : "Skipped the rebuild. The fix is in place; run `bun run build` when ready.";
  row("r5", "assistant", [text(summary)]);
  e("assistant_message", { message: { role: "assistant", content: [text(summary)] } });
  e("turn_end", { data: { turn: 2, tool_calls: 2 } });
  done();
  e("agent_end");
};

export async function startFakeZeta({ origins, port = 0, live = true }: { origins: string[]; port?: number; live?: boolean }) {
  const home = await mkdtemp(join(tmpdir(), "fulcrum-web-zeta-"));
  await mkdir(join(home, "run"), { recursive: true });
  const discovery = join(home, "run", "serve.ws.json");
  let token = crypto.randomUUID();
  let mode: Mode = "ok";
  let allowed = origins;
  let active: string | null = ACTIVE;
  let decide: ((decision: "approve" | "deny") => void) | null = null;
  let turnStarted = false;
  let running = false;
  const decisions: Json[] = [];
  const sockets = new Set<ServerWebSocket<unknown>>();
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request, bun) {
      const url = new URL(request.url);
      const origin = request.headers.get("origin");
      if (url.searchParams.get("token") !== token || (origin && !allowed.includes(origin))) return new Response("forbidden", { status: 403 });
      return bun.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(socket) { sockets.add(socket); },
      close(socket) { sockets.delete(socket); },
      async message(socket, raw) {
        const { id, method, params = {} } = JSON.parse(String(raw)) as { id: number; method: string; params: Json };
        const reply = (body: Json) => socket.send(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
        const send = (event: Json) => { for (const each of sockets) each.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: event })); };
        if (method === "hello") {
          if (mode === "busy" || sockets.size > 1) { socket.send(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "server busy" } })); socket.close(); return; }
          if (mode === "incompatible") { reply({ error: { code: -32002, message: "version mismatch", data: { requested: "1.0", supported: ["2.0"] } } }); socket.close(); return; }
          if (mode === "slow") await wait(60_000);
          return reply({ result: { protocol_version: "1.2", server: "fake-zeta", capabilities: { features: (params.features as string[] | undefined)?.filter((name) => name === "list_sessions_paging") ?? [] } } });
        }
        if (method === "list_sessions") {
          const offset = Number(params.offset ?? 0);
          const limit = Number(params.limit ?? sessions.length);
          const page = sessions.slice(offset, offset + limit);
          return reply({ result: { sessions: page, next_offset: offset + limit < sessions.length ? offset + limit : null } });
        }
        if (method === "status") {
          const pending = decide ? [{ request_id: "approval-1", tool_call: { id: "live-2", name: "bash", arguments: { command: "rm -rf packages/zeta/dist && bun run build" } }, delegated: false }] : [];
          return reply({ result: { session: active ? sessions.find((session) => session.session_id === active) ?? null : null, state: running ? (decide ? "tool" : "running") : "idle", explicit_finish: false, pending_approvals: pending, usage: {}, compaction_markers: 0 } });
        }
        if (method === "resume") {
          if (running && params.session_id !== active) return reply({ error: { code: -32004, message: "a turn is already running" } });
          active = String(params.session_id);
          return reply({ result: { session: sessions.find((session) => session.session_id === active) } });
        }
        if (method === "session_history") {
          if (params.session_id !== active) return reply({ error: { code: -32003, message: "no active session" } });
          const rows = histories[active!] ?? [];
          const offset = Number(params.offset ?? 0);
          reply({ result: { messages: rows.slice(offset, offset + 8), next_offset: offset + 8 < rows.length ? offset + 8 : null } });
          // The run starts once, after the first open of the active session finishes its history.
          if (live && active === ACTIVE && offset + 8 >= rows.length && !turnStarted) {
            turnStarted = true;
            running = true;
            const ask = () => new Promise<"approve" | "deny">((resolve) => { decide = (decision) => { decide = null; resolve(decision); }; });
            setTimeout(() => void liveTurn(send, ask, wait, () => { running = false; })(), 300);
          }
          return;
        }
        if (method === "approve" || method === "deny") {
          decisions.push({ method, ...params });
          if (!decide || params.request_id !== "approval-1") return reply({ error: { code: -32006, message: "approval request is missing or already resolved" } });
          reply({ result: { accepted: true, request_id: params.request_id, decision: method } });
          return decide(method);
        }
        reply({ error: { code: -32601, message: `method not found: ${method}` } });
      },
    },
  });

  const write = (value: Json) => writeFile(discovery, JSON.stringify(value), { mode: 0o600 });
  await write({ port: server.port, token, pid: process.pid, origins: allowed });
  return {
    home,
    port: server.port,
    decisions,
    /** Closes every socket, like a network blip; the server keeps running. */
    drop() { for (const socket of sockets) socket.close(1012, "restart"); },
    /** Removes the discovery file and refuses upgrades, like a stopped server. */
    async stop() { allowed = []; await rm(discovery, { force: true }); this.drop(); },
    async start() { allowed = origins; token = crypto.randomUUID(); await write({ port: server.port, token, pid: process.pid, origins: allowed }); },
    /** Lists other origins in the allowlist, so this page's origin is missing. */
    async foreignOrigin() { allowed = ["http://localhost:5173"]; await write({ port: server.port, token, pid: process.pid, origins: allowed }); },
    /** Hands out a token the server will refuse. */
    async wrongToken() { await write({ port: server.port, token: "stale-token", pid: process.pid, origins: allowed }); },
    setMode(next: Mode) { mode = next; },
    async close() { this.drop(); server.stop(true); await rm(home, { recursive: true, force: true }); },
  };
}

if (import.meta.main) {
  const origin = process.env.WEB_ORIGIN ?? "http://localhost:5180";
  const fake = await startFakeZeta({ origins: [origin, origin.replace("localhost", "127.0.0.1")], port: Number(process.env.FAKE_ZETA_PORT ?? 0) });
  console.log(`fake zeta serve on 127.0.0.1:${fake.port} for ${origin}\nstart the app with:\n  ZETA_HOME=${fake.home} bun run --cwd apps/web dev\nctrl-c stops it and deletes ${fake.home}`);
  process.once("SIGINT", () => void fake.close().then(() => process.exit(0)));
}
