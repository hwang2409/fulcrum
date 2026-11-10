import type { RequestOptions } from "./client.js";

export const PATH_COMPLETION_FEATURE = "path_completion" as const;

export type PathCompletionEntry = {
  readonly text: string;
  readonly display: string;
  readonly kind: "directory" | "file";
  /** Zero or negative UTF-16 code units, ready for JavaScript slicing. */
  readonly startPosition: number;
};

export type PathCompletionResult =
  | { readonly kind: "entries"; readonly entries: readonly PathCompletionEntry[]; readonly truncated: boolean }
  | { readonly kind: "unavailable"; readonly feature: typeof PATH_COMPLETION_FEATURE }
  | { readonly kind: "observer" }
  | { readonly kind: "malformed" };

export interface PathCompletionClient {
  readonly features: readonly string[];
  request(method: string, params?: Record<string, unknown>, options?: RequestOptions): Promise<unknown>;
}

const encoder = new TextEncoder();
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

function codePointCount(value: string): number | null {
  let count = 0;
  for (let index = 0; index < value.length; index++, count++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (++index >= value.length) return null;
      const next = value.charCodeAt(index);
      if (next < 0xdc00 || next > 0xdfff) return null;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return null;
    }
  }
  return count;
}

function utf16Offset(value: string, codePointOffset: number): number {
  let index = value.length;
  for (let remaining = -codePointOffset; remaining > 0; remaining--) {
    if (value.charCodeAt(--index) >= 0xdc00 && value.charCodeAt(index) <= 0xdfff) index--;
  }
  return index - value.length;
}

function parseResult(value: unknown, textBeforeCursor: string, points: number): PathCompletionResult {
  const envelope = object(value);
  if (!envelope || !Array.isArray(envelope.entries) || typeof envelope.truncated !== "boolean") {
    return { kind: "malformed" };
  }
  const entries: PathCompletionEntry[] = [];
  for (const value of envelope.entries) {
    const row = object(value);
    if (!row || typeof row.text !== "string" || typeof row.display !== "string" ||
        row.kind !== "directory" && row.kind !== "file" ||
        typeof row.start_position !== "number" || !Number.isSafeInteger(row.start_position) ||
        row.start_position > 0 || row.start_position < -points) return { kind: "malformed" };
    entries.push({
      text: row.text,
      display: row.display,
      kind: row.kind,
      startPosition: utf16Offset(textBeforeCursor, row.start_position),
    });
  }
  return { kind: "entries", entries, truncated: envelope.truncated };
}

const unavailable = (): PathCompletionResult => ({ kind: "unavailable", feature: PATH_COMPLETION_FEATURE });
const aborted = () => Object.assign(new Error("request aborted"), { name: "AbortError" });

/** Requests one validated path-completion page. It never retries. */
export async function completePath(
  client: PathCompletionClient,
  sessionId: string,
  textBeforeCursor: string,
  options?: RequestOptions,
): Promise<PathCompletionResult> {
  if (!client.features.includes(PATH_COMPLETION_FEATURE)) return unavailable();
  const points = codePointCount(textBeforeCursor);
  if (sessionId.length === 0 || points === null || encoder.encode(textBeforeCursor).byteLength > 4096) {
    return { kind: "malformed" };
  }
  if (options?.signal?.aborted) throw aborted();
  try {
    const value = await client.request("path_complete", {
      session_id: sessionId,
      text_before_cursor: textBeforeCursor,
    }, options);
    return parseResult(value, textBeforeCursor, points);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === -32601) return unavailable();
    if (code === -32008) return { kind: "observer" };
    if (code === -32602) return { kind: "malformed" };
    throw error;
  }
}
