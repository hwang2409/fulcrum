import { afterEach, beforeEach, expect, test } from "bun:test";
import { domShimAlarm, shimProperty } from "../../../test-support/dom-shim.js";
import { createAiSdkAdapter } from "../src/index.js";
domShimAlarm(import.meta.path);

const source = new URL("../src/index.ts", import.meta.url).pathname;
const anonymous = [{ type: "start" }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "hi" }, { type: "text-end", id: "t" }, { type: "finish" }];
const named = [{ type: "start", messageId: "m1" }, ...anonymous.slice(1)];

let warnings: unknown[][] = [];
let restoreWarn: (() => void) | undefined;
beforeEach(() => {
  warnings = [];
  restoreWarn = shimProperty(console, "warn", {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => void warnings.push(args),
  });
});
afterEach(() => { restoreWarn?.(); });

test("a start without a message id warns once per adapter in development, naming the server fix and the README section", () => {
  const first = createAiSdkAdapter({ streamKey: "a", originalMessages: [] });
  for (const part of [...anonymous, ...anonymous]) first.decode(part);
  expect(warnings.length).toBe(1);
  const text = String(warnings[0]![0]);
  expect(text).toContain("both `originalMessages` and `generateMessageId`");
  expect(text).toContain("https://github.com/hwang2409/fulcrum/blob/main/packages/ai-sdk/README.md#server-message-ids");
  // The adapter still decodes the stream: the warning is advice, not a refusal.
  expect(createAiSdkAdapter({ streamKey: "quiet", originalMessages: [] }).decode({ type: "start" }).map((event) => event.type)).toEqual(["run_start", "turn_start", "message_start"]);
  warnings = [];
  const second = createAiSdkAdapter({ streamKey: "b", originalMessages: [] });
  for (const part of anonymous) second.decode(part);
  expect(warnings.length).toBe(1);
});

test("a start with a message id does not warn", () => {
  const adapter = createAiSdkAdapter({ streamKey: "a", originalMessages: [] });
  for (const part of [...named, ...named]) adapter.decode(part);
  expect(warnings).toEqual([]);
});

// The server set generateMessageId but not originalMessages: each request names a new message, so a continuation's
// id differs from the assistant message its request continues.
const sent = [{ id: "u1", role: "user", parts: [{ type: "text", text: "go" }] }, { id: "m1", role: "assistant", parts: [{ type: "text", text: "i will delete it." }] }];
test("a continuation whose start names a different message than the one it continues warns once, naming both options", () => {
  const adapter = createAiSdkAdapter({ streamKey: "c", originalMessages: sent });
  for (const part of [...named, ...named].map((part) => part.type === "start" ? { type: "start", messageId: "m2" } : part)) adapter.decode(part);
  expect(warnings.length).toBe(1);
  const text = String(warnings[0]![0]);
  expect(text).toContain('"m1"');
  expect(text).toContain('"m2"');
  expect(text).toContain("both `originalMessages` and `generateMessageId`");
  expect(text).toContain("README.md#server-message-ids");
  warnings = [];
  // The right server setup: the continuation keeps the message id; a new prompt's request ends with a user message.
  const kept = createAiSdkAdapter({ streamKey: "d", originalMessages: sent });
  for (const part of named.map((part) => part.type === "start" ? { type: "start", messageId: "m1" } : part)) kept.decode(part);
  const fresh = createAiSdkAdapter({ streamKey: "e", originalMessages: [...sent, { id: "u2", role: "user", parts: [] }] });
  for (const part of named) fresh.decode(part);
  expect(warnings).toEqual([]);
});

test("production (__FULCRUM_DEV__ = false) never warns, and a minifier that defines it drops the warning", async () => {
  // The development rule is read once at module load, so production needs its own process.
  const script = `globalThis.__FULCRUM_DEV__ = false;
    let warned = 0; Reflect.set(console, "warn", () => { warned++; });
    const { createAiSdkAdapter } = await import(${JSON.stringify(source)});
    const adapter = createAiSdkAdapter({ streamKey: "a", originalMessages: [] });
    for (const part of ${JSON.stringify([...anonymous, ...anonymous])}) adapter.decode(part);
    console.log(warned);`;
  const run = Bun.spawnSync([process.execPath, "--eval", script]);
  expect(run.stderr.toString()).toBe("");
  expect(run.stdout.toString().trim()).toBe("0");
  const build = await Bun.build({ entrypoints: [source], minify: true, define: { "globalThis.__FULCRUM_DEV__": "false" } });
  const output = await build.outputs[0]!.text();
  expect(output).toContain("createAiSdkAdapter");
  expect(output).not.toContain("generateMessageId");
});
