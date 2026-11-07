import { expect, test } from "bun:test";
import {
  MODEL_INPUT_IDS_FEATURE,
  listSlashCommands,
  parseModelInput,
  parseSendResult,
  parseSlashList,
  parseSlashRun,
  runSlashCommand,
  sendModelInput,
} from "../src/index.js";

// Mirrors zeta docs/serve-protocol.md:1299-1316 and src/zeta/server/slash_commands.py:65-80.
const validCommand = { name: "status", description: "show status", kind: "builtin", source: "builtin", client_only: false, unavailable: null };
const catalog = {
  commands: [validCommand, { ...validCommand, name: "build", kind: "skill", source: "project" }, { name: "bad", kind: "builtin" }],
  notices: ["skill catalog refreshed", 4],
};

// Mirrors zeta docs/serve-protocol.md:1317-1350 and src/zeta/server/slash_commands.py:474-489.
test("parses every slash result kind and both model-input shapes", () => {
  expect(parseSlashList(catalog)).toEqual({ commands: [validCommand, { ...validCommand, name: "build", kind: "skill", source: "project" }], notices: ["skill catalog refreshed"] });
  expect(parseSlashRun({ kind: "output", text: "done", extra: true })).toEqual({ kind: "output", text: "done" });
  // Legacy released zeta shape from src/zeta/server/slash_commands.py:413-425 at 5feea2fc; the protocol doc omits this kind.
  expect(parseSlashRun({ kind: "text", text: "mcp status" })).toEqual({ kind: "output", text: "mcp status" });
  expect(parseSlashRun({ kind: "model_input", text: "expanded", display_text: "/skill x", origin: "skill" })).toEqual({ kind: "model_input", text: "expanded", display_text: "/skill x", origin: "skill" });
  expect(parseSlashRun({ kind: "model_input", input_id: "opaque-1", text: "legacy", display_text: "/skill x", extra: true })).toEqual({ kind: "model_input", input_id: "opaque-1", display_text: "/skill x" });
  expect(parseSlashRun({ kind: "client_only", name: "keys" })).toEqual({ kind: "client_only", name: "keys" });
  expect(parseSlashRun({ kind: "unknown", name: "missing" })).toEqual({ kind: "unknown", name: "missing" });
  expect(parseSlashRun({ kind: "error", text: "failed" })).toEqual({ kind: "error", text: "failed" });
});

test("validates either model-input shape or requires an opaque input id", () => {
  // Zeta src/zeta/server/slash_commands.py:474-489 emits the text form without model_input_ids and the id form with it.
  const text = { kind: "model_input", text: "expanded", display_text: "/skill x", origin: "skill" };
  const id = { kind: "model_input", input_id: "opaque-1", display_text: "/skill x" };
  expect(parseModelInput(text)).toEqual(text);
  expect(parseModelInput(id)).toEqual(id);
  expect(parseModelInput(id, true)).toEqual(id);
  expect(parseModelInput(text, true)).toBeNull();
  expect(parseModelInput({ kind: "output", input_id: "opaque-1", display_text: "/skill x" })).toBeNull();
});

test("drops malformed discriminators, fields, and rows independently", () => {
  for (const value of [null, {}, { kind: 4 }, { kind: "future" }]) expect(parseSlashRun(value)).toEqual({ kind: "malformed" });
  for (const [kind, field] of [["output", "text"], ["text", "text"], ["error", "text"], ["client_only", "name"], ["unknown", "name"]] as const) {
    expect(parseSlashRun({ kind, [field]: 4 })).toEqual({ kind: "malformed" });
  }
  for (const value of [
    { kind: "model_input", display_text: "x" },
    { kind: "model_input", display_text: 4, text: "x", origin: "skill" },
    { kind: "model_input", display_text: "x", input_id: 4 },
    { kind: "model_input", display_text: "x", input_id: 4, text: "x", origin: "skill" },
    { kind: "model_input", display_text: "x", text: 4, origin: "skill" },
    { kind: "model_input", display_text: "x", text: "x" },
    { kind: "model_input", display_text: "x", text: "x", origin: 4 },
  ]) expect(parseSlashRun(value)).toEqual({ kind: "malformed" });

  const badFields = [
    ["name", 4], ["description", 4], ["kind", 4], ["source", 4], ["client_only", "no"], ["unavailable", "no"],
  ] as const;
  for (const [field, bad] of badFields) expect(parseSlashList({ commands: [{ ...validCommand, [field]: bad }, validCommand] })).toEqual({ commands: [validCommand], notices: [] });
  expect(parseSlashList({ commands: [null, validCommand, "bad", { ...validCommand, source: "other" }], notices: ["ok", 4, null] })).toEqual({ commands: [validCommand], notices: ["ok"] });
  expect(parseSlashList({ commands: "bad", notices: "bad" })).toEqual({ commands: [], notices: [] });
  expect(parseSendResult({ accepted: true, session_id: 4 })).toEqual({ kind: "malformed" });
  expect(MODEL_INPUT_IDS_FEATURE).toBe("model_input_ids");
});

test("wrappers forward methods, params, and request options", async () => {
  const options = { signal: new AbortController().signal, timeoutMs: 250, intent: "send" };
  const calls: Array<[string, Record<string, unknown>, unknown]> = [];
  const client = { request(method: string, params?: Record<string, unknown>, receivedOptions?: unknown) {
    calls.push([method, params ?? {}, receivedOptions]);
    if (method === "slash_list") return Promise.resolve(catalog);
    if (method === "slash_run") return Promise.resolve({ kind: "unknown", name: "missing" });
    return Promise.resolve({ accepted: true, session_id: "s1" });
  } };
  await expect(listSlashCommands(client, "s1", false, options)).resolves.toHaveProperty("commands");
  await expect(listSlashCommands(client, "s1", true, options)).resolves.toHaveProperty("commands");
  await expect(runSlashCommand(client, "s1", "/missing", options)).resolves.toEqual({ kind: "unknown", name: "missing" });
  await expect(sendModelInput(client, "s1", "opaque-1", options)).resolves.toEqual({ accepted: true, session_id: "s1" });
  expect(calls).toEqual([
    ["slash_list", { session_id: "s1" }, options],
    ["slash_list", { session_id: "s1", include_unavailable: true }, options],
    ["slash_run", { session_id: "s1", text: "/missing" }, options],
    ["send", { session_id: "s1", input_id: "opaque-1" }, options],
  ]);
});
