// A scripted `zeta serve --ws` for the browser gate and for trying the app without a real zeta. It speaks the subset
// of protocol 1.2 the app uses (hello, list_sessions, new_session, status, resume, session_history, approve, deny,
// send, steer, abort, with delivery and session_host_commands features), checks the
// token and Origin like the real upgrade, and writes the discovery file under its own ZETA_HOME, never ~/.zeta.
//
// Manual use: `bun scripts/fake-zeta.ts`, then start vite with the printed ZETA_HOME.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { validateHostCommands } from "@fulcrum/zeta";

type Json = Record<string, unknown>;
export type Mode = "ok" | "busy" | "busy-once" | "incompatible" | "slow" | "slow-catalog" | "broken-session" | "overflow" | "overflow-silent";
export type HistoryMode = "new" | "old";
export type ApprovalHistoryMode = "advertised-with-rows" | "not-advertised-with-rows" | "not-advertised-without-rows";

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const meta = (id: string, minutesAgo: number, extra: Json = {}) => ({
  version: 1, session_id: id, created_at: at(minutesAgo + 30), updated_at: at(minutesAgo), provider: "claude", model: "claude-opus-4-6",
  cwd: "/Users/dev/me/fun/fulcrum", name: "", parent_session_id: null, approval_mode: "ask", ...extra,
});

export const ACTIVE = "s-reconnect";
export const LONG = "s-long";
export const MANY = "s-many";
export const LARGE = "s-large-pages";
const seeded = [
  meta(ACTIVE, 2, { name: "fix the flaky reconnect test in packages/zeta" }),
  meta("s-themes", 45, { first_message_preview: "check every theme's muted text against 4.5:1 on the surface color" }),
  meta(LONG, 60 * 5, { first_message_preview: "profile the virtual timeline with 400 rows of history" }),
  meta("s-child", 3, { parent_session_id: ACTIVE, first_message_preview: "worker: run the zeta tests" }),
  meta("s-markdown", 60 * 26, { name: "streaming markdown: nested lists in block quotes", model: "gpt-5.1-codex" }),
  meta("s-docs", 60 * 24 * 3, { first_message_preview: "write the quickstart for @fulcrum/react" }),
  meta("s-untitled", 60 * 24 * 40),
];

const text = (value: string) => ({ type: "text", text: value });
const fakeImage = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (character) => character.charCodeAt(0));
const fakeImageHandle = "fake-history-image";
const toolUse = (id: string, name: string, args: Json = {}) => ({ type: "tool_use", tool_call: { id, name, arguments: args } });
// History keeps a result's text only; bash's is "stdout:\n" + stdout + "\nstderr:\n" + stderr (zeta src/zeta/tools/bash).
const result = (id: string, content: string, extra: Json = {}) => ({ tool_call_id: id, content, is_error: false, content_blocks: [], structured_content: null, ...extra });
const histories: Record<string, Json[]> = {
  [ACTIVE]: [
    { id: "h1", role: "user", content: [text("the reconnect test in packages/zeta fails about one run in ten. find out why and fix it."), { type: "attachment", name: "reconnect.png", size: fakeImage.byteLength, handle: fakeImageHandle }], tool_result: null },
    { id: "h2", role: "assistant", content: [{ type: "thinking", text: "start with the test and the client close path." }, text("I will read the test first, then run it in a loop."), toolUse("c1", "read")], tool_result: null },
    { id: "h3", role: "tool_result", content: [text("")], tool_result: result("c1", "import { expect, test } from \"bun:test\";\nimport { connect } from \"../src/index.js\";\n\ntest(\"reconnects\", async () => {\n  const client = connect(transport);\n  await client.hello();\n});") },
    { id: "h4", role: "assistant", content: [toolUse("c2", "bash", { command: "bun test packages/zeta/test/rpc.test.ts" })], tool_result: null },
    { id: "h5", role: "tool_result", content: [text("")], tool_result: result("c2", "stdout:\nbun test v1.3.13\n\n packages/zeta/test/rpc.test.ts:\n(fail) reconnects [5003.12ms]\n  timed out after 5000ms\n\n 4 pass\n 1 fail\n\nstderr:\n", { is_error: true }) },
    {
      id: "h6", role: "assistant", tool_result: null, content: [text(
        "The failure is a race in the close path:\n\n1. `transport.close()` fires `onClose` **before** pending requests reject.\n2. The test awaits `hello()`, which never settles.\n\n```ts\ntransport.onClose?.((code) => {\n  const error = rejectPending(code); // reject first\n  closeListeners.forEach((listener) => listener(error));\n});\n```\n\nI will fix the order and add a test that fails without it.",
      )],
    },
  ],
  "s-themes": [
    { id: "t1", role: "user", content: [text("check every theme's muted text against 4.5:1 on the surface color")], tool_result: null },
    { id: "t1b", role: "assistant", content: [toolUse("t-ls", "bash")], tool_result: null },
    // As in zeta: tool_use arguments are emptied, but an approved call's approval rows keep them.
    { id: "t1b", role: "system", event: "approval_request", request_id: "t-ls", tool_call: { id: "t-ls", name: "bash", arguments: { command: "ls packages/react/src" } }, delegated: false },
    { id: "t1c", role: "system", event: "approval_end", request_id: "t-ls", tool_call: { id: "t-ls", name: "bash", arguments: { command: "ls packages/react/src" } }, data: { decision: "allow" } },
    { id: "t1d", role: "tool_result", content: [text("stdout:\nthemes.css\nthemes.ts\n\nstderr:\n")], tool_result: result("t-ls", "stdout:\nthemes.css\nthemes.ts\n\nstderr:\n") },
    { id: "t2", role: "assistant", content: [text("All 12 themes pass on `bg`. On `surface`, **solarized-light** is closest at 4.61:1.\n\n| theme | bg | surface |\n| --- | --- | --- |\n| gruvbox-dark | 5.9 | 5.4 |\n| solarized-light | 4.9 | 4.61 |")], tool_result: null },
  ],
  [LONG]: Array.from({ length: 400 }, (_, index) => index % 2 === 0
    ? { id: `l${index}`, role: "user", content: [text(`step ${index / 2 + 1}: measure frame ${index}`)], tool_result: null }
    : { id: `l${index}`, role: "assistant", content: [text(`frame ${index} took **${(index % 7) + 3} ms**; \`content-visibility\` skipped ${index * 3} rows.`)], tool_result: null }),
};

/** The live turn that runs when the active session opens: prose, code, a shell call, an approval, then a summary. */
const liveTurn = (send: (event: Json) => void, ask: () => Promise<"approve" | "deny" | "abort">, wait: (ms: number) => Promise<void>, turnId: string, done: (reason: "completed" | "disconnect") => void, historyMode: HistoryMode) => async () => {
  // Committed rows also land in history, as in zeta, so a reconnect rebuilds what the live stream showed.
  const history = histories[ACTIVE]!;
  const row = (id: string, role: string, content: Json[], toolResult: Json | null = null) => history.push({ id, role, content, tool_result: toolResult });
  const e = (event: string, body: Json = {}) => send({ event, session_id: ACTIVE, ...body });
  e("agent_start");
  e("turn_start", { data: { turn: 2, turn_id: turnId } });
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
  if (historyMode === "new") history.push({ id: "approval-request-1", role: "system", event: "approval_request", request_id: "approval-1", tool_call: clean, delegated: false });
  const decision = await approval;
  if (decision === "abort") return done("disconnect");
  // zeta's event says "allow" for an approve call (src/zeta/core/approval.py), not the method name.
  const wire = { decision: decision === "approve" ? "allow" : decision };
  e("approval_end", { request_id: "approval-1", data: wire });
  if (historyMode === "new") history.push({ id: "approval-end-1", role: "system", event: "approval_end", request_id: "approval-1", tool_call: clean, data: wire });
  if (decision === "approve") {
    e("tool_start", { tool_call: clean, data: {} });
    row("r4", "tool_result", [text("")], result("live-2", "built 9 packages in 2.1s\n"));
    e("tool_end", { tool_call: clean, tool_result: result("live-2", "built 9 packages in 2.1s\n", { structured_content: { exit_code: 0, stdout: "built 9 packages in 2.1s\n", stderr: "" } }), data: {} });
  }
  const summary = decision === "approve" ? "Fixed: **20 of 20** runs pass, and the new test failed before the change." : "Skipped the rebuild. The fix is in place; run `bun run build` when ready.";
  row("r5", "assistant", [text(summary)]);
  e("assistant_message", { message: { role: "assistant", content: [text(summary)] } });
  e("turn_end", { data: { turn: 2, tool_calls: 2 } });
  done("completed");
  e("agent_end");
};

/**
 * The composer's methods (send, steer, delivery_status, abort) with zeta's delivery_id rules. A send starts a
 * text-only reply that streams for about 2.5 s, long enough to steer and to stop. As in zeta, an accepted message is
 * echoed as `user_message` before the reply, and a steer is persisted only once a turn takes it.
 */
/**
 * zeta's durable whole-turn end (feature `served_turn_end`, docs/serve-protocol.md; row shape from
 * event_contract.served_turn_end_row). zeta writes it for every turn; `session_history` returns it only to a connection
 * that negotiated the feature.
 */
type TurnEndReason = "completed" | "user_stop" | "error" | "disconnect";
const servedTurnEnd = (turnId: string, reason: TurnEndReason): Json =>
  ({ id: `turn-end-${turnId}`, role: "system", event: "served_turn_end", data: { turn_id: turnId, reason } });

/** `turnIds` says whether the controller negotiated `served_turn_end`, so `turn_start` carries `data.turn_id`. */
export function composerMethods(
  wait: (ms: number) => Promise<void>,
  running: { get(): boolean; set(value: boolean): void },
  turnIds: () => boolean = () => false,
  recordEnd: (session: string, turnId: string, reason: TurnEndReason) => void = (session, turnId, reason) => {
    histories[session] = [...(histories[session] ?? []), servedTurnEnd(turnId, reason)];
  },
) {
  const sent: Json[] = [];
  const deliveries = new Map<string, Json>();
  const statuses = new Map<string, "queued" | "delivered" | "dropped">();
  let aborts = 0;
  let rows = 0; // history row ids stay unique when `clearSent` empties `sent`
  let chat: { session: string; id: string; steers: string[]; aborted: boolean } | null = null;
  type Send = (event: Json) => void;
  const chatTurn = async (session: string, send: Send) => {
    // steers holds delivery ids; the turn id is a lowercase uuid4 hex string, as zeta's
    const turn = { session, id: crypto.randomUUID().replaceAll("-", ""), steers: [] as string[], aborted: false };
    chat = turn;
    running.set(true);
    const e = (event: string, body: Json = {}) => { if (!turn.aborted) send({ event, session_id: session, ...body }); };
    e("agent_start");
    e("turn_start", { data: { turn: sent.length, ...(turnIds() ? { turn_id: turn.id } : {}) } });
    let reply = "";
    for (const word of "Reading the files you named, then running the focused tests before the full suite. ".repeat(3).match(/\S+\s*/g)!) {
      await wait(Number(process.env.FAKE_ZETA_WORD_MS ?? 60));
      if (turn.aborted) return;
      reply += word;
      e("assistant_delta", { delta: word, kind: "assistant" });
    }
    e("assistant_message", { message: { role: "assistant", content: [text(reply)] } });
    histories[session] = [...(histories[session] ?? []), { id: `reply-${rows}`, role: "assistant", content: [text(reply)], tool_result: null }];
    // As in zeta: a turn with no tool call reaches no provider boundary, so steering still queued at its end is dropped.
    for (const id of turn.steers) {
      statuses.set(id, "dropped");
      e("delivery_status", { delivery_id: id, method: "steer", status: "dropped", reason: "turn_end", content: "steer dropped: turn_end" });
      histories[session] = [...(histories[session] ?? []), { id: `delivery-${id}`, role: "system", event: "delivery_status", delivery_id: id, method: "steer", status: "dropped", reason: "turn_end", content: "steer dropped: turn_end" }];
    }
    e("turn_end", { data: { turn: sent.length } });
    recordEnd(session, turn.id, "completed");
    chat = null;
    running.set(false);
    e("agent_end");
  };
  const deliver = (method: "send" | "steer", params: Json, active: string | null, send: Send): Json => {
    const delivery = typeof params.delivery_id === "string" ? params.delivery_id : null;
    const seen = delivery ? deliveries.get(delivery) : undefined;
    if (seen) return { result: statuses.get(delivery!) === "dropped" ? { accepted: false, duplicate: true, status: "dropped" } : { ...seen, duplicate: true } };
    if (!active) return { error: { code: -32003, message: "no active session" } };
    if (method === "send" && running.get()) return { error: { code: -32004, message: "a turn is already running" } };
    if (method === "steer" && !running.get()) return { error: { code: -32005, message: "no turn is running for steering" } };
    const value = String(params.text ?? "");
    sent.push({ method, text: value, delivery_id: delivery });
    send({ event: "user_message", session_id: active, text: value, mode: method, attachments: [], ...(delivery ? { delivery_id: delivery } : {}) });
    const accepted = method === "send" ? { accepted: true, session_id: active } : { accepted: true };
    if (delivery) { deliveries.set(delivery, accepted); statuses.set(delivery, method === "steer" ? "queued" : "delivered"); }
    if (method === "steer") { if (delivery) chat?.steers.push(delivery); return { result: accepted }; }
    histories[active] = [...(histories[active] ?? []), { id: `sent-${++rows}`, role: "user", content: [text(value)], ...(delivery ? { delivery_id: delivery } : {}), tool_result: null }];
    // After the reply, as zeta starts the turn once the send is persisted.
    queueMicrotask(() => void chatTurn(active, send));
    return { result: accepted };
  };
  const abort = (send: Send): Json => {
    if (!chat) return { result: { aborted: false } };
    const turn = chat;
    for (const id of turn.steers) statuses.set(id, "dropped");
    chat = null;
    running.set(false);
    turn.aborted = true;
    recordEnd(turn.session, turn.id, "user_stop");
    aborts++;
    send({ event: "turn_aborted", session_id: turn.session, data: { reason: "abort" } });
    send({ event: "agent_end", session_id: turn.session, data: {} });
    return { result: { aborted: true } };
  };
  return {
    /** Every accepted send and steer, in order. */
    sent,
    clearSent() { sent.splice(0); },
    get history() { return histories[ACTIVE] ?? []; },
    get aborts() { return aborts; },
    get currentTurnId() { return chat?.id; },
    /** The reply body for a composer method, or undefined for any other method. */
    handle(method: string, params: Json, active: string | null, send: Send): Json | undefined {
      if (method === "send" || method === "steer") return deliver(method, params, active, send);
      if (method === "abort") return abort(send);
      if (method !== "delivery_status") return undefined;
      const status = statuses.get(String(params.delivery_id));
      return status ? { result: { delivery_id: params.delivery_id, status } } : { error: { code: -32602, message: "unknown delivery_id" } };
    },
  };
}

const historyGroups = (rows: Json[]) => {
  const groups: Json[][] = [];
  const tools = new Map<string, Json[]>();
  for (const row of rows) {
    if (row.event === "approval_request" || row.event === "approval_end") {
      const toolId = (row.tool_call as { id?: unknown } | undefined)?.id;
      let group = typeof toolId === "string" ? tools.get(toolId) : undefined;
      if (!group) { group = groups.at(-1) ?? []; if (groups.length === 0) groups.push(group); }
      group.push(row);
      continue;
    }
    const group = [row];
    groups.push(group);
    for (const block of Array.isArray(row.content) ? row.content : []) {
      const toolId = (block as { tool_call?: { id?: unknown } }).tool_call?.id;
      if (typeof toolId === "string") tools.set(toolId, group);
    }
  }
  return groups;
};

export async function startFakeZeta({ origins, port = 0, live = true, historyMode = process.env.FAKE_ZETA_HISTORY_MODE === "old" ? "old" : "new", approvalHistoryMode = (process.env.FAKE_ZETA_APPROVAL_HISTORY_MODE as ApprovalHistoryMode | undefined) ?? "not-advertised-with-rows", approvalReconnect = true, approvalReconnectGraceMs = 90_000, serialDelays, overflowSilentCloseDelayMs = 0 }: { origins: string[]; port?: number; live?: boolean; historyMode?: HistoryMode; approvalHistoryMode?: ApprovalHistoryMode; approvalReconnect?: boolean; approvalReconnectGraceMs?: number; serialDelays?: Readonly<Record<string, number | readonly number[]>>; overflowSilentCloseDelayMs?: number }) {
  const home = await mkdtemp(join(tmpdir(), "fulcrum-web-zeta-"));
  await mkdir(join(home, "run"), { recursive: true });
  const discovery = join(home, "run", "serve.ws.json");
  let controllerToken = crypto.randomUUID();
  let observerToken = crypto.randomUUID();
  let mode: Mode = "ok";
  let liveEnabled = live;
  let currentHistoryMode = historyMode;
  let allowed = origins;
  let active: string | null = ACTIVE;
  const manyPages = Number(process.env.FAKE_ZETA_MANY_PAGES ?? 0);
  const largePages = Number(process.env.FAKE_ZETA_LARGE_PAGES ?? 0);
  if (manyPages > 0) histories[MANY] = Array.from({ length: manyPages * 8 }, (_, index) => ({ id: `many-${index}`, role: index % 2 ? "assistant" : "user", content: [text(`many-page row ${index}`)], tool_result: null }));
  if (largePages > 0) histories[LARGE] = Array.from({ length: largePages * 128 }, (_, index) => ({ id: `large-${index}`, role: index % 2 ? "assistant" : "user", content: [text(`large-page row ${index}`)], tool_result: null }));
  let sessions = [
    ...seeded,
    ...(manyPages > 0 ? [meta(MANY, 1, { name: `${manyPages.toLocaleString("en")} small pages of history` })] : []),
    ...(largePages > 0 ? [meta(LARGE, 1, { name: `${largePages.toLocaleString("en")} large pages of history` })] : []),
  ];
  let decide: ((decision: "approve" | "deny" | "abort") => void) | null = null;
  let turnStarted = false;
  let approvalAborted = false;
  let running = false;
  let rejectCreate = false;
  let busyOnce = false;
  let delayedOpen = false;
  let catalogBusy = false;
  const decisions: Json[] = [];
  const requests: Array<{ method: string; received: number; started: number; replied?: number }> = [];
  const sockets = new Set<ServerWebSocket<unknown>>();
  let controller: ServerWebSocket<unknown> | null = null;
  const reconnectControllers = new WeakSet<object>();
  const negotiatedFeatures = new WeakMap<object, Set<string>>();
  const connectionRoles = new WeakMap<object, "controller" | "observer">();
  const hostBoundSessions = new Set<string>();
  const hostBindingRequired = new Set<string>();
  const contentReaders = new WeakSet<object>();
  const parseHostBinding = (socket: ServerWebSocket<unknown>, method: string, params: Json) => {
    if (method !== "new_session" && method !== "resume") return undefined;
    if (!Object.hasOwn(params, "host_commands")) return { commands: undefined };
    if (!negotiatedFeatures.get(socket as object)?.has("session_host_commands")) return { error: "host_commands requires session_host_commands" };
    try {
      return { commands: validateHostCommands(params.host_commands) };
    } catch {
      return { error: "host_commands is invalid" };
    }
  };
  const applyHostBinding = (session: string, commands: ReturnType<typeof validateHostCommands> | undefined) => {
    if (commands?.length) hostBoundSessions.add(session);
    else hostBoundSessions.delete(session);
    hostBindingRequired.delete(session);
  };
  let approvalExpiry: ReturnType<typeof setTimeout> | null = null;
  const approvalCall = { id: "live-2", name: "bash", arguments: { command: "rm -rf packages/zeta/dist && bun run build" } };
  const expireApproval = () => {
    if (!decide || approvalAborted) return;
    approvalAborted = true;
    const resolve = decide;
    decide = null;
    running = false;
    histories[ACTIVE]!.push({ id: `approval-end-expire-${Date.now()}`, role: "system", event: "approval_end", request_id: "approval-1", tool_call: approvalCall, data: { decision: "abort", reason: "grace_expired" } });
    resolve("abort");
  };
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  let openDelay = Number(process.env.FAKE_ZETA_OPEN_DELAY_MS ?? 0);
  // The frames zeta sends when a connection falls behind (zeta tests/test_server_output.py,
  // test_controller_overflow_does_not_cancel_active_turn): the frame being written, the reserved -32011 error, then a
  // normal close. Past its 1 s overflow deadline zeta aborts the transport instead, with no error or close frame.
  const overflow = (socket: ServerWebSocket<unknown>, role: "controller" | "observer") => {
    socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { event: "assistant_delta", session_id: active ?? ACTIVE, delta: "head" } }));
    if (mode === "overflow-silent") {
      if (controller === socket) controller = null;
      if (overflowSilentCloseDelayMs > 0) return setTimeout(() => socket.terminate(), overflowSilentCloseDelayMs);
      return socket.terminate();
    }
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32011, message: `${role} output overflow` } }));
    socket.close(1000);
  };
  let servedTurnEndOffered = true;
  let backwardHistoryOffered = true;
  let laterHistoryDelay = 0;
  let servedTurnEndHistoryReads = 0;
  const lastTurnEnds = new Map<string, { turn_id: string; reason: TurnEndReason }>();
  const recordTurnEnd = (session: string, turnId: string, reason: TurnEndReason) => {
    const end = { turn_id: turnId, reason };
    lastTurnEnds.set(session, end);
    histories[session] = [...(histories[session] ?? []), servedTurnEnd(turnId, reason)];
  };
  const composer = composerMethods(
    wait,
    { get: () => running, set: (value) => { running = value; } },
    () => !!controller && !!negotiatedFeatures.get(controller as object)?.has("served_turn_end"),
    recordTurnEnd,
  );
  let serialTail = Promise.resolve<unknown>(undefined);
  const delayCalls = new Map<string, number>();
  const requestDelay = (method: string) => {
    const configured = serialDelays?.[method] ?? 0;
    if (typeof configured === "number") return configured;
    const call = delayCalls.get(method) ?? 0;
    delayCalls.set(method, call + 1);
    return configured[Math.min(call, configured.length - 1)] ?? 0;
  };
  const schedule = <T,>(task: () => Promise<T>) => {
    if (!serialDelays) return task();
    const next = serialTail.then(task, task);
    serialTail = next.catch(() => undefined);
    return next;
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request, bun) {
      const url = new URL(request.url);
      const origin = request.headers.get("origin");
      const bearer = request.headers.get("sec-websocket-protocol")?.split(",").map((value) => value.trim()).find((value) => value.startsWith("zeta.bearer."))?.slice("zeta.bearer.".length);
      if (!bearer || ![controllerToken, observerToken].includes(bearer) || (origin && !allowed.includes(origin))) return new Response("forbidden", { status: 403 });
      return bun.upgrade(request, { data: { bearer } }) ? undefined : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(socket) { sockets.add(socket); },
      close(socket) {
        sockets.delete(socket);
        if (connectionRoles.get(socket as object) !== "controller") return;
        if (controller === socket) controller = null;
        if (active && hostBoundSessions.has(active)) hostBindingRequired.add(active);
        if (!decide || approvalAborted) return;
        if (approvalReconnect && reconnectControllers.has(socket as object)) {
          if (approvalExpiry) clearTimeout(approvalExpiry);
          approvalExpiry = setTimeout(expireApproval, approvalReconnectGraceMs);
          return;
        }
        approvalAborted = true;
        const resolve = decide;
        decide = null;
        running = false;
        if (composer.currentTurnId) recordTurnEnd(ACTIVE, composer.currentTurnId, "disconnect");
        histories[ACTIVE]!.push({ id: `drop-${Date.now()}`, role: "tool_result", content: [text("")], tool_result: result("live-2", "connection lost", { is_canceled: true }) });
        if (currentHistoryMode === "new") histories[ACTIVE]!.push({ id: `approval-end-drop-${Date.now()}`, role: "system", event: "approval_end", request_id: "approval-1", tool_call: approvalCall, data: { decision: "abort", reason: "controller_disconnected" } });
        resolve("abort");
      },
      message(socket, raw) {
        const received = performance.now();
        const request = JSON.parse(String(raw)) as { id: number; method: string; params?: Json };
        return schedule(async () => {
        const { id, method, params = {} } = request;
        const timing: { method: string; received: number; started: number; replied?: number } = { method, received, started: performance.now() };
        requests.push(timing);
        await wait(requestDelay(method));
        const reply = (body: Json) => {
          timing.replied = performance.now();
          socket.send(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
        };
        const send = (event: Json) => { for (const each of sockets) each.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: event })); };
        if (method === "hello") {
          const bearer = (socket.data as { bearer?: string }).bearer;
          const requestedRole = params.role === "observer" ? "observer" : "controller";
          if (bearer === observerToken && requestedRole === "controller") return reply({ error: { code: -32602, message: "credential permits observer role only" } });
          if (requestedRole === "observer" && !(params.features as string[] | undefined)?.includes("serve_observers")) return reply({ error: { code: -32602, message: "observer requires protocol 1.1 and serve_observers" } });
          const observers = [...sockets].filter((each) => connectionRoles.get(each as object) === "observer").length;
          if (mode === "busy" || (requestedRole === "controller" && controller !== null)) { reply({ error: { code: -32001, message: "server busy" } }); socket.close(); return; }
          if (requestedRole === "observer" && observers >= 8) { reply({ error: { code: -32004, message: "observer limit reached" } }); socket.close(); return; }
          if (mode === "incompatible") { reply({ error: { code: -32002, message: "version mismatch", data: { requested: "1.2", supported: ["1.0"] } } }); socket.close(); return; }
          if (mode === "slow") await wait(60_000);
          if (!sockets.has(socket)) return;
          connectionRoles.set(socket as object, requestedRole);
          if (requestedRole === "controller") controller = socket;
          const features = (params.features as string[] | undefined)?.filter((name) => name === "list_sessions_paging" || name === "delivery_id" || name === "user_message_event" || name === "user_message_delivery_id" || (name === "session_history_backward" && backwardHistoryOffered) || name === "session_history_fidelity" || name === "content_read" || name === "session_host_commands" || (name === "approval_history" && approvalHistoryMode === "advertised-with-rows") || (name === "approval_reconnect" && approvalReconnect) || (name === "served_turn_end" && servedTurnEndOffered)) ?? [];
          negotiatedFeatures.set(socket as object, new Set(features));
          const reconnect = features.includes("approval_reconnect");
          if (reconnect) reconnectControllers.add(socket as object);
          if (features.includes("session_history_fidelity") && features.includes("content_read")) contentReaders.add(socket as object);
          reply({ result: { protocol_version: "1.2", server: "fake-zeta", capabilities: { features } } });
          if (mode === "overflow" || mode === "overflow-silent") setTimeout(() => overflow(socket, requestedRole), 0);
          if (decide && !approvalAborted) {
            if (!reconnect) expireApproval();
            else {
              if (approvalExpiry) clearTimeout(approvalExpiry);
              approvalExpiry = null;
              queueMicrotask(() => socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { event: "approval_request", session_id: ACTIVE, request_id: "approval-1", tool_call: approvalCall, delegated: false } })));
            }
          }
          return;
        }
        if (connectionRoles.get(socket as object) === "observer" && !["list_sessions", "status", "session_tree", "session_history", "model_catalog", "session_settings", "ping", "delivery_status", "content_read"].includes(method)) return reply({ error: { code: -32008, message: "observer is read-only", data: { code: "observer_read_only", method } } });
        const binding = parseHostBinding(socket, method, params);
        if (binding?.error) return reply({ error: { code: -32602, message: binding.error } });
        if ((method === "new_session" || method === "resume") && mode === "busy-once" && !busyOnce) {
          busyOnce = true;
          return reply({ error: { code: -32004, message: "a turn is already running" } });
        }
        if (method === "new_session") {
          // zeta's reply (server.py `new_session`): the full metadata of the new session, which becomes the server's own.
          if (running || rejectCreate) return reply({ error: { code: -32004, message: "a turn is already running" } });
          const created = meta(`s-new-${sessions.length}`, 0, { created_at: at(0), cwd: "/Users/dev/me/fun/fulcrum", retained_tail: 8, compaction_budget: 262144, override_audit: [], context_files: [], skill_catalog: [], agent_catalog: [], plan_mode: false, project_id: null, tool_allow: null, tool_deny: [] });
          sessions.unshift(created);
          histories[created.session_id] = [];
          active = created.session_id;
          applyHostBinding(active, binding?.commands);
          return reply({ result: { session: created } });
        }
        if (method === "list_sessions") {
          catalogBusy = true;
          try {
            if (mode === "slow-catalog") await wait(30_000);
            const offset = Number(params.offset ?? 0);
            const limit = Number(params.limit ?? sessions.length);
            const page = sessions.slice(offset, offset + limit);
            return reply({ result: { sessions: page, next_offset: offset + limit < sessions.length ? offset + limit : null } });
          } finally { catalogBusy = false; }
        }
        if (method === "status") {
          const pending = decide && !approvalAborted ? [{ request_id: "approval-1", tool_call: { id: "live-2", name: "bash", arguments: { command: "rm -rf packages/zeta/dist && bun run build" } }, delegated: false }] : [];
          // Mirrors feature negotiation, capture, and projection in zeta connections.py at 5feea2fc:594-629, 762-806, 822-837.
          const servedEnds = negotiatedFeatures.get(socket as object)?.has("served_turn_end");
          return reply({ result: { session: active ? sessions.find((session) => session.session_id === active) ?? null : null, state: running ? (decide ? "tool" : "running") : "idle", explicit_finish: false, pending_approvals: pending, usage: {}, compaction_markers: 0, ...(servedEnds ? { last_turn_outcome: active ? lastTurnEnds.get(active) ?? null : null } : {}) } });
        }
        if (method === "resume") {
          if (mode === "broken-session") return reply({ error: { code: -32602, message: "session log is invalid at line 12" } });
          if (running && params.session_id !== active) return reply({ error: { code: -32004, message: "a turn is already running" } });
          active = String(params.session_id);
          applyHostBinding(active, binding?.commands);
          delayedOpen = false;
          return reply({ result: { session: sessions.find((session) => session.session_id === active) } });
        }
        if (method === "content_read") {
          if (!contentReaders.has(socket as object)) return reply({ error: { code: -32601, message: "content_read requires negotiation" } });
          if (params.handle !== fakeImageHandle) return reply({ error: { code: -32012, message: "content not found", data: { code: "content_not_found" } } });
          const offset = params.offset === undefined ? 0 : Number(params.offset);
          const limit = Math.min(params.limit === undefined ? 524_288 : Number(params.limit), 524_288);
          if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || Object.hasOwn(params, "session_id"))
            return reply({ error: { code: -32602, message: "invalid content read", data: { code: "invalid_content_read" } } });
          const next = Math.min(fakeImage.byteLength, offset + limit);
          const data = btoa(String.fromCharCode(...fakeImage.slice(offset, next)));
          return reply({ result: { handle: fakeImageHandle, media_type: "image/png", title: "reconnect.png", size: fakeImage.byteLength, offset, data, next_offset: next, eof: next === fakeImage.byteLength } });
        }
        if (method === "session_history") {
          if (params.session_id !== active) return reply({ error: { code: -32003, message: "no active session" } });
          if (openDelay > 0 && !delayedOpen) {
            delayedOpen = true;
            await wait(openDelay);
          }
          const servedEnds = negotiatedFeatures.get(socket as object)?.has("served_turn_end");
          const rows = (histories[active!] ?? []).filter((row) => (approvalHistoryMode !== "not-advertised-without-rows" || (row.event !== "approval_request" && row.event !== "approval_end")) && (servedEnds || row.event !== "served_turn_end"));
          const groups = historyGroups(rows);
          const pageSize = active === LARGE ? 128 : 8;
          if (Object.hasOwn(params, "before")) {
            const validator = params.history_validator as { end?: unknown; entry_id?: unknown } | undefined;
            const before = params.before;
            const malformed = Object.hasOwn(params, "offset") ||
              (before !== null && (!Number.isInteger(before) || Number(before) < 0 || !validator)) ||
              (before === null && validator !== undefined);
            if (malformed) return reply({ error: { code: -32602, message: "invalid session_history parameters" } });
            const end = before === null ? groups.length : Number(before);
            const snapshotEnd = params.before === null ? groups.length : Number(validator?.end);
            const endpoint = snapshotEnd ? String(groups[snapshotEnd - 1]?.findLast((row) => row.event !== "approval_request" && row.event !== "approval_end")?.id ?? "") : null;
            if (params.before !== null && (validator?.end !== snapshotEnd || validator?.entry_id !== endpoint))
              return reply({ error: { code: -32009, message: "history snapshot is stale", data: { code: "stale_history_snapshot" } } });
            const start = Math.max(0, end - pageSize);
            reply({ result: { messages: groups.slice(start, end).flat(), next_before: start || null, history_validator: { end: snapshotEnd, entry_id: endpoint } } });
            if (liveEnabled && active === ACTIVE && !turnStarted) {
              turnStarted = true;
              running = true;
              const ask = () => new Promise<"approve" | "deny" | "abort">((resolve) => {
                approvalAborted = false;
                decide = (decision) => { decide = null; resolve(decision); };
              });
              const turnId = crypto.randomUUID().replaceAll("-", "");
              setTimeout(() => void liveTurn(send, ask, wait, turnId, (reason) => { recordTurnEnd(ACTIVE, turnId, reason); running = false; }, currentHistoryMode)(), 300);
            }
            return;
          }
          const offset = Number(params.offset ?? 0);
          if (offset > 0 && laterHistoryDelay > 0) await wait(laterHistoryDelay);
          const pageRows = groups.slice(offset, offset + pageSize).flat();
          if (pageRows.some((row) => row.event === "served_turn_end")) servedTurnEndHistoryReads++;
          reply({ result: { messages: pageRows, next_offset: offset + pageSize < groups.length ? offset + pageSize : null } });
          // The run starts once, after the first open of the active session finishes its history.
          if (liveEnabled && active === ACTIVE && offset + pageSize >= groups.length && !turnStarted) {
            turnStarted = true;
            running = true;
            const ask = () => new Promise<"approve" | "deny" | "abort">((resolve) => {
              approvalAborted = false;
              decide = (decision) => { decide = null; resolve(decision); };
            });
            const turnId = crypto.randomUUID().replaceAll("-", "");
              setTimeout(() => void liveTurn(send, ask, wait, turnId, (reason) => { recordTurnEnd(ACTIVE, turnId, reason); running = false; }, currentHistoryMode)(), 300);
          }
          return;
        }
        if (method === "approve" || method === "deny") {
          decisions.push({ method, ...params });
          if (!decide || params.request_id !== "approval-1") return reply({ error: { code: -32006, message: "approval request is missing or already resolved" } });
          reply({ result: { accepted: true, request_id: params.request_id, decision: method } });
          if (approvalExpiry) clearTimeout(approvalExpiry);
          approvalExpiry = null;
          return decide(method);
        }
        if ((method === "send" || method === "send_images") && active && hostBindingRequired.has(active)) return reply({ error: { code: -32003, message: "host binding required", data: { code: "host_binding_required" } } });
        const handled = composer.handle(method, params, active, send);
        if (handled) return reply(handled);
        reply({ error: { code: -32601, message: `method not found: ${method}` } });
        });
      },
    },
  });

  const write = (value: Json) => writeFile(discovery, JSON.stringify(value), { mode: 0o600 });
  await write({ port: server.port, controller_token: controllerToken, observer_token: observerToken, pid: process.pid, origins: allowed });
  return {
    home,
    port: server.port,
    decisions,
    requests,
    /** Every accepted send and steer, in order. */
    sent: composer.sent,
    /** Sends one server-originated event to connected clients. */
    emit(event: Json) { for (const socket of sockets) socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: event })); },
    clearSent() { composer.clearSent(); },
    get aborts() { return composer.aborts; },
    /** Closes every socket, like a network blip; the server keeps running. */
    drop() { for (const socket of sockets) socket.close(1012, "restart"); },
    /** Removes the discovery file and refuses upgrades, like a stopped server. */
    async stop() {
      allowed = [];
      await rm(discovery, { force: true });
      this.drop();
      for (let attempt = 0; decide && attempt < 100; attempt++) await Bun.sleep(1);
    },
    async start() {
      allowed = origins;
      controllerToken = crypto.randomUUID();
      observerToken = crypto.randomUUID();
      if (!decide) { approvalAborted = false; running = false; }
      await write({ port: server.port, controller_token: controllerToken, observer_token: observerToken, pid: process.pid, origins: allowed });
    },
    /** Lists other origins in the allowlist, so this page's origin is missing. */
    async foreignOrigin() { allowed = ["http://localhost:5173"]; await write({ port: server.port, controller_token: controllerToken, observer_token: observerToken, pid: process.pid, origins: allowed }); },
    /** Hands out a token the server will refuse. */
    async wrongToken() { await write({ port: server.port, controller_token: "stale-token", observer_token: "stale-token", pid: process.pid, origins: allowed }); },
    /**
     * `overflow` and `overflow-silent` overflow the controller now and every connection after its hello until the
     * mode changes; set "ok" right after to overflow once. The turn keeps running, as in zeta.
     */
    setMode(next: Mode) {
      mode = next;
      busyOnce = false;
      if ((next === "overflow" || next === "overflow-silent") && controller) overflow(controller, "controller");
    },
    /** `false` makes the server not offer `served_turn_end`, like a zeta older than 8c03f606. */
    setServedTurnEnd(next: boolean) { servedTurnEndOffered = next; },
    setBackwardHistory(next: boolean) { backwardHistoryOffered = next; },
    setLaterHistoryDelay(ms: number) { laterHistoryDelay = ms; },
    get servedTurnEndHistoryReads() { return servedTurnEndHistoryReads; },
    /** Whether a turn runs on the server, independent of what any client saw. */
    get running() { return running; },
    setOpenDelay(ms: number) { openDelay = ms; },
    /** `true`: new_session fails the way real zeta does while a turn runs (`require_idle`). */
    setRejectCreate(next: boolean) { rejectCreate = next; },
    setHistoryMode(next: HistoryMode) { currentHistoryMode = next; },
    setLive(next: boolean) {
      if (next && !liveEnabled) {
        turnStarted = false;
        histories[ACTIVE] = histories[ACTIVE]!.filter((row) => row.event !== "approval_request" && row.event !== "approval_end");
      }
      liveEnabled = next;
    },
    /** `true`: a fresh zeta home, with no sessions and no server session. `false`: the seeded sessions again. */
    setEmpty(empty: boolean) { sessions = empty ? [] : [...seeded]; active = empty ? null : ACTIVE; },
    async close() { this.drop(); server.stop(true); await rm(home, { recursive: true, force: true }); },
  };
}

if (import.meta.main) {
  const origin = process.env.WEB_ORIGIN ?? "http://localhost:5180";
  const fake = await startFakeZeta({ origins: [origin, origin.replace("localhost", "127.0.0.1")], port: Number(process.env.FAKE_ZETA_PORT ?? 0) });
  console.log(`fake zeta serve on 127.0.0.1:${fake.port} for ${origin}\nstart the app with:\n  ZETA_HOME=${fake.home} bun run --cwd apps/web dev\nctrl-c stops it and deletes ${fake.home}`);
  process.once("SIGINT", () => void fake.close().then(() => process.exit(0)));
}
