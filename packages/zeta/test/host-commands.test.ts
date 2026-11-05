import { expect, test } from "bun:test";
import { createClient, type HostCommand, type Transport } from "../src/index.js";

type Message = { id: number; method: string; params: Record<string, unknown> };

function fakeTransport() {
  let onMessage!: (text: string) => void;
  const sent: Message[] = [];
  const transport: Transport = {
    send(text) { sent.push(JSON.parse(text)); },
    onMessage(callback) { onMessage = callback; },
    onClose() {},
    close() {},
  };
  return {
    transport,
    sent,
    reply(message: Message, result: unknown) {
      onMessage(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    },
    fail(message: Message, code: number, data?: unknown) {
      onMessage(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code, message: "request failed", data } }));
    },
  };
}

const command = (environment: Record<string, string> = { FOO: "bar" }): HostCommand => ({
  name: "gamma-render",
  executable: "/opt/gamma/bin/render",
  summary: "render a file in the web surface",
  environment,
});

async function hello(fake: ReturnType<typeof fakeTransport>, client: ReturnType<typeof createClient>, offered = true) {
  const pending = client.hello();
  await Promise.resolve();
  const request = fake.sent.at(-1)!;
  fake.reply(request, {
    protocol_version: "1.2",
    capabilities: { features: offered ? ["session_host_commands"] : [] },
  });
  await pending;
  return request;
}

test("supplies fresh host commands for new_session, resume, a failed-resume retry, and reconnect reattach", async () => {
  const calls: Array<string | null> = [];
  const supply = async (sessionId: string | null) => {
    calls.push(sessionId);
    return [command({ FOO: String(calls.length) })];
  };
  const first = fakeTransport();
  const firstClient = createClient(first.transport, undefined, undefined, { hostCommands: supply });
  await hello(first, firstClient);

  const creating = firstClient.request("new_session");
  await Promise.resolve();
  expect(first.sent.at(-1)).toMatchObject({ method: "new_session", params: { host_commands: [command({ FOO: "1" })] } });
  first.reply(first.sent.at(-1)!, { session: { session_id: "s-new" } });
  await creating;

  const resuming = firstClient.request("resume", { session_id: "s-one" });
  await Promise.resolve();
  expect(first.sent.at(-1)).toMatchObject({ method: "resume", params: { session_id: "s-one", host_commands: [command({ FOO: "2" })] } });
  first.reply(first.sent.at(-1)!, { session: { session_id: "s-one" } });
  await resuming;

  const failed = firstClient.request("resume", { session_id: "s-two" });
  await Promise.resolve();
  first.fail(first.sent.at(-1)!, -32602);
  await expect(failed).rejects.toThrow("request failed");
  const retried = firstClient.request("resume", { session_id: "s-two" });
  await Promise.resolve();
  expect(first.sent.at(-1)).toMatchObject({ params: { host_commands: [command({ FOO: "4" })] } });
  first.reply(first.sent.at(-1)!, { session: { session_id: "s-two" } });
  await retried;

  const reconnected = fakeTransport();
  const reconnectedClient = createClient(reconnected.transport, undefined, undefined, { hostCommands: supply });
  await hello(reconnected, reconnectedClient);
  const reattach = reconnectedClient.request("resume", { session_id: "s-two" });
  await Promise.resolve();
  expect(reconnected.sent.at(-1)).toMatchObject({ method: "resume", params: { host_commands: [command({ FOO: "5" })] } });
  reconnected.reply(reconnected.sent.at(-1)!, { session: { session_id: "s-two" } });
  await reattach;

  expect(calls).toEqual([null, "s-one", "s-two", "s-two", "s-two"]);
});

test("host command validation rejects every protocol limit before sending", async () => {
  const base = command();
  const cases: Array<[string, unknown]> = [
    ["array type", {}],
    ["item type", [null]],
    ["exact keys", [{ ...base, extra: true }]],
    ["name empty", [{ ...base, name: "" }]],
    ["name pattern", [{ ...base, name: "1bad" }]],
    ["name length", [{ ...base, name: `a${"b".repeat(64)}` }]],
    ["name unique", [base, { ...base }]],
    ["executable absolute", [{ ...base, executable: "bin/render" }]],
    ["executable normalized", [{ ...base, executable: "/opt/../bin/render" }]],
    ["executable nul", [{ ...base, executable: "/opt/bin/render\0x" }]],
    ["executable newline", [{ ...base, executable: "/opt/bin/render\nx" }]],
    ["executable bytes", [{ ...base, executable: `/${"é".repeat(2048)}` }]],
    ["summary empty", [{ ...base, summary: "" }]],
    ["summary line", [{ ...base, summary: "one\ntwo" }]],
    ["summary bytes", [{ ...base, summary: "é".repeat(129) }]],
    ["environment type", [{ ...base, environment: null }]],
    ["environment key pattern", [{ ...base, environment: { "1BAD": "x" } }]],
    ["environment key length", [{ ...base, environment: { [`A${"B".repeat(128)}`]: "x" } }]],
    ["environment key unique", [base, { ...base, name: "gamma-two", environment: { FOO: "two" } }]],
    ...["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "CDPATH", "GLOBIGNORE", "ZETA_TOOL_SUBPROCESS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"].map((key) => [`environment key ${key}`, [{ ...base, environment: { [key]: "x" } }]] as [string, unknown]),
    ["environment value type", [{ ...base, environment: { FOO: 1 } }]],
    ["environment value nul", [{ ...base, environment: { FOO: "a\0b" } }]],
    ["environment value bytes", [{ ...base, environment: { FOO: "é".repeat(2049) } }]],
    ["environment entries", [{ ...base, environment: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`K${index}`, "x"])) }]],
    ["environment total bytes", [{ ...base, environment: Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`KEY${index}`, "x".repeat(4096)])) }]],
    ["item count", Array.from({ length: 5 }, (_, index) => ({ ...base, name: `gamma-${index}`, environment: {} }))],
  ];

  for (const [name, value] of cases) {
    const fake = fakeTransport();
    let calls = 0;
    const client = createClient(fake.transport, undefined, undefined, { hostCommands: () => { calls++; return value as HostCommand[]; } });
    await hello(fake, client);
    const before = fake.sent.length;
    const failure = await client.request("new_session").catch((error: unknown) => error as Error & { kind?: string });
    expect(failure, name).toBeInstanceOf(Error);
    expect(failure.kind, name).toBe("invalid_host_commands");
    expect(fake.sent.length, name).toBe(before);
    expect(calls, name).toBe(1);
  }
});

test("does not expose host commands in warnings or errors", async () => {
  const secret = "host-command-secret-value";
  const messages: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };
  console.log = (...values) => messages.push(values.join(" "));
  console.warn = (...values) => messages.push(values.join(" "));
  console.error = (...values) => messages.push(values.join(" "));
  console.debug = (...values) => messages.push(values.join(" "));
  try {
    const unsupported = fakeTransport();
    let calls = 0;
    const ignored = createClient(unsupported.transport, undefined, undefined, { hostCommands: () => { calls++; return [command({ FOO: secret })]; } });
    await hello(unsupported, ignored, false);
    const repeatedHello = ignored.hello();
    await Promise.resolve();
    unsupported.reply(unsupported.sent.at(-1)!, { protocol_version: "1.2", capabilities: { features: [] } });
    await repeatedHello;
    expect(calls).toBe(0);

    let receive!: (text: string) => void;
    const leakingTransport: Transport = {
      send(text) {
        const message = JSON.parse(text) as Message;
        if (message.method === "hello") return queueMicrotask(() => receive(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocol_version: "1.2", capabilities: { features: ["session_host_commands"] } } })));
        throw new Error(text);
      },
      onMessage(callback) { receive = callback; },
      onClose() {},
      close() {},
    };
    const leaking = createClient(leakingTransport, undefined, undefined, { hostCommands: () => [command({ FOO: secret })] });
    await leaking.hello();
    const failure = await leaking.request("new_session").catch((error: unknown) => error as Error);
    expect(String(failure)).not.toContain(secret);
    expect(failure).toMatchObject({ name: "HostCommandError", kind: "host_command_request_failed" });
  } finally {
    Object.assign(console, originals);
  }
  expect(messages.join("\n")).not.toContain(secret);
  expect(messages.filter((message) => message.includes("session_host_commands"))).toHaveLength(1);
});

test("host_binding_required resumes with a fresh binding then retries the same delivery id once", async () => {
  let supplies = 0;
  const fake = fakeTransport();
  const client = createClient(fake.transport, undefined, undefined, { hostCommands: () => [command({ FOO: String(++supplies) })] });
  await hello(fake, client);
  const attach = client.request("resume", { session_id: "s-one" });
  await Promise.resolve();
  fake.reply(fake.sent.at(-1)!, { session: { session_id: "s-one" } });
  await attach;

  const sending = client.request("send", { text: "hello", delivery_id: "delivery-1" });
  await Promise.resolve();
  const firstSend = fake.sent.at(-1)!;
  fake.fail(firstSend, -32003, { code: "host_binding_required" });
  await Bun.sleep(0);
  const resume = fake.sent.at(-1)!;
  expect(resume).toMatchObject({ method: "resume", params: { session_id: "s-one", host_commands: [command({ FOO: "2" })] } });
  fake.reply(resume, { session: { session_id: "s-one" } });
  await Bun.sleep(0);
  const retry = fake.sent.at(-1)!;
  expect(retry).toMatchObject({ method: "send", params: { text: "hello", delivery_id: "delivery-1" } });
  expect(retry.id).not.toBe(firstSend.id);
  fake.reply(retry, { accepted: true, session_id: "s-one" });
  await expect(sending).resolves.toMatchObject({ accepted: true });
  expect(fake.sent.filter(({ method }) => method === "send")).toHaveLength(2);
});

test("a failed host-binding retry surfaces a typed error and does not retry twice", async () => {
  const fake = fakeTransport();
  const client = createClient(fake.transport, undefined, undefined, { hostCommands: () => [command()] });
  await hello(fake, client);
  const attach = client.request("resume", { session_id: "s-one" });
  await Promise.resolve();
  fake.reply(fake.sent.at(-1)!, { session: { session_id: "s-one" } });
  await attach;

  const sending = client.request("send", { text: "hello", delivery_id: "delivery-1" });
  await Promise.resolve();
  fake.fail(fake.sent.at(-1)!, -32003, { code: "host_binding_required" });
  await Bun.sleep(0);
  fake.reply(fake.sent.at(-1)!, { session: { session_id: "s-one" } });
  await Bun.sleep(0);
  fake.fail(fake.sent.at(-1)!, -32003, { code: "host_binding_required" });
  await expect(sending).rejects.toMatchObject({ name: "HostCommandError", kind: "host_binding_retry_failed" });
  expect(fake.sent.filter(({ method }) => method === "send")).toHaveLength(2);
});
