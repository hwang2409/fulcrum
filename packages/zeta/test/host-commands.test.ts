import { expect, test } from "bun:test";
import { inspect } from "node:util";
import { createClient, HostCommandError, type HostCommand, type Transport } from "../src/index.js";

type Message = { id: number; method: string; params: Record<string, unknown> };

function fakeTransport() {
  let onMessage!: (text: string) => void;
  let onClose = (_code?: number) => {};
  const sent: Message[] = [];
  const transport: Transport = {
    send(text) { sent.push(JSON.parse(text)); },
    onMessage(callback) { onMessage = callback; },
    onClose(callback) { onClose = callback; },
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
    drop(code = 1006) { onClose(code); },
  };
}

const command = (environment: Record<string, string> = { FOO: "bar" }): HostCommand => ({
  name: "gamma-render",
  executable: "/opt/gamma/bin/render",
  summary: "render a file in the web surface",
  environment,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

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
  await Bun.sleep(0);
  expect(first.sent.at(-1)).toMatchObject({ method: "new_session", params: { host_commands: [command({ FOO: "1" })] } });
  first.reply(first.sent.at(-1)!, { session: { session_id: "s-new" } });
  await creating;

  const resuming = firstClient.request("resume", { session_id: "s-one" });
  await Bun.sleep(0);
  expect(first.sent.at(-1)).toMatchObject({ method: "resume", params: { session_id: "s-one", host_commands: [command({ FOO: "2" })] } });
  first.reply(first.sent.at(-1)!, { session: { session_id: "s-one" } });
  await resuming;

  const failed = firstClient.request("resume", { session_id: "s-two" });
  await Bun.sleep(0);
  first.fail(first.sent.at(-1)!, -32602);
  await expect(failed).rejects.toThrow("request failed");
  const retried = firstClient.request("resume", { session_id: "s-two" });
  await Bun.sleep(0);
  expect(first.sent.at(-1)).toMatchObject({ params: { host_commands: [command({ FOO: "4" })] } });
  first.reply(first.sent.at(-1)!, { session: { session_id: "s-two" } });
  await retried;

  const reconnected = fakeTransport();
  const reconnectedClient = createClient(reconnected.transport, undefined, undefined, { hostCommands: supply });
  await hello(reconnected, reconnectedClient);
  const reattach = reconnectedClient.request("resume", { session_id: "s-two" });
  await Bun.sleep(0);
  expect(reconnected.sent.at(-1)).toMatchObject({ method: "resume", params: { host_commands: [command({ FOO: "5" })] } });
  reconnected.reply(reconnected.sent.at(-1)!, { session: { session_id: "s-two" } });
  await reattach;

  expect(calls).toEqual([null, "s-one", "s-two", "s-two", "s-two"]);
});

test("settled host command suppliers release close waiters", async () => {
  const fake = fakeTransport();
  const client = createClient(fake.transport, undefined, undefined, { maxPendingRequests: 20_000, hostCommands: () => Promise.resolve([command()]) });
  await hello(fake, client);

  const attaches = Array.from({ length: 10_000 }, () => client.request("new_session"));
  await Bun.sleep(0);
  for (const request of fake.sent.slice(1)) fake.reply(request, { session: { session_id: `s-${request.id}` } });
  await Promise.all(attaches);

  expect(client.hostCommandWaiterCount).toBe(0);
  expect(fake.sent).toHaveLength(10_001);
});

test("a session send waits for its slow resume attachment", async () => {
  const supplied = deferred<HostCommand[]>();
  const fake = fakeTransport();
  const client = createClient(fake.transport, undefined, undefined, { hostCommands: () => supplied.promise });
  await hello(fake, client);

  const resuming = client.request("resume", { session_id: "s-one" });
  const sending = client.request("send", { session_id: "s-one", text: "hello" });
  expect(fake.sent.map(({ method }) => method)).toEqual(["hello"]);

  supplied.resolve([command()]);
  await Bun.sleep(0);
  expect(fake.sent.map(({ method }) => method)).toEqual(["hello", "resume"]);
  fake.reply(fake.sent.at(-1)!, { session: { session_id: "s-one" } });
  await resuming;
  await Bun.sleep(0);
  expect(fake.sent.map(({ method }) => method)).toEqual(["hello", "resume", "send"]);
  fake.reply(fake.sent.at(-1)!, { accepted: true });
  await sending;
});

test("close rejects new_session while its host command supplier never settles", async () => {
  const supplied = deferred<HostCommand[]>();
  const fake = fakeTransport();
  const closed = new Error("closed");
  const client = createClient(fake.transport, undefined, () => closed, { hostCommands: () => supplied.promise });
  await hello(fake, client);

  const creating = client.request("new_session");
  client.close();

  expect(await Promise.race([creating.catch((error) => error), Bun.sleep(50).then(() => "timed out")])).toBe(closed);
  expect(fake.sent.map(({ method }) => method)).toEqual(["hello"]);
});

test.each([
  ["close", (fake: ReturnType<typeof fakeTransport>, client: ReturnType<typeof createClient>) => client.close()],
  ["drop", (fake: ReturnType<typeof fakeTransport>) => fake.drop()],
])("%s rejects two pending same-session resumes and their queued send", async (_, close) => {
  const supplied = deferred<HostCommand[]>();
  const fake = fakeTransport();
  const closed = new Error("closed");
  const client = createClient(fake.transport, undefined, () => closed, { hostCommands: () => supplied.promise });
  await hello(fake, client);

  const first = client.request("resume", { session_id: "s-one" });
  const second = client.request("resume", { session_id: "s-one" });
  const sending = client.request("send", { session_id: "s-one", text: "hello" });
  close(fake, client);

  const outcomes = await Promise.all([first, second, sending].map((request) => Promise.race([
    request.catch((error) => error),
    Bun.sleep(50).then(() => "timed out"),
  ])));
  expect(outcomes).toEqual([closed, closed, closed]);
  expect(fake.sent.map(({ method }) => method)).toEqual(["hello"]);
});

test("close rejects recovery while its host command supplier never settles", async () => {
  const supplied = deferred<HostCommand[]>();
  const fake = fakeTransport();
  const closed = new Error("closed");
  const client = createClient(fake.transport, undefined, () => closed, { hostCommands: () => supplied.promise });
  await hello(fake, client);

  const sending = client.request("send", { session_id: "s-one", text: "hello", delivery_id: "d-one" });
  fake.fail(fake.sent.at(-1)!, -32003, { code: "host_binding_required" });
  await Bun.sleep(0);
  client.close();

  expect(await Promise.race([sending.catch((error) => error), Bun.sleep(50).then(() => "timed out")])).toBe(closed);
  expect(fake.sent.map(({ method }) => method)).toEqual(["hello", "send"]);
});

test("a dropped client rejects a pending attachment and queued send", async () => {
  const supplied = deferred<HostCommand[]>();
  const fake = fakeTransport();
  const client = createClient(fake.transport, undefined, (_handshaken, code) => new Error(`closed ${code}`), { hostCommands: () => supplied.promise });
  await hello(fake, client);

  const resuming = client.request("resume", { session_id: "s-one" });
  const sending = client.request("send", { session_id: "s-one", text: "hello" });
  fake.drop();
  await expect(Promise.all([resuming, sending])).rejects.toThrow("closed 1006");
  supplied.resolve([command()]);
  await Bun.sleep(0);
  expect(fake.sent.map(({ method }) => method)).toEqual(["hello"]);
});

test("close rejects a pending attachment and queued send, and clears the gate", async () => {
  const supplied = deferred<HostCommand[]>();
  const fake = fakeTransport();
  const client = createClient(fake.transport, undefined, () => new Error("closed"), { hostCommands: () => supplied.promise });
  await hello(fake, client);

  const resuming = client.request("resume", { session_id: "s-one" });
  const sending = client.request("send", { session_id: "s-one", text: "hello" });
  client.close();
  await expect(Promise.all([resuming, sending])).rejects.toThrow("closed");
  supplied.resolve([command()]);
  await Bun.sleep(0);
  expect(fake.sent.map(({ method }) => method)).toEqual(["hello"]);
});

test("a late host command supplier cannot send after close", async () => {
  const supplied = deferred<HostCommand[]>();
  const fake = fakeTransport();
  const client = createClient(fake.transport, undefined, undefined, { hostCommands: () => supplied.promise });
  await hello(fake, client);
  const resuming = client.request("resume", { session_id: "s-one" });
  client.close();
  supplied.resolve([command()]);
  await expect(resuming).rejects.toThrow();
  await Bun.sleep(0);
  expect(fake.sent.map(({ method }) => method)).toEqual(["hello"]);
});

test("two session sends wait for one slow attachment and leave in call order", async () => {
  const supplied = deferred<HostCommand[]>();
  const fake = fakeTransport();
  const client = createClient(fake.transport, undefined, undefined, { hostCommands: () => supplied.promise });
  await hello(fake, client);

  const resuming = client.request("resume", { session_id: "s-one" });
  const first = client.request("send", { session_id: "s-one", text: "first" });
  const second = client.request("steer", { session_id: "s-one", text: "second" });
  supplied.resolve([command()]);
  await Bun.sleep(0);
  expect(fake.sent.filter(({ method }) => method === "resume")).toHaveLength(1);
  fake.reply(fake.sent.at(-1)!, { session: { session_id: "s-one" } });
  await resuming;
  await Bun.sleep(0);
  expect(fake.sent.slice(2).map(({ method, params }) => [method, params.text])).toEqual([["send", "first"], ["steer", "second"]]);
  for (const message of fake.sent.slice(2)) fake.reply(message, { accepted: true });
  await Promise.all([first, second]);
});

test("a failed attachment rejects its queued sends with the typed attachment error", async () => {
  const supplied = deferred<HostCommand[]>();
  const fake = fakeTransport();
  const client = createClient(fake.transport, undefined, undefined, { hostCommands: () => supplied.promise });
  await hello(fake, client);

  const resuming = client.request("resume", { session_id: "s-one" }).catch((error: unknown) => error);
  const sending = client.request("send_images", { session_id: "s-one", delivery_id: "d-one" }).catch((error: unknown) => error);
  supplied.resolve([command()]);
  await Bun.sleep(0);
  fake.fail(fake.sent.at(-1)!, -32602);

  expect(await resuming).toMatchObject({ name: "HostCommandError", kind: "host_command_request_failed" });
  expect(await sending).toMatchObject({ name: "HostCommandError", kind: "host_command_request_failed" });
  expect(fake.sent.map(({ method }) => method)).toEqual(["hello", "resume"]);
});

test("content_read is not delayed by a slow session attachment", async () => {
  const supplied = deferred<HostCommand[]>();
  const fake = fakeTransport();
  const client = createClient(fake.transport, undefined, undefined, { hostCommands: () => supplied.promise });
  await hello(fake, client);

  const resuming = client.request("resume", { session_id: "s-one" });
  const reading = client.request("content_read", { handle: "content-one", offset: 0 });
  expect(fake.sent.map(({ method }) => method)).toEqual(["hello", "content_read"]);
  fake.reply(fake.sent.at(-1)!, { data: "hello", eof: true });
  await reading;

  supplied.resolve([command()]);
  await Bun.sleep(0);
  fake.reply(fake.sent.at(-1)!, { session: { session_id: "s-one" } });
  await resuming;
});

test("concurrent host-binding failures share one recovery attachment", async () => {
  const supplied = deferred<HostCommand[]>();
  let supplyCalls = 0;
  const fake = fakeTransport();
  const client = createClient(fake.transport, undefined, undefined, { hostCommands: () => { supplyCalls++; return supplied.promise; } });
  await hello(fake, client);

  const first = client.request("send", { session_id: "s-one", text: "first", delivery_id: "d-one" });
  const second = client.request("send", { session_id: "s-one", text: "second", delivery_id: "d-two" });
  const initialSends = fake.sent.slice(1);
  for (const message of initialSends) fake.fail(message, -32003, { code: "host_binding_required" });
  await Bun.sleep(0);
  expect(supplyCalls).toBe(1);

  supplied.resolve([command()]);
  await Bun.sleep(0);
  expect(fake.sent.filter(({ method }) => method === "resume")).toHaveLength(1);
  fake.reply(fake.sent.at(-1)!, { session: { session_id: "s-one" } });
  await Bun.sleep(0);
  const retries = fake.sent.filter(({ method }) => method === "send").slice(2);
  expect(retries.map(({ params }) => params.delivery_id)).toEqual(["d-one", "d-two"]);
  for (const message of retries) fake.reply(message, { accepted: true });
  await Promise.all([first, second]);
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

test("a fresh client recovers the failed request's session binding and retries its delivery id once", async () => {
  let supplies = 0;
  const fake = fakeTransport();
  const client = createClient(fake.transport, undefined, undefined, { hostCommands: (sessionId) => {
    expect(sessionId).toBe("s-one");
    return [command({ FOO: String(++supplies) })];
  } });
  await hello(fake, client);

  const sending = client.request("send", { session_id: "s-one", text: "hello", delivery_id: "delivery-1" });
  await Promise.resolve();
  const firstSend = fake.sent.at(-1)!;
  fake.fail(firstSend, -32003, { code: "host_binding_required" });
  await Bun.sleep(0);
  const resume = fake.sent.at(-1)!;
  expect(resume).toMatchObject({ method: "resume", params: { session_id: "s-one", host_commands: [command({ FOO: "1" })] } });
  fake.reply(resume, { session: { session_id: "s-one" } });
  await Bun.sleep(0);
  const retry = fake.sent.at(-1)!;
  expect(retry).toMatchObject({ method: "send", params: { session_id: "s-one", text: "hello", delivery_id: "delivery-1" } });
  expect(retry.id).not.toBe(firstSend.id);
  fake.reply(retry, { accepted: true, session_id: "s-one" });
  await expect(sending).resolves.toMatchObject({ accepted: true });
  expect(fake.sent.filter(({ method }) => method === "send")).toHaveLength(2);
});

test("supplier failures and invalid output never expose their values", async () => {
  const marker = "DISTINCTIVE-PR62-SECRET";
  const thrown = [
    new Error(marker),
    new HostCommandError("host_command_supplier_failed", marker, 999, { code: marker }),
    marker,
  ];
  const invalid = [{ ...command(), name: `!${marker}` }];
  const messages: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };
  const capture = (...values: unknown[]) => messages.push(values.map((value) => inspect(value)).join(" "));
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  console.debug = capture;
  try {
    for (const value of [...thrown, invalid]) {
      const fake = fakeTransport();
      const client = createClient(fake.transport, undefined, undefined, {
        hostCommands: () => {
          if (value === invalid) return invalid;
          throw value;
        },
      });
      await hello(fake, client);
      const failure = await client.request("new_session").catch((error: unknown) => error as Error & { cause?: unknown });
      console.error(failure);
      expect(String(failure)).not.toContain(marker);
      expect(JSON.stringify(failure)).not.toContain(marker);
      expect(inspect(failure)).not.toContain(marker);
      expect(failure.cause).toBeUndefined();
      expect(failure.stack).not.toContain(marker);
      if (value === invalid) {
        expect(failure).toMatchObject({ name: "HostCommandError", kind: "invalid_host_commands" });
        expect(failure.message).toContain("host_commands[0].name");
        expect(failure.message).toContain("64");
      } else {
        expect(failure).toMatchObject({
          name: "HostCommandError",
          kind: "host_command_supplier_failed",
          message: "host command supplier failed",
        });
      }
    }
  } finally {
    Object.assign(console, originals);
  }
  expect(messages.join("\n")).not.toContain(marker);
});

test("a failed host-binding retry surfaces a typed error and does not retry twice", async () => {
  const fake = fakeTransport();
  const client = createClient(fake.transport, undefined, undefined, { hostCommands: () => [command()] });
  await hello(fake, client);
  const attach = client.request("resume", { session_id: "s-one" });
  await Bun.sleep(0);
  fake.reply(fake.sent.at(-1)!, { session: { session_id: "s-one" } });
  await attach;

  const sending = client.request("send", { session_id: "s-one", text: "hello", delivery_id: "delivery-1" });
  await Promise.resolve();
  fake.fail(fake.sent.at(-1)!, -32003, { code: "host_binding_required" });
  await Bun.sleep(0);
  fake.reply(fake.sent.at(-1)!, { session: { session_id: "s-one" } });
  await Bun.sleep(0);
  fake.fail(fake.sent.at(-1)!, -32003, { code: "host_binding_required" });
  await expect(sending).rejects.toMatchObject({ name: "HostCommandError", kind: "host_binding_retry_failed" });
  expect(fake.sent.filter(({ method }) => method === "send")).toHaveLength(2);
});
