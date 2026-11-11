import type { ToolCall } from "@fulcrum/core";
import { clipSummary, MAX_SUMMARY_CHARS } from "./common.js";

const LABEL_KEYS = ["content", "title", "text", "name"];
const MAX_KEYS = 24;
const MAX_READS = 64;
const MAX_DEPTH = 6;
const UNAVAILABLE = Symbol("unavailable");

type ReadValue = unknown | typeof UNAVAILABLE;
type Summary = { count?: string; text: string };
type Formatter = {
  left: number;
  cache: WeakMap<object, Map<PropertyKey, ReadValue>>;
  seen: WeakSet<object>;
};

const read = (formatter: Formatter, object: object, key: PropertyKey): ReadValue => {
  let cache = formatter.cache.get(object);
  if (cache?.has(key)) return cache.get(key);
  if (!formatter.left) return UNAVAILABLE;
  formatter.left--;
  let value: ReadValue;
  try {
    value = (object as Record<PropertyKey, unknown>)[key];
  } catch {
    value = UNAVAILABLE;
  }
  if (!cache) {
    cache = new Map();
    formatter.cache.set(object, cache);
  }
  cache.set(key, value);
  return value;
};
const quote = (value: string) => JSON.stringify(clipSummary(value));
const arrayJson = (formatter: Formatter, value: unknown[], depth: number): string => {
  const rawLength = read(formatter, value, "length");
  if (typeof rawLength !== "number") return quote("[unavailable]");
  const length = Math.min(rawLength, MAX_KEYS);
  const parts: string[] = [];
  for (let index = 0; index < length; index++) {
    if (!formatter.left) { parts.push(quote("[truncated]")); break; }
    parts.push(json(formatter, read(formatter, value, index), depth + 1, true) || "null");
    if (parts.join(",").length >= MAX_SUMMARY_CHARS) break;
  }
  if (formatter.left && rawLength > length) parts.push(quote("…"));
  return clipSummary(`[${parts.join(",")}]`);
};
const objectJson = (formatter: Formatter, value: object, depth: number): string => {
  const parts: string[] = [];
  let keys = 0;
  for (const key in value as Record<string, unknown>) {
    if (!Object.hasOwn(value, key)) continue;
    if (!formatter.left || keys++ >= MAX_KEYS) { parts.push(`${quote("…")}:${quote("[truncated]")}`); break; }
    const text = json(formatter, read(formatter, value, key), depth + 1);
    if (text) parts.push(`${quote(key)}:${text}`);
    if (parts.join(",").length >= MAX_SUMMARY_CHARS) break;
  }
  return clipSummary(`{${parts.join(",")}}`);
};
const json = (formatter: Formatter, value: unknown, depth = 0, arrayValue = false): string => {
  if (value === UNAVAILABLE) return quote("[unavailable]");
  if (value === null) return "null";
  switch (typeof value) {
    case "string": return quote(value);
    case "number": return Number.isFinite(value) ? String(value) : "null";
    case "boolean": return String(value);
    case "bigint": return quote(`${value}n`);
    case "symbol": return quote(String(value));
    case "undefined":
    case "function": return arrayValue ? "null" : "";
  }
  if (formatter.seen.has(value)) return quote("[circular]");
  if (depth >= MAX_DEPTH) return quote("[depth limit]");
  formatter.seen.add(value);
  try {
    return Array.isArray(value) ? arrayJson(formatter, value, depth) : objectJson(formatter, value, depth);
  } finally {
    formatter.seen.delete(value);
  }
};
const label = (formatter: Formatter, value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  for (const key of LABEL_KEYS) {
    if (!formatter.left) return undefined;
    const field = read(formatter, value, key);
    if (typeof field === "string") return field;
  }
  let keys = 0;
  for (const key in value as Record<string, unknown>) {
    if (!Object.hasOwn(value, key)) continue;
    if (!formatter.left || keys++ >= MAX_KEYS) break;
    const field = read(formatter, value, key);
    if (typeof field === "string") return field;
  }
};
const format = (args: Record<string, unknown>): Summary => {
  const formatter: Formatter = { left: MAX_READS, cache: new WeakMap(), seen: new WeakSet() };
  let firstList: [value: unknown[], length: number] | undefined;
  let keys = 0;
  for (const key in args) {
    if (!Object.hasOwn(args, key)) continue;
    if (!formatter.left || keys++ >= MAX_KEYS) break;
    const value = read(formatter, args, key);
    if (value === UNAVAILABLE) continue;
    if (typeof value === "string") return { text: clipSummary(value) };
    if (!firstList && Array.isArray(value)) {
      const length = read(formatter, value, "length");
      if (typeof length === "number" && length > 0) firstList = [value, length];
    }
  }
  if (!firstList) return { text: keys ? json(formatter, args) : "" };
  const count = `${firstList[1]} ${firstList[1] === 1 ? "item" : "items"}`;
  const item = read(formatter, firstList[0], 0);
  const text = item === UNAVAILABLE ? "[unavailable]" : label(formatter, item) ?? json(formatter, item);
  return { count, text: clipSummary(text, MAX_SUMMARY_CHARS - count.length - 3) };
};

/** A generic tool's bounded collapsed-header summary. */
export function argumentSummary(call: ToolCall): Summary {
  try {
    return format(call.arguments ?? {});
  } catch {
    return { text: "[unavailable]" };
  }
}
