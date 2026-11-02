import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectZeta,
  createClient,
  webSocketTransport,
  type ZetaError,
} from "@fulcrum/zeta";

const command = process.env.ZETA_CMD ?? "/tmp/zeta-ws/.venv/bin/zeta";
const parts = command.trim().split(/\s+/);
const home = await mkdtemp(join(tmpdir(), "fulcrum-zeta-smoke-"));
let child: ChildProcess | undefined;
let spawnError: Error | undefined;
let stopping = false;

async function stopServer() {
  if (stopping) return;
  stopping = true;
  if (child?.pid && child.exitCode === null) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    await Promise.race([
      new Promise<void>((resolve) => child?.once("exit", () => resolve())),
      Bun.sleep(1_000),
    ]);
    if (child.exitCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
  }
  await rm(home, { recursive: true, force: true });
}

const onSignal = (signal: NodeJS.Signals) => {
  void stopServer().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
};
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

try {
  const probe = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {}, close() {} },
  });
  const port = probe.port;
  probe.stop(true);

  await writeFile(
    join(home, "settings.toml"),
    'provider = "ollama"\nmodel = "qwen3:4b"\n',
  );
  child = spawn(parts[0], [...parts.slice(1), "serve", "--ws", String(port)], {
    detached: true,
    env: { ...process.env, ZETA_HOME: home },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (data) => { stderr += data.toString(); });
  child.once("error", (error) => { spawnError = error; });

  const discovery = join(home, "run", "serve.ws.json");
  let connection: { port: number; token: string } | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      connection = JSON.parse(await readFile(discovery, "utf8"));
      break;
    } catch {
      if (spawnError || child.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  if (!connection) {
    const detail = spawnError?.message ?? stderr.replace(/token=[^\s]+/g, "token=<redacted>").trim();
    throw new Error(`zeta server did not start${detail ? `: ${detail}` : ""}`);
  }

  const url = `ws://127.0.0.1:${connection.port}/`;
  const token = connection.token;
  const rows: Array<[string, string]> = [];
  const check = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
      rows.push([name, "pass"]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rows.push([name, `fail: ${message.replaceAll(token, "<redacted>")}`]);
    }
  };
  const settle = () => Bun.sleep(50);

  await check("hello", async () => {
    const transport = await webSocketTransport(`${url}?token=${encodeURIComponent(token)}`);
    const client = createClient(transport);
    const hello = await client.hello();
    console.log(
      `negotiated version: ${hello.protocol_version}; features: ${(hello.capabilities?.features ?? []).join(",") || "none"}`,
    );
    client.close();
    await settle();
  });
  await check("list_sessions", async () => {
    const client = await connectZeta({ url, token });
    const result = await client.request("list_sessions");
    if (!Array.isArray((result as { sessions?: unknown[] }).sessions))
      throw new Error("invalid result");
    client.close();
    await settle();
  });
  await check("wrong token -> connect_failed", async () => {
    try {
      await connectZeta({ url, token: "wrong" });
      throw new Error("connected");
    } catch (error) {
      if ((error as ZetaError).kind !== "connect_failed") throw error;
      if (String(error).includes("wrong")) throw new Error("token leaked");
    }
  });

  const first = await connectZeta({ url, token });
  await check("second concurrent client -> busy", async () => {
    try {
      await connectZeta({ url, token });
      throw new Error("connected");
    } catch (error) {
      if ((error as ZetaError).kind !== "busy") throw error;
    }
  });
  first.close();
  await settle();

  const raw = (payload: string | ArrayBuffer, expected: number) =>
    new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("timed out waiting for close"));
      }, 5_000);
      socket.onopen = () => socket.send(payload);
      socket.onclose = (event) => {
        clearTimeout(timeout);
        event.code === expected
          ? resolve()
          : reject(new Error(`close ${event.code}, expected ${expected}`));
      };
      socket.onerror = () => {};
    });
  await check("binary frame -> closed 1003", () =>
    raw(new Uint8Array([1]).buffer, 1003),
  );
  await check(">1 MiB frame -> closed 1009", () =>
    raw("x".repeat(1024 * 1024 + 1), 1009),
  );

  console.log("\ncheck                         result");
  console.log("----------------------------  ------");
  for (const [name, result] of rows)
    console.log(`${name.padEnd(28)}  ${result}`);
  console.log(
    "bun WebSocket sends no Origin header; zeta accepts this native-client case when the token is valid.",
  );
  if (rows.some(([, result]) => result.startsWith("fail"))) process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  await stopServer();
}
