import { afterEach, beforeEach, expect, test } from "bun:test";
import { createAiSdkAdapter } from "../src/index.js";

const source = new URL("../src/index.ts", import.meta.url).pathname;
const anonymous = [{ type: "start" }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "hi" }, { type: "text-end", id: "t" }, { type: "finish" }];
const named = [{ type: "start", messageId: "m1" }, ...anonymous.slice(1)];

let warnings: unknown[][] = [];
const warn = console.warn;
beforeEach(() => { warnings = []; console.warn = (...args: unknown[]) => void warnings.push(args); });
afterEach(() => { console.warn = warn; });

test("a start without a message id warns once per adapter in development, naming the server fix and the README section", () => {
  const first = createAiSdkAdapter({ streamKey: "a" });
  for (const part of [...anonymous, ...anonymous]) first.decode(part);
  expect(warnings.length).toBe(1);
  const text = String(warnings[0]![0]);
  expect(text).toContain("generateMessageId");
  expect(text).toContain("originalMessages");
  expect(text).toContain("https://github.com/hwang2409/fulcrum/blob/main/packages/ai-sdk/README.md#streams-without-a-message-id");
  // The adapter still decodes the stream: the warning is advice, not a refusal.
  expect(createAiSdkAdapter({ streamKey: "quiet" }).decode({ type: "start" }).map((event) => event.type)).toEqual(["run_start", "turn_start", "message_start"]);
  warnings = [];
  const second = createAiSdkAdapter({ streamKey: "b" });
  for (const part of anonymous) second.decode(part);
  expect(warnings.length).toBe(1);
});

test("a start with a message id does not warn", () => {
  const adapter = createAiSdkAdapter({ streamKey: "a" });
  for (const part of [...named, ...named]) adapter.decode(part);
  expect(warnings).toEqual([]);
});

test("production (__FULCRUM_DEV__ = false) never warns, and a minifier that defines it drops the warning", async () => {
  // The development rule is read once at module load, so production needs its own process.
  const script = `globalThis.__FULCRUM_DEV__ = false;
    let warned = 0; console.warn = () => { warned++; };
    const { createAiSdkAdapter } = await import(${JSON.stringify(source)});
    const adapter = createAiSdkAdapter({ streamKey: "a" });
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
