const encoder = new TextEncoder();
const NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const REJECTED_ENVIRONMENT_KEYS = new Set([
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "CDPATH",
  "GLOBIGNORE",
  "ZETA_TOOL_SUBPROCESS",
]);
const ITEM_KEYS = ["environment", "executable", "name", "summary"];

export interface HostCommand {
  name: string;
  executable: string;
  summary: string;
  environment: Record<string, string>;
}

export type HostCommandSupplier = (
  sessionId: string | null,
) => HostCommand[] | null | Promise<HostCommand[] | null>;

export type HostCommandErrorKind =
  | "invalid_host_commands"
  | "host_command_supplier_failed"
  | "host_command_request_failed"
  | "host_binding_recovery_failed"
  | "host_binding_retry_failed";

export class HostCommandError extends Error {
  readonly name = "HostCommandError";
  constructor(
    readonly kind: HostCommandErrorKind,
    message: string,
    readonly code?: number,
    readonly data?: { code: string },
  ) {
    super(message);
  }
}

const bytes = (value: string) => encoder.encode(value).byteLength;

function normalizePosix(value: string): string {
  const doubleSlash = value.startsWith("//") && !value.startsWith("///");
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${doubleSlash ? "//" : "/"}${parts.join("/")}`;
}

const invalid = (field: string): never => {
  throw new HostCommandError("invalid_host_commands", `${field} is invalid`);
};

export function validateHostCommands(value: unknown): HostCommand[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 4) invalid("host_commands");
  const commands = value as unknown[];
  const names = new Set<string>();
  const environmentKeys = new Set<string>();
  let environmentBytes = 0;

  for (const [index, item] of commands.entries()) {
    const field = `host_commands[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).sort().join("\0") !== ITEM_KEYS.join("\0")) invalid(field);
    const { name, executable, summary, environment } = item as Record<string, unknown>;
    if (typeof name !== "string" || !NAME.test(name) || names.has(name)) invalid(`${field}.name`);
    const validName = name as string;
    if (typeof executable !== "string" || !executable.startsWith("/") || normalizePosix(executable) !== executable || executable.includes("\0") || executable.includes("\n") || bytes(executable) > 4096) invalid(`${field}.executable`);
    if (typeof summary !== "string" || !summary || summary.includes("\n") || bytes(summary) > 256) invalid(`${field}.summary`);
    if (!environment || typeof environment !== "object" || Array.isArray(environment)) invalid(`${field}.environment`);
    const validEnvironment = environment as Record<string, unknown>;

    names.add(validName);
    for (const [key, environmentValue] of Object.entries(validEnvironment)) {
      if (!ENVIRONMENT_KEY.test(key) || environmentKeys.has(key) || REJECTED_ENVIRONMENT_KEYS.has(key) || key.startsWith("LD_") || key.startsWith("DYLD_")) invalid(`${field}.environment key`);
      if (typeof environmentValue !== "string" || environmentValue.includes("\0") || bytes(environmentValue) > 4096) invalid(`${field}.environment value`);
      const validEnvironmentValue = environmentValue as string;
      environmentKeys.add(key);
      environmentBytes += bytes(key) + bytes(validEnvironmentValue);
    }
  }
  if (environmentKeys.size > 16 || environmentBytes > 16384) invalid("host_commands.environment");
  return commands as HostCommand[];
}

export function redactHostCommandFailure(kind: HostCommandErrorKind, error: unknown): HostCommandError {
  const rpc = typeof error === "object" && error !== null ? error as { code?: unknown; data?: unknown } : {};
  const code = typeof rpc.code === "number" ? rpc.code : undefined;
  const dataCode = typeof rpc.data === "object" && rpc.data !== null && typeof (rpc.data as { code?: unknown }).code === "string"
    ? { code: (rpc.data as { code: string }).code }
    : undefined;
  return new HostCommandError(kind, kind.replaceAll("_", " "), code, dataCode);
}

export function isHostBindingRequired(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === -32003 &&
    typeof (error as { data?: unknown }).data === "object" && (error as { data: { code?: unknown } }).data !== null &&
    (error as { data: { code?: unknown } }).data.code === "host_binding_required";
}
