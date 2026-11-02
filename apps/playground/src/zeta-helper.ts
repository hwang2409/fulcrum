import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export type Discovery = { url: string; token: string };

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
      const data = JSON.parse(await readFile(file, "utf8")) as { port: number; token: string };
      const body: Discovery = { url: `ws://127.0.0.1:${data.port}/`, token: data.token };
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    } catch {
      res.statusCode = 404;
      res.end();
    }
  };
}

export function zetaDiscoveryPlugin() {
  return {
    name: "fulcrum-zeta-discovery",
    apply: "serve" as const,
    configureServer(server: { httpServer?: { address: () => { port: number } | string | null }; middlewares: { use: (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void) => void } }) {
      const handler = createZetaDiscoveryHandler(undefined, () => {
        const address = server.httpServer?.address();
        return address && typeof address === "object" ? address.port : undefined;
      });
      server.middlewares.use("/__fulcrum/zeta", (req, res) => void handler(req, res));
    },
  };
}
