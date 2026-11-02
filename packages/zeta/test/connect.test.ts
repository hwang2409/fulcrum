import { afterEach, expect, test } from "bun:test";
import { connectZeta, parseConnectFragment, parseZetaUrl, type ZetaError } from "../src/index.js";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly listeners = new Map<string, Array<(event: { data?: unknown; code?: number }) => void>>();
  readonly sent: string[] = [];
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
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

 test("puts the token in the websocket url and omits it from hello", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const connecting = connectZeta({ url: "ws://127.0.0.1:8765/", token: "secret", features: ["projects"] });
  const socket = await open();
  expect(socket.url).toBe("ws://127.0.0.1:8765/?token=secret");
  expect(JSON.parse(socket.sent[0])).toMatchObject({ method: "hello", params: { protocol_version: "1.0", client_version: "1.2", features: ["projects"] } });
  expect(socket.sent[0]).not.toContain("secret");
  reply(socket, { protocol_version: "1.0" });
  await expect(connecting).resolves.toHaveProperty("request");
});

test("failed upgrade rejects with connect_failed without exposing the token", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const connecting = connectZeta({ url: "ws://127.0.0.1:8765/", token: "secret" });
  FakeWebSocket.instances[0].emit("error");
  const failure = await connecting.catch((error: ZetaError) => error);
  expect(failure.kind).toBe("connect_failed");
  expect(String(failure)).not.toContain("secret");
  expect(failure.message).toContain("--ws-origin");
});

test("busy and version mismatch map to their kinds", async () => {
  for (const [code, kind] of [[-32001, "busy"], [-32002, "version_mismatch"]] as const) {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const connecting = connectZeta({ url: "ws://127.0.0.1:8765/", token: "secret" });
    const socket = await open(); error(socket, code);
    await expect(connecting).rejects.toMatchObject({ kind });
    FakeWebSocket.instances = [];
  }
});

test("close before hello rejects with connect_failed", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const connecting = connectZeta({ url: "ws://127.0.0.1:8765/", token: "secret" });
  const socket = await open();
  socket.emit("close", { code: 1006 });
  await expect(connecting).rejects.toMatchObject({ kind: "connect_failed" });
});

test("close after connect reports closed and close code", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const connecting = connectZeta({ url: "ws://127.0.0.1:8765/", token: "secret" });
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
