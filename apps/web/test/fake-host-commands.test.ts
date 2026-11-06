import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { connectZeta } from "@fulcrum/zeta";
import { startFakeZeta } from "../scripts/fake-zeta";

async function credentials(fake: Awaited<ReturnType<typeof startFakeZeta>>) {
  const discovery = JSON.parse(await readFile(join(fake.home, "run", "serve.ws.json"), "utf8")) as { controller_token: string; observer_token: string };
  return { url: `ws://127.0.0.1:${fake.port}/`, token: discovery.controller_token, observerToken: discovery.observer_token };
}

const hostCommands = () => [{
  name: "gamma-render",
  executable: "/opt/gamma/render",
  summary: "render a file",
  environment: { FOO: "bar" },
}];

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
  const rejectedHello = (url: string, token: string, role: "controller" | "observer") => new Promise<{ error?: { code: number; message: string } }>((resolve) => {
    const socket = new WebSocket(url, ["zeta.v1", `zeta.bearer.${token}`]);
    socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { role, features: role === "observer" ? ["serve_observers"] : [] } }));
    socket.onmessage = (event) => { resolve(JSON.parse(String(event.data))); socket.close(); };
  });
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
});

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
