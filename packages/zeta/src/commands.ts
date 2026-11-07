import type { RequestOptions } from "./client.js";

export const MODEL_INPUT_IDS_FEATURE = "model_input_ids" as const;

export type SlashCommandKind = "builtin" | "macro-prompt" | "macro-exec" | "skill" | "mcp-prompt";
export type SlashCommandSource = "builtin" | "home" | "project" | `mcp:${string}`;

export interface SlashCommandInfo {
  name: string;
  description: string;
  kind: SlashCommandKind;
  source: SlashCommandSource;
  client_only: boolean;
  unavailable: "requires_tui" | null;
  [key: string]: unknown;
}

export interface SlashListResult {
  commands: SlashCommandInfo[];
  notices: string[];
}

export interface SlashOutputResult { kind: "output"; text: string; }
export interface SlashModelInputIdResult {
  kind: "model_input";
  input_id: string;
  display_text: string;
  text?: never;
  origin?: never;
}
export interface SlashModelInputTextResult {
  kind: "model_input";
  text: string;
  display_text: string;
  origin: string;
  input_id?: never;
}
export type SlashModelInputResult = SlashModelInputIdResult | SlashModelInputTextResult;
export interface SlashClientOnlyResult { kind: "client_only"; name: string; }
export interface SlashUnknownResult { kind: "unknown"; name: string; }
export interface SlashErrorResult { kind: "error"; text: string; }
export interface SlashMalformedResult { kind: "malformed"; }
/** The command was not sent because the server did not negotiate the feature needed to keep model input opaque. */
export interface SlashUnavailableResult { kind: "unavailable"; feature: typeof MODEL_INPUT_IDS_FEATURE; }
export type SlashRunResult = SlashOutputResult | SlashModelInputResult | SlashClientOnlyResult | SlashUnknownResult | SlashErrorResult;
export type ParsedSlashRunResult = SlashRunResult | SlashMalformedResult | SlashUnavailableResult;

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : null;

const commandKinds = new Set<SlashCommandKind>(["builtin", "macro-prompt", "macro-exec", "skill", "mcp-prompt"]);
const commandSources = (value: string): value is SlashCommandSource => value === "builtin" || value === "home" || value === "project" || value.startsWith("mcp:");

function parseCommand(value: unknown): SlashCommandInfo | null {
  const row = object(value);
  if (!row || typeof row.name !== "string" || typeof row.description !== "string" ||
      typeof row.kind !== "string" || !commandKinds.has(row.kind as SlashCommandKind) ||
      typeof row.source !== "string" || !commandSources(row.source) || typeof row.client_only !== "boolean" ||
      (row.unavailable !== null && row.unavailable !== "requires_tui")) return null;
  return row as SlashCommandInfo;
}

export interface ParseModelInputOptions { requireInputId: true; }

export function parseModelInput(value: unknown, options: ParseModelInputOptions): SlashModelInputIdResult | null;
export function parseModelInput(value: unknown): SlashModelInputResult | null;
/** Validates either zeta model_input shape, or only the opaque-id shape when requested. */
export function parseModelInput(value: unknown, options?: ParseModelInputOptions): SlashModelInputResult | null {
  const row = object(value);
  if (!row || row.kind !== "model_input" || typeof row.display_text !== "string") return null;
  // Zeta src/zeta/server/slash_commands.py:474-489 serializes these two negotiated shapes.
  if ("input_id" in row) {
    return typeof row.input_id === "string"
      ? { kind: "model_input", input_id: row.input_id, display_text: row.display_text }
      : null;
  }
  if (options?.requireInputId || typeof row.text !== "string" || typeof row.origin !== "string") return null;
  return { kind: "model_input", text: row.text, display_text: row.display_text, origin: row.origin };
}

/** Parses slash_list and drops malformed command rows without losing the list. */
export function parseSlashList(value: unknown): SlashListResult {
  const row = object(value);
  if (!row) return { commands: [], notices: [] };
  const commands = Array.isArray(row.commands) ? row.commands.map(parseCommand).filter((command): command is SlashCommandInfo => command !== null) : [];
  const notices = Array.isArray(row.notices) ? row.notices.filter((notice): notice is string => typeof notice === "string") : [];
  return { commands, notices };
}

/** Parses a slash_run response without throwing on malformed server data. */
export function parseSlashRun(value: unknown): ParsedSlashRunResult {
  const row = object(value);
  if (!row || typeof row.kind !== "string") return { kind: "malformed" };
  switch (row.kind) {
    case "output":
    case "error":
      return typeof row.text === "string" ? { kind: row.kind, text: row.text } : { kind: "malformed" };
    case "text":
      // legacy alias for /mcp status from zeta slash_commands.py:413-425 at 5feea2fc.
      return typeof row.text === "string" ? { kind: "output", text: row.text } : { kind: "malformed" };
    case "client_only":
    case "unknown":
      return typeof row.name === "string" ? { kind: row.kind, name: row.name } : { kind: "malformed" };
    case "model_input":
      return parseModelInput(row) ?? { kind: "malformed" };
    default:
      return { kind: "malformed" };
  }
}

export interface CommandClient {
  readonly features: readonly string[];
  request(method: string, params?: Record<string, unknown>, options?: RequestOptions): Promise<unknown>;
}

// Keep this guard shared with the future input_prepare helper so model input cannot leak through either path.
function requireModelInputIds(client: CommandClient): SlashUnavailableResult | null {
  return client.features.includes(MODEL_INPUT_IDS_FEATURE) ? null : { kind: "unavailable", feature: MODEL_INPUT_IDS_FEATURE };
}

export function listSlashCommands(client: CommandClient, sessionId: string, includeUnavailable = false, options?: RequestOptions): Promise<SlashListResult> {
  return client.request("slash_list", { session_id: sessionId, ...(includeUnavailable ? { include_unavailable: true } : {}) }, options).then(parseSlashList);
}

export function runSlashCommand(client: CommandClient, sessionId: string, text: string, options?: RequestOptions): Promise<ParsedSlashRunResult> {
  const unavailable = requireModelInputIds(client);
  return unavailable ? Promise.resolve(unavailable) : client.request("slash_run", { session_id: sessionId, text }, options).then(parseSlashRun);
}

export interface SendResult { accepted: true; session_id: string; }
export interface SendMalformedResult { kind: "malformed"; }

export function parseSendResult(value: unknown): SendResult | SendMalformedResult {
  const row = object(value);
  return row?.accepted === true && typeof row.session_id === "string" ? row as unknown as SendResult : { kind: "malformed" };
}

export function sendModelInput(client: CommandClient, sessionId: string, inputId: string, options?: RequestOptions): Promise<SendResult | SendMalformedResult> {
  return client.request("send", { session_id: sessionId, input_id: inputId }, options).then(parseSendResult);
}
