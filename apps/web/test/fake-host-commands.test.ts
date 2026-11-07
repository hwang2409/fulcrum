import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { connectZeta, fromZetaHistory } from "@fulcrum/zeta";
import { LONG, startFakeZeta } from "../scripts/fake-zeta";

async function credentials(fake: Awaited<ReturnType<typeof startFakeZeta>>) {
  const discovery = JSON.parse(await readFile(join(fake.home, "run", "serve.ws.json"), "utf8")) as { controller_token: string; observer_token: string };
  return { url: `ws://127.0.0.1:${fake.port}/`, token: discovery.controller_token, observerToken: discovery.observer_token };
}

const SOCKET_EVENT_DEADLINE_MS = 10_000;
const SOCKET_CLEANUP_DEADLINE_MS = 1_000;

async function closeSockets(sockets: readonly WebSocket[]) {
  await Promise.all(sockets.map((socket) => {
    if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        socket.removeEventListener("close", onClose);
        reject(new Error("timed out waiting for websocket close during cleanup"));
      }, SOCKET_CLEANUP_DEADLINE_MS);
      const onClose = () => {
        clearTimeout(deadline);
        resolve();
      };
      socket.addEventListener("close", onClose, { once: true });
      socket.close();
    });
  }));
}

function waitForSocketEvent<K extends "open" | "message" | "close">(
  socket: WebSocket,
  eventName: K,
  involvedSockets: readonly WebSocket[],
): Promise<WebSocketEventMap[K]> {
  return new Promise((resolve, reject) => {
    const onEvent = (event: Event) => {
      clearTimeout(deadline);
      resolve(event as WebSocketEventMap[K]);
    };
    const deadline = setTimeout(() => {
      socket.removeEventListener(eventName, onEvent);
      void closeSockets(involvedSockets).then(
        () => reject(new Error(`timed out waiting for websocket ${eventName}`)),
        (error) => reject(new Error(`timed out waiting for websocket ${eventName}; cleanup failed`, { cause: error })),
      );
    }, SOCKET_EVENT_DEADLINE_MS);
    socket.addEventListener(eventName, onEvent, { once: true });
  });
}

const hostCommands = () => [{
  name: "gamma-render",
  executable: "/opt/gamma/render",
  summary: "render a file",
  environment: { FOO: "bar" },
}];

test("fake zeta persists a live user append across replay", async () => {
  const fake = await startFakeZeta({ origins: [], live: false });
  const history = fake.historyOf(LONG);
  let client: Awaited<ReturnType<typeof connectZeta>> | undefined;
  try {
    client = await connectZeta({ ...(await credentials(fake)), features: ["session_history_backward", "user_message_event", "delivery_id", "user_message_delivery_id"] });
    await client.request("resume", { session_id: LONG });
    const load = async () => {
      const result = await client!.request("session_history", { session_id: LONG, before: null }) as { messages: unknown[] };
      return fromZetaHistory(result.messages);
    };
    const first = await client.replay(LONG, load);
    const appended = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => { unsubscribe(); reject(new Error("timed out waiting for live append")); }, 1_000);
      const unsubscribe = first.store.subscribeOutline(() => {
        if (first.store.getOutline().at(-1)?.id !== "user:delivery:append-after-replay") return;
        clearTimeout(deadline);
        unsubscribe();
        resolve();
      });
    });
    fake.emit({ event: "user_message", session_id: LONG, text: "no delivery id", mode: "send", attachments: [] });
    expect(fake.historyOf(LONG), "zeta persists an id-less echo only when its turn starts").toHaveLength(history.length);
    fake.emit({ event: "user_message", session_id: LONG, text: "after replay", mode: "send", attachments: [], delivery_id: "append-after-replay" });
    await appended;
    first.release();

    const second = await client.replay(LONG, load);
    expect(second.store.getOutline().at(-1)?.id).toBe("user:delivery:append-after-replay");
    second.release();
  } finally {
    client?.close();
    fake.restoreHistory(LONG, history);
    await fake.close();
  }
});

test("fake zeta permits one controller and an observer, without observer cleanup", async () => {
  const fake = await startFakeZeta({ origins: [], live: false });
  try {
    const connection = await credentials(fake);
    const controller = await connectZeta({ url: connection.url, token: connection.token });
    const observer = await connectZeta({ url: connection.url, role: "observer", token: connection.observerToken });
    observer.close();
    await expect(controller.request("status")).resolves.toHaveProperty("state", "idle");
    controller.close();
  } finally {
    await fake.close();
  }
});

test("fake zeta enforces eight observers and preserves a controller claim", async () => {
  const fake = await startFakeZeta({ origins: [], live: false });
  const connections: Array<{ close(): void }> = [];
  const rejectedHello = async (url: string, token: string, role: "controller" | "observer") => {
    const socket = new WebSocket(url, ["zeta.v1", `zeta.bearer.${token}`]);
    await waitForSocketEvent(socket, "open", [socket]);
    const message = waitForSocketEvent(socket, "message", [socket]);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { role, features: role === "observer" ? ["serve_observers"] : [] } }));
    const response = JSON.parse(String((await message).data)) as { error?: { code: number; message: string } };
    await closeSockets([socket]);
    return response;
  };
  try {
    const connection = await credentials(fake);
    const controller = await connectZeta({ url: connection.url, token: connection.token });
    connections.push(controller);
    for (let index = 0; index < 8; index++) connections.push(await connectZeta({ url: connection.url, role: "observer", token: connection.observerToken }));
    await expect(rejectedHello(connection.url, connection.observerToken, "observer")).resolves.toMatchObject({ error: { code: -32004, message: "observer limit reached" } });
    await expect(rejectedHello(connection.url, connection.token, "controller")).resolves.toMatchObject({ error: { code: -32001 } });
    await expect(controller.request("status")).resolves.toHaveProperty("state", "idle");
  } finally {
    for (const connection of connections) connection.close();
    await fake.close();
  }
}, SOCKET_EVENT_DEADLINE_MS + SOCKET_CLEANUP_DEADLINE_MS + 5_000);

test("fake zeta keeps the new controller after an old controller closes late", async () => {
  const fake = await startFakeZeta({ origins: [], live: false, overflowSilentCloseDelayMs: 20 });
  try {
    const connection = await credentials(fake);
    const old = await connectZeta({ url: connection.url, token: connection.token });
    fake.setMode("overflow-silent");
    fake.setMode("ok");
    const current = new WebSocket(connection.url, ["zeta.v1", `zeta.bearer.${connection.token}`]);
    await waitForSocketEvent(current, "open", [current]);
    const currentHello = waitForSocketEvent(current, "message", [current]);
    current.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { role: "controller", features: [] } }));
    await expect(currentHello.then((event) => JSON.parse(String(event.data)))).resolves.toMatchObject({ result: { protocol_version: "1.2" } });
    const rejected = new WebSocket(connection.url, ["zeta.v1", `zeta.bearer.${connection.token}`]);
    const rejectedOpen = waitForSocketEvent(rejected, "open", [current, rejected]);
    const rejectedMessage = waitForSocketEvent(rejected, "message", [current, rejected]);
    await rejectedOpen;
    rejected.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "hello", params: { role: "controller", features: [] } }));
    const response = JSON.parse(String((await rejectedMessage).data)) as { error?: { code: number; message: string } };
    expect(response.error).toMatchObject({ code: -32001, message: "server busy" });
    rejected.close();
    old.close();
    current.close();
  } finally {
    await fake.close();
  }
}, SOCKET_EVENT_DEADLINE_MS + SOCKET_CLEANUP_DEADLINE_MS + 5_000);

test("fake zeta releases the controller immediately after overflow-silent termination", async () => {
  const fake = await startFakeZeta({ origins: [], live: false, overflowSilentCloseDelayMs: 20 });
  try {
    const connection = await credentials(fake);
    const first = await connectZeta({ url: connection.url, token: connection.token });
    const secondSocket = new WebSocket(connection.url, ["zeta.v1", `zeta.bearer.${connection.token}`]);
    await waitForSocketEvent(secondSocket, "open", [secondSocket]);
    fake.setMode("overflow-silent");
    fake.setMode("ok");
    const hello = waitForSocketEvent(secondSocket, "message", [secondSocket]);
    secondSocket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { role: "controller", features: [] } }));
    await expect(hello.then((event) => JSON.parse(String(event.data)))).resolves.toMatchObject({ result: { protocol_version: "1.2" } });
    secondSocket.close();
    first.close();
  } finally {
    await fake.close();
  }
}, SOCKET_EVENT_DEADLINE_MS + SOCKET_CLEANUP_DEADLINE_MS + 5_000);

test("fake zeta validates host commands and requires a fresh binding after disconnect", async () => {
  const fake = await startFakeZeta({ origins: [], live: false });
  try {
    const connection = await credentials(fake);
    const first = await connectZeta({ ...connection, features: ["delivery_id"], hostCommands });
    expect(first.features).toContain("session_host_commands");
    const created = await first.request("new_session") as { session: { session_id: string } };
    first.close();
    await Bun.sleep(5);

    const unbound = await connectZeta({ ...connection, features: ["session_host_commands", "delivery_id"] });
    await expect(unbound.request("send", { text: "hello", delivery_id: "delivery-1" })).rejects.toMatchObject({
      code: -32003,
      data: { code: "host_binding_required" },
    });
    await expect(unbound.request("resume", {
      session_id: created.session.session_id,
      host_commands: [{ ...hostCommands()[0], name: "1bad" }],
    })).rejects.toMatchObject({ code: -32602 });
    unbound.close();
    await Bun.sleep(5);

    const rebound = await connectZeta({ ...connection, features: ["delivery_id"], hostCommands });
    await rebound.request("resume", { session_id: created.session.session_id });
    await expect(rebound.request("send", { text: "hello", delivery_id: "delivery-2" })).resolves.toMatchObject({ accepted: true });
    rebound.close();
  } finally {
    await fake.close();
  }
});
