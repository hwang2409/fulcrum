import { afterEach, expect, test } from "bun:test";
import { connectZeta, parseConnectFragment, type ZetaError } from "../src/index.js";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  readonly sent: string[] = [];
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  addEventListener(name: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  emit(name: string, event: { data?: unknown } = {}) {
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

 test("sends the token in hello and resolves with the client", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const connecting = connectZeta({ url: "ws://test/", token: "secret", features: ["projects"] });
  const socket = await open();
  expect(JSON.parse(socket.sent[0])).toMatchObject({ method: "hello", params: { protocol_version: "1.0", client_version: "1.2", token: "secret", features: ["projects"] } });
  reply(socket, { protocol_version: "1.0" });
  await expect(connecting).resolves.toHaveProperty("request");
});

test("unauthorized error rejects with kind unauthorized and does not include the token", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const connecting = connectZeta({ url: "ws://test/", token: "secret" });
  const socket = await open(); error(socket, -32008);
  const failure = await connecting.catch((error: ZetaError) => error);
  expect(failure.kind).toBe("unauthorized"); expect(failure.message).not.toContain("secret");
});

test("busy and version mismatch map to their kinds", async () => {
  for (const [code, kind] of [[-32001, "busy"], [-32002, "version_mismatch"]] as const) {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const connecting = connectZeta({ url: "ws://test/", token: "secret" });
    const socket = await open(); error(socket, code);
    await expect(connecting).rejects.toMatchObject({ kind });
    FakeWebSocket.instances = [];
  }
});

test("socket that never opens rejects with connect_failed", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const connecting = connectZeta({ url: "ws://test/", token: "secret" });
  FakeWebSocket.instances[0].emit("error");
  await expect(connecting).rejects.toMatchObject({ kind: "connect_failed" });
});

test("close after connect reports closed and rejects pending requests", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const connecting = connectZeta({ url: "ws://test/", token: "secret" });
  const socket = await open(); reply(socket, { protocol_version: "1.0" });
  const client = await connecting;
  const pending = client.request("status");
  socket.emit("close");
  await expect(pending).rejects.toMatchObject({ kind: "closed" });
});

test("parseConnectFragment reads ws and token from the hash and rejects missing parts", () => {
  expect(parseConnectFragment("#ws=ws%3A%2F%2F127.0.0.1%3A1%2F&token=abc")).toEqual({ url: "ws://127.0.0.1:1/", token: "abc" });
  expect(parseConnectFragment("#ws=ws://test/")).toBeNull();
  expect(parseConnectFragment("#token=abc")).toBeNull();
});
