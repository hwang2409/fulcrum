import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createZetaDiscoveryHandler } from "../src/discovery.js";

async function call(headers: Record<string, string>, file?: string) {
  const response = { statusCode: 0, headers: {} as Record<string, string>, body: "", setHeader(k: string, v: string) { this.headers[k] = v; }, end(body = "") { this.body = body; } };
  await createZetaDiscoveryHandler(file, "http://localhost:5173")({ headers } as never, response as never);
  return response;
}
const same = { host: "localhost:5173", "sec-fetch-site": "same-origin", origin: "http://localhost:5173" };

test("rejects a foreign Host header", async () => expect((await call({ ...same, host: "evil.test:5173" })).statusCode).toBe(404));
test("rejects cross-site Sec-Fetch-Site", async () => expect((await call({ ...same, "sec-fetch-site": "cross-site" })).statusCode).toBe(404));
test("rejects a foreign Origin", async () => expect((await call({ ...same, origin: "http://evil.test:5173" })).statusCode).toBe(404));
test("returns url and token for same-origin requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fulcrum-")); const file = join(dir, "serve.ws.json");
  await writeFile(file, JSON.stringify({ port: 8765, token: "secret" }));
  const response = await call(same, file);
  expect(response.statusCode).toBe(200); expect(JSON.parse(response.body)).toEqual({ url: "ws://127.0.0.1:8765/", token: "secret", origins: [] });
});
test("404 when the file is missing", async () => expect((await call(same, "/missing")).statusCode).toBe(404));
test("never sets CORS headers", async () => expect((await call(same, "/missing")).headers).not.toHaveProperty("Access-Control-Allow-Origin"));
test("passes the origin allowlist and the token while the server process runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fulcrum-")); const file = join(dir, "serve.ws.json");
  await writeFile(file, JSON.stringify({ port: 8765, token: "secret", pid: process.pid, origins: ["http://localhost:5173", 7] }));
  const response = await call(same, file);
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({ url: "ws://127.0.0.1:8765/", token: "secret", origins: ["http://localhost:5173"] });
});
test("404 when the file names a process that is gone (a crash left it behind)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fulcrum-")); const file = join(dir, "serve.ws.json");
  await writeFile(file, JSON.stringify({ port: 8765, token: "secret", pid: 2_147_483_646, origins: [] }));
  expect((await call(same, file)).statusCode).toBe(404);
});
