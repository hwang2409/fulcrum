import { expect, test } from "bun:test";
import {
  MODEL_INPUT_IDS_FEATURE,
  listSlashCommands,
  parseSendResult,
  parseSlashList,
  parseSlashRun,
  runSlashCommand,
  sendModelInput,
} from "../src/index.js";

// Mirrors zeta docs/serve-protocol.md:1299-1316 and src/zeta/server/slash_commands.py:65-80.
const catalog = {
  commands: [
    { name: "status", description: "show status", kind: "builtin", source: "builtin", client_only: false, unavailable: null, future_field: true },
    { name: "build", description: "build prompt", kind: "skill", source: "project", client_only: false, unavailable: null },
    { name: "bad", kind: "builtin" },
  ],
  notices: ["skill catalog refreshed", 4],
};

// Mirrors zeta docs/serve-protocol.md:1317-1347 and src/zeta/server/slash_commands.py:433-447.
test("parses every slash result kind and tolerates extra fields", () => {
  expect(parseSlashList(catalog)).toEqual({
    commands: [catalog.commands[0], catalog.commands[1]],
    notices: ["skill catalog refreshed"],
  });
  expect(parseSlashRun({ kind: "output", text: "done", extra: true })).toEqual({ kind: "output", text: "done" });
  expect(parseSlashRun({ kind: "model_input", text: "expanded", display_text: "/skill x", origin: "skill" })).toEqual({ kind: "model_input", text: "expanded", display_text: "/skill x", origin: "skill" });
  expect(parseSlashRun({ kind: "model_input", input_id: "opaque-1", display_text: "/skill x", extra: true })).toEqual({ kind: "model_input", input_id: "opaque-1", display_text: "/skill x" });
  expect(parseSlashRun({ kind: "client_only", name: "keys" })).toEqual({ kind: "client_only", name: "keys" });
  expect(parseSlashRun({ kind: "unknown", name: "missing" })).toEqual({ kind: "unknown", name: "missing" });
  expect(parseSlashRun({ kind: "error", text: "failed" })).toEqual({ kind: "error", text: "failed" });
});

test("malformed rows and discriminators fail safely", () => {
  expect(parseSlashList({ commands: [{ name: "ok", description: "ok", kind: "bad", source: "builtin", client_only: false, unavailable: null }, null], notices: "bad" })).toEqual({ commands: [], notices: [] });
  expect(parseSlashRun(null)).toEqual({ kind: "malformed" });
  expect(parseSlashRun({ kind: "output", text: 4 })).toEqual({ kind: "malformed" });
  expect(parseSlashRun({ kind: "model_input", input_id: "id" })).toEqual({ kind: "malformed" });
  expect(parseSlashRun({ kind: "future", text: "x" })).toEqual({ kind: "malformed" });
  expect(parseSendResult({ accepted: true, session_id: 4 })).toEqual({ kind: "malformed" });
  expect(MODEL_INPUT_IDS_FEATURE).toBe("model_input_ids");
});

test("wrappers use the documented rpc methods and params", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const client = { request(method: string, params: Record<string, unknown>) {
    calls.push([method, params]);
    if (method === "slash_list") return Promise.resolve(catalog);
    if (method === "slash_run") return Promise.resolve({ kind: "unknown", name: "missing" });
    return Promise.resolve({ accepted: true, session_id: "s1" });
  } };
  await expect(listSlashCommands(client, "s1")).resolves.toHaveProperty("commands");
  await expect(runSlashCommand(client, "s1", "/missing")).resolves.toEqual({ kind: "unknown", name: "missing" });
  await expect(sendModelInput(client, "s1", "opaque-1")).resolves.toEqual({ accepted: true, session_id: "s1" });
  expect(calls).toEqual([
    ["slash_list", { session_id: "s1" }],
    ["slash_run", { session_id: "s1", text: "/missing" }],
    ["send", { session_id: "s1", input_id: "opaque-1" }],
  ]);
});
