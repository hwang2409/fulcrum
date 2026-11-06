import { afterEach, expect, test } from "bun:test";
import { connectZeta, discoverZeta, parseConnectFragment, parseZetaUrl, type ZetaError } from "../src/index.js";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly listeners = new Map<string, Array<(event: { data?: unknown; code?: number }) => void>>();
  readonly sent: string[] = [];
  constructor(readonly url: string, readonly protocols?: string[]) { FakeWebSocket.instances.push(this); }
  addEventListener(name: string, listener: (event: { data?: unknown; code?: number }) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  emit(name: string, event: { data?: unknown; code?: number } = {}) {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
  send(text: string) { this.sent.push(text); }
  close() { this.emit("close"); }
}

const OriginalWebSocket = globalThis.WebSocket;
afterEach(() => { globalThis.WebSocket = OriginalWebSocket; FakeWebSocket.instances = []; });

async function open() {
  const socket = FakeWebSocket.instances[0];
  socket.emit("open");
  await Bun.sleep(0);
  return socket;
}
function reply(socket: FakeWebSocket, result: unknown) {
  socket.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id: 1, result }) });
}
function error(socket: FakeWebSocket, code: number) {
  socket.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message: "no details" } }) });
}

 test("uses role-bound bearer subprotocols and keeps the token out of the websocket url", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const connecting = connectZeta({ url: "ws://127.0.0.1:8765/", token: "secret", features: ["projects"] });
  const socket = await open();
  expect(socket.url).toBe("ws://127.0.0.1:8765/");
  expect(socket.protocols).toEqual(["zeta.v1", "zeta.bearer.secret"]);
  expect(socket.url).not.toContain("token=");
  expect(JSON.parse(socket.sent[0])).toMatchObject({ method: "hello", params: { protocol_version: "1.2", client_version: "1.2", features: ["projects"] } });
  expect(socket.sent[0]).not.toContain("secret");
  reply(socket, { protocol_version: "1.0" });
  await expect(connecting).resolves.toHaveProperty("request");
});

test("observer role uses the supplied observer token", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const connecting = connectZeta({ url: "ws://127.0.0.1:8765/", role: "observer", token: "observer-secret" });
  const socket = await open();
  expect(socket.protocols).toEqual(["zeta.v1", "zeta.bearer.observer-secret"]);
  reply(socket, { protocol_version: "1.0" });
  await expect(connecting).resolves.toHaveProperty("request");
});

test("connectZeta opts into host commands only when a supplier is present", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const supplied: Array<string | null> = [];
  const connecting = connectZeta({
    url: "ws://127.0.0.1:8765/",
    token: "secret",
    hostCommands(sessionId) {
      supplied.push(sessionId);
      return [{ name: "gamma-render", executable: "/opt/gamma/render", summary: "render a file", environment: {} }];
    },
  });
  const socket = await open();
  expect(JSON.parse(socket.sent[0]).params.features).toEqual(["session_host_commands"]);
  reply(socket, { protocol_version: "1.2", capabilities: { features: ["session_host_commands"] } });
  const client = await connecting;
  const creating = client.request("new_session");
  await Bun.sleep(0);
  const request = JSON.parse(socket.sent[1]);
  expect(request).toMatchObject({ method: "new_session", params: { host_commands: [{ name: "gamma-render" }] } });
  socket.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { session: { session_id: "s-one" } } }) });
  await creating;
  expect(supplied).toEqual([null]);
});

test("failed upgrade rejects with connect_failed without exposing the token", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const connecting = connectZeta({ url: "ws://127.0.0.1:8765/", controller_token: "controller", observer_token: "observer" });
  FakeWebSocket.instances[0].emit("error");
  const failure = await connecting.catch((error: ZetaError) => error);
  expect(failure.kind).toBe("connect_failed");
  expect(String(failure)).not.toContain("secret");
  expect(failure.message).toContain("--ws-origin");
});

test("busy and version mismatch map to their kinds", async () => {
  for (const [code, kind] of [[-32001, "busy"], [-32002, "version_mismatch"]] as const) {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const connecting = connectZeta({ url: "ws://127.0.0.1:8765/", controller_token: "controller", observer_token: "observer" });
    const socket = await open(); error(socket, code);
    await expect(connecting).rejects.toMatchObject({ kind });
    FakeWebSocket.instances = [];
  }
});

test("server-level busy error maps to busy", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const connecting = connectZeta({ url: "ws://127.0.0.1:8765/", controller_token: "controller", observer_token: "observer" });
  const socket = await open();
  socket.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "another client is already connected" } }) });
  socket.emit("close", { code: 1000 });
  await expect(connecting).rejects.toMatchObject({ kind: "busy" });
});

test("close before hello rejects with connect_failed", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const connecting = connectZeta({ url: "ws://127.0.0.1:8765/", controller_token: "controller", observer_token: "observer" });
  const socket = await open();
  socket.emit("close", { code: 1006 });
  await expect(connecting).rejects.toMatchObject({ kind: "connect_failed" });
});

test("close after connect reports closed and close code", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const connecting = connectZeta({ url: "ws://127.0.0.1:8765/", controller_token: "controller", observer_token: "observer" });
  const socket = await open(); reply(socket, { protocol_version: "1.0" });
  const client = await connecting;
  const pending = client.request("status");
  socket.emit("close", { code: 1009 });
  await expect(pending).rejects.toMatchObject({ kind: "closed", code: 1009 });
});

test("parses pasted zeta urls without returning the token in the url", () => {
  expect(parseZetaUrl("ws://127.0.0.1:8765/?token=abc")).toEqual({ url: "ws://127.0.0.1:8765/", token: "abc" });
  expect(parseZetaUrl("ws://127.0.0.1:8765/")).toBeNull();
  expect(parseZetaUrl("http://127.0.0.1:8765/?token=abc")).toBeNull();
});

test("parseConnectFragment reads ws and token from the hash and rejects missing parts", () => {
  expect(parseConnectFragment("#ws=ws%3A%2F%2F127.0.0.1%3A1%2F&token=abc")).toEqual({ url: "ws://127.0.0.1:1/", token: "abc" });
  expect(parseConnectFragment("#ws=ws://test/")).toBeNull();
  expect(parseConnectFragment("#token=abc")).toBeNull();
});

test("fragment url with an embedded token returns a token-free url", () => {
  expect(parseConnectFragment("#ws=ws%3A%2F%2F127.0.0.1%2F%3Ftoken%3Dsecret&token=secret")).toEqual({
    url: "ws://127.0.0.1/",
    token: "secret",
  });
});

test("fragment with conflicting tokens is rejected", () => {
  expect(parseConnectFragment("#ws=ws%3A%2F%2F127.0.0.1%2F%3Ftoken%3Durl-token&token=fragment-token")).toBeNull();
});

test("no parser ever returns a url containing token=", () => {
  const inputs = [
    () => parseZetaUrl("ws://127.0.0.1:8765/?token=abc"),
    () => parseZetaUrl("ws://127.0.0.1:8765/"),
    () => parseZetaUrl("http://127.0.0.1:8765/?token=abc"),
    () => parseConnectFragment("#ws=ws%3A%2F%2F127.0.0.1%3A1%2F&token=abc"),
    () => parseConnectFragment("#ws=ws%3A%2F%2F127.0.0.1%2F%3Ftoken%3Dsecret&token=secret"),
    () => parseConnectFragment("#ws=ws://test/"),
    () => parseConnectFragment("#token=abc"),
    () => parseConnectFragment("#ws=wss%3A%2F%2Fattacker.example%2F&token=abc"),
    () => parseConnectFragment("#ws=https%3A%2F%2F127.0.0.1%2F&token=abc"),
  ];
  for (const result of inputs.map((parse) => parse())) {
    if (result) expect(result.url).not.toContain("token=");
  }
});

test("fragment with a non-loopback host is rejected", () => {
  expect(parseConnectFragment("#ws=wss%3A%2F%2Fattacker.example%2F&token=abc")).toBeNull();
});

test("fragment with a non-ws scheme is rejected", () => {
  expect(parseConnectFragment("#ws=https%3A%2F%2F127.0.0.1%2F&token=abc")).toBeNull();
});

test("pasted url with a non-loopback host is rejected", () => {
  expect(parseZetaUrl("wss://attacker.example/?token=abc")).toBeNull();
});

test("loopback websocket hosts are accepted by both parsers", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    expect(parseZetaUrl(`wss://${host}/?token=abc`)).toEqual({ url: `wss://${host}/`, token: "abc" });
    expect(parseConnectFragment(`#ws=${encodeURIComponent(`wss://${host}/`)}&token=abc`)).toEqual({ url: `wss://${host}/`, token: "abc" });
  }
});

test("discoverZeta returns null for 404 and keeps only string origins", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    expect(await discoverZeta()).toBeNull();
    globalThis.fetch = (async () => Response.json({ url: "ws://127.0.0.1:1/", token: "t", origins: ["http://localhost:5180", 3] })) as unknown as typeof fetch;
    expect(await discoverZeta()).toEqual({ url: "ws://127.0.0.1:1/", controller_token: "t", observer_token: "t", origins: ["http://localhost:5180"] });
    globalThis.fetch = (async () => Response.json({ url: 1 })) as unknown as typeof fetch;
    await expect(discoverZeta()).rejects.toThrow("invalid body");
  } finally {
    globalThis.fetch = original;
  }
});
