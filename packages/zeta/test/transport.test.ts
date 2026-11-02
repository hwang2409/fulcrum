import { afterEach, expect, test } from "bun:test";
import { connect, webSocketTransport, type Transport } from "../src/index.js";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(name: string, listener: (event: { data?: unknown }) => void) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  emit(name: string, event: { data?: unknown } = {}) {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  send(text: string) {
    this.sent.push(text);
  }

  close() {
    this.emit("close");
  }
}

const OriginalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.WebSocket = OriginalWebSocket;
  FakeWebSocket.instances = [];
});

test("does not send before open", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const connecting = webSocketTransport("ws://test");
  const socket = FakeWebSocket.instances[0];

  expect(socket.sent).toEqual([]);
  socket.emit("open");
  const transport = await connecting;
  transport.send("hello");
  expect(socket.sent).toEqual(["hello"]);
});

test("error before open rejects", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const connecting = webSocketTransport("ws://test");
  FakeWebSocket.instances[0].emit("error");

  await expect(connecting).rejects.toThrow("websocket error");
});

test("close rejects pending requests", async () => {
  let onMessage!: (text: string) => void;
  let onClose!: () => void;
  const transport: Transport = {
    send() {},
    onMessage(callback) { onMessage = callback; },
    onClose(callback) { onClose = callback; },
    close() {},
  };
  const client = connect(transport);
  const hello = client.hello();
  onMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocol_version: "1.0" } }));
  await hello;
  const pending = client.request("status");

  onClose();

  await expect(pending).rejects.toThrow("transport closed");
});

test("send throwing removes the pending entry and rejects", async () => {
  let onMessage!: (text: string) => void;
  let shouldThrow = true;
  const transport: Transport = {
    send() {
      if (shouldThrow) throw new Error("send failed");
    },
    onMessage(callback) { onMessage = callback; },
    onClose() {},
    close() {},
  };
  const client = connect(transport);

  await expect(client.hello()).rejects.toThrow("send failed");
  shouldThrow = false;
  const hello = client.hello();
  onMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocol_version: "stale" } }));
  onMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { protocol_version: "1.0" } }));
  await expect(hello).resolves.toEqual({ protocol_version: "1.0" });
});
