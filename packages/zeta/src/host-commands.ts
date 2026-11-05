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

const invalid = (field: string, limit: string): never => {
  throw new HostCommandError("invalid_host_commands", `${field} must ${limit}`);
};

function validateEnvironmentEntry(
  field: string,
  key: string,
  value: unknown,
  environmentKeys: Set<string>,
): number {
  if (!ENVIRONMENT_KEY.test(key)) invalid(`${field} key`, "match [A-Za-z_][A-Za-z0-9_]{0,127}");
  if (environmentKeys.has(key)) invalid(`${field} key`, "be unique across host_commands");
  if (REJECTED_ENVIRONMENT_KEYS.has(key) || key.startsWith("LD_") || key.startsWith("DYLD_")) invalid(`${field} key`, "not be reserved");
  if (typeof value !== "string") invalid(`${field} value`, "be a string");
  const stringValue = value as string;
  if (stringValue.includes("\0")) invalid(`${field} value`, "not contain NUL");
  if (bytes(stringValue) > 4096) invalid(`${field} value`, "be at most 4096 UTF-8 bytes");
  environmentKeys.add(key);
  return bytes(key) + bytes(stringValue);
}

function validateEnvironment(
  field: string,
  value: unknown,
  environmentKeys: Set<string>,
): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field, "be an object with at most 16 entries across host_commands");
  let totalBytes = 0;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    totalBytes += validateEnvironmentEntry(field, key, entry, environmentKeys);
  }
  return totalBytes;
}

function validateHostCommand(
  item: unknown,
  index: number,
  names: Set<string>,
  environmentKeys: Set<string>,
): number {
  const field = `host_commands[${index}]`;
  if (!item || typeof item !== "object" || Array.isArray(item)) invalid(field, "be an object with exactly name, executable, summary, and environment");
  const record = item as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== ITEM_KEYS.join("\0")) invalid(field, "contain exactly name, executable, summary, and environment");
  const { name, executable, summary, environment } = record;
  if (typeof name !== "string" || !NAME.test(name)) invalid(`${field}.name`, "match [A-Za-z][A-Za-z0-9._-]{0,63} (64 characters maximum)");
  const validName = name as string;
  if (names.has(validName)) invalid(`${field}.name`, "be unique across at most 4 host_commands");
  if (typeof executable !== "string" || !executable.startsWith("/") || normalizePosix(executable) !== executable) invalid(`${field}.executable`, "be a normalized absolute POSIX path of at most 4096 UTF-8 bytes");
  const validExecutable = executable as string;
  if (validExecutable.includes("\0") || validExecutable.includes("\n") || bytes(validExecutable) > 4096) invalid(`${field}.executable`, "contain no NUL or newline and be at most 4096 UTF-8 bytes");
  if (typeof summary !== "string" || !summary || summary.includes("\n") || bytes(summary) > 256) invalid(`${field}.summary`, "be one non-empty line of at most 256 UTF-8 bytes");
  names.add(validName);
  return validateEnvironment(`${field}.environment`, environment, environmentKeys);
}

export function validateHostCommands(value: unknown): HostCommand[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) invalid("host_commands", "be null or an array of at most 4 items");
  const commands = value as unknown[];
  if (commands.length > 4) invalid("host_commands", "contain at most 4 items");
  const names = new Set<string>();
  const environmentKeys = new Set<string>();
  let environmentBytes = 0;
  for (const [index, item] of commands.entries()) {
    environmentBytes += validateHostCommand(item, index, names, environmentKeys);
  }
  if (environmentKeys.size > 16) invalid("host_commands.environment", "contain at most 16 entries across all items");
  if (environmentBytes > 16384) invalid("host_commands.environment", "contain at most 16384 aggregate UTF-8 bytes");
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
