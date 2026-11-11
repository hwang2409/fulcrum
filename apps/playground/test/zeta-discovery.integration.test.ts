import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { zetaDiscoveryPlugin } from "@fulcrum/zeta/discovery";
import { domShimAlarm, shimProperty } from "../../../test-support/dom-shim.js";

let server: ViteDevServer;
let base: string;
let restoreHome: (() => void) | undefined;

beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), "fulcrum-zeta-home-"));
  await mkdir(join(home, "run"));
  await writeFile(join(home, "run", "serve.ws.json"), JSON.stringify({ port: 8765, controller_token: "controller", observer_token: "observer" }));
  restoreHome = shimProperty(process.env, "ZETA_HOME", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: home,
  });
  server = await createServer({ configFile: false, plugins: [zetaDiscoveryPlugin()], server: { port: 0, cors: false } });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("vite did not bind a tcp port");
  base = `http://localhost:${address.port}`;
});

afterAll(async () => {
  await server.close();
  restoreHome?.();
});
domShimAlarm(import.meta.path);

const request = (headers: Record<string, string> = {}) => fetch(`${base}/__fulcrum/zeta`, { headers });
const sameOrigin = () => ({ "Sec-Fetch-Site": "same-origin", Origin: base });

test("works on the actually bound port with no CORS headers", async () => {
  const response = await request(sameOrigin());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ url: "ws://127.0.0.1:8765/", controller_token: "controller", observer_token: "observer", origins: [] });
  expect([...response.headers.keys()].filter((key) => key.startsWith("access-control-"))).toEqual([]);
});

test("accepts the 127.0.0.1 origin form", async () => {
  const response = await request({ ...sameOrigin(), Origin: base.replace("localhost", "127.0.0.1") });
  expect(response.status).toBe(200);
});

test("rejects foreign origin, host, and cross-site fetch", async () => {
  expect((await request({ ...sameOrigin(), Origin: "http://evil.test" })).status).toBe(404);
  expect([404, 403]).toContain((await request({ ...sameOrigin(), Host: "evil.test" })).status);
  expect((await request({ ...sameOrigin(), "Sec-Fetch-Site": "cross-site" })).status).toBe(404);
});
