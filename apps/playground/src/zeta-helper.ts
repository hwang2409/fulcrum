import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export type Discovery = { url: string; token: string };

export function createZetaDiscoveryHandler(
  file = join(process.env.ZETA_HOME || join(homedir(), ".zeta"), "run", "serve.ws.json"),
  origin = "http://localhost:5173",
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host;
    const expected = new URL(origin);
    if ((!host || !new Set([`localhost:${expected.port}`, `127.0.0.1:${expected.port}`]).has(host)) || req.headers["sec-fetch-site"] !== "same-origin" || (req.headers.origin && req.headers.origin !== origin)) {
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
    configureServer(server: { middlewares: { use: (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void) => void }; config: { server: { port?: number }; logger: { info: (message: string) => void } } }) {
      const port = server.config.server.port || 5173;
      const origin = `http://localhost:${port}`;
      const handler = createZetaDiscoveryHandler(undefined, origin);
      server.middlewares.use("/__fulcrum/zeta", (req, res) => void handler(req, res));
    },
  };
}
