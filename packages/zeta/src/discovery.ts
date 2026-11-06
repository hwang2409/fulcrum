// Node-only dev-server helper (`@fulcrum/zeta/discovery`): hands the running `zeta serve --ws` connection to a page on
// the same loopback origin. The token never leaves loopback and is never logged.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { zetaDiscoveryPath, type ZetaDiscovery } from "./connect.js";

const alive = (pid: unknown) => {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return true; // no pid to check: let the connect decide
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Answers same-origin loopback requests: 200 with a `ZetaDiscovery` while the server process runs, else 204 (a stopped
 * zeta is a normal state, so the page's retries log nothing). Any other request gets 404.
 */
export function createZetaDiscoveryHandler(
  file = join(process.env.ZETA_HOME || join(homedir(), ".zeta"), "run", "serve.ws.json"),
  port: number | string | (() => number | undefined) = 5173,
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const actualPort = typeof port === "function" ? port() : typeof port === "string" ? new URL(port).port : port;
    const host = req.headers.host;
    const hosts = new Set([`localhost:${actualPort}`, `127.0.0.1:${actualPort}`]);
    const origins = new Set([`http://localhost:${actualPort}`, `http://127.0.0.1:${actualPort}`]);
    if ((!actualPort || !host || !hosts.has(host)) || req.headers["sec-fetch-site"] !== "same-origin" || (req.headers.origin && !origins.has(req.headers.origin))) {
      res.statusCode = 404;
      res.end();
      return;
    }
    try {
      const data = JSON.parse(await readFile(file, "utf8")) as { port: number; controller_token?: string; observer_token?: string; token?: string; pid?: unknown; origins?: unknown };
      // A crash leaves the file behind; a dead pid means the server is not running.
      if (!alive(data.pid)) throw new Error("stale discovery file");
      const allowed = Array.isArray(data.origins) ? data.origins.filter((origin): origin is string => typeof origin === "string") : [];
      const controller_token = data.controller_token ?? data.token;
      if (typeof controller_token !== "string") throw new Error("invalid discovery file");
      const body: ZetaDiscovery = { url: `ws://127.0.0.1:${data.port}/`, controller_token, observer_token: data.observer_token ?? controller_token, origins: allowed };
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(body));
    } catch {
      res.statusCode = 204;
      res.end();
    }
  };
}

/** Vite plugin: serves `zetaDiscoveryPath` in dev, bound to the port the dev server actually listens on. */
export function zetaDiscoveryPlugin(file?: string) {
  return {
    name: "fulcrum-zeta-discovery",
    apply: "serve" as const,
    configureServer(server: { httpServer?: { address: () => { port: number } | string | null } | null; middlewares: { use: (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void) => void } }) {
      const handler = createZetaDiscoveryHandler(file, () => {
        const address = server.httpServer?.address();
        return address && typeof address === "object" ? address.port : undefined;
      });
      server.middlewares.use(zetaDiscoveryPath, (req, res) => void handler(req, res));
    },
  };
}
