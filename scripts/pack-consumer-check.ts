import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const packages = (await readdir(join(root, "packages"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const temporary = await mkdtemp(join(tmpdir(), "fulcrum-pack-"));
const packed = join(temporary, "packed");
const consumer = join(temporary, "consumer");
await mkdir(packed);
await mkdir(consumer);

const run = (command: string[], cwd = root) => {
  const result = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} exited ${result.exitCode}`);
};

try {
  for (const name of packages) {
    const cwd = join(root, "packages", name);
    run(["bun", "run", "build"], cwd);
    run(["bun", "pm", "pack", "--destination", packed], cwd);
  }
  const tarballs = (await readdir(packed)).filter((name) => name.endsWith(".tgz")).map((name) => join(packed, name));
  if (tarballs.length !== packages.length) throw new Error(`packed ${tarballs.length} of ${packages.length} packages`);

  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "fulcrum-packed-consumer", private: true, type: "module" }, null, 2));
  run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "react@19", "react-dom@19", ...tarballs], consumer);
  await writeFile(join(consumer, "consumer.tsx"), `
import * as adapterTest from "@fulcrum/adapter-test";
import { createAiSdkAdapter, decodeAiSdkMessage, respondToApproval } from "@fulcrum/ai-sdk";
import { createRunStore } from "@fulcrum/core";
import * as highlight from "@fulcrum/highlight";
import { MermaidFence } from "@fulcrum/mermaid";
import { RunProvider, Timeline } from "@fulcrum/react";
import * as virtual from "@fulcrum/virtual";
import * as zeta from "@fulcrum/zeta";
import "@fulcrum/highlight/styles.css";
import "@fulcrum/react/styles.css";
import "@fulcrum/react/themes.css";
import "@fulcrum/mermaid/styles.css";
import React from "react";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

for (const [name, value] of Object.entries({ adapterTest, highlight, virtual, zeta }))
  if (Object.keys(value).length === 0) throw new Error(name + " root entry point is empty");
const worker = import.meta.resolve("@fulcrum/highlight/worker.js");
const highlightDist = dirname(fileURLToPath(import.meta.resolve("@fulcrum/highlight")));
if (!existsSync(fileURLToPath(worker)) || readdirSync(join(highlightDist, "chunks")).length === 0)
  throw new Error("highlight asset entry point is missing");
// the fence loads mermaid from ./render.js beside it on the first diagram
const mermaidDist = dirname(fileURLToPath(import.meta.resolve("@fulcrum/mermaid")));
if (typeof MermaidFence !== "function" || !existsSync(join(mermaidDist, "render.js")) || readdirSync(join(mermaidDist, "chunks")).length === 0)
  throw new Error("mermaid lazy render module is missing");

const reloaded = decodeAiSdkMessage({ id: "packed", role: "assistant", parts: [{ type: "text", text: "reloaded" }] }, { streamKey: "packed-reload" });
if (typeof respondToApproval !== "function" || !reloaded.some((event) => event.type === "message_commit"))
  throw new Error("ai-sdk approval and reload exports are missing");

const store = createRunStore(() => {});
const adapter = createAiSdkAdapter({ streamKey: "chat-request-123" });
export function onAiSdkPart(part: unknown) {
  for (const event of adapter.decode(part)) store.dispatch(event);
}
export function AgentRun() {
  return <RunProvider store={store}><Timeline /></RunProvider>;
}
onAiSdkPart({ type: "start", messageId: "packed" });
onAiSdkPart({ type: "text-start", id: "text" });
onAiSdkPart({ type: "text-delta", id: "text", delta: "hello" });
onAiSdkPart({ type: "text-end", id: "text" });
onAiSdkPart({ type: "finish" });
if (store.getOutline()[0]?.id !== "message:s:message:chat-request-123:1") throw new Error("AI SDK README quickstart did not commit its message");
if (typeof AgentRun !== "function") throw new Error("React quickstart did not load");
`);
  run(["bun", "run", "consumer.tsx"], consumer);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
