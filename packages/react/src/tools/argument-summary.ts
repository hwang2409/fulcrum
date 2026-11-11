import type { ToolCall } from "@fulcrum/core";
import { clipSummary, MAX_SUMMARY_CHARS } from "./common.js";

const LABEL_KEYS = ["content", "title", "text", "name"];
const MAX_KEYS = 24;
const MAX_READS = 64;
const MAX_DEPTH = 6;
const UNAVAILABLE = Symbol("unavailable");

type ReadValue = unknown | typeof UNAVAILABLE;
type Summary = { count?: string; text: string };

const format = (args: Record<string, unknown>): Summary => {
  let remaining = MAX_READS;
  const values = new WeakMap<object, Map<PropertyKey, ReadValue>>();
  const ancestors = new WeakSet<object>();

  const read = (object: object, key: PropertyKey): ReadValue => {
    let cache = values.get(object);
    if (cache?.has(key)) return cache.get(key);
    if (!remaining) return UNAVAILABLE;
    remaining--;
    let value: ReadValue;
    try {
      value = (object as Record<PropertyKey, unknown>)[key];
    } catch {
      value = UNAVAILABLE;
    }
    if (!cache) {
      cache = new Map();
      values.set(object, cache);
    }
    cache.set(key, value);
    return value;
  };
  const quote = (value: string) => clipSummary(JSON.stringify(clipSummary(value)));
  const json = (value: unknown, depth = 0, arrayValue = false): string => {
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
    if (ancestors.has(value)) return quote("[circular]");
    if (depth >= MAX_DEPTH) return quote("[depth limit]");
    ancestors.add(value);
    const parts: string[] = [];
    try {
      if (Array.isArray(value)) {
        const rawLength = read(value, "length");
        if (typeof rawLength !== "number") return quote("[unavailable]");
        const length = Math.min(rawLength, MAX_KEYS);
        for (let index = 0; index < length; index++) {
          if (!remaining) { parts.push(quote("[truncated]")); break; }
          parts.push(json(read(value, index), depth + 1, true) || "null");
          if (parts.join(",").length >= MAX_SUMMARY_CHARS) break;
        }
        if (remaining && rawLength > length) parts.push(quote("…"));
        return clipSummary(`[${parts.join(",")}]`);
      }
      let keys = 0;
      for (const key in value as Record<string, unknown>) {
        if (!Object.hasOwn(value, key)) continue;
        if (!remaining || keys++ >= MAX_KEYS) { parts.push(`${quote("…")}:${quote("[truncated]")}`); break; }
        const text = json(read(value, key), depth + 1);
        if (text) parts.push(`${quote(key)}:${text}`);
        if (parts.join(",").length >= MAX_SUMMARY_CHARS) break;
      }
      return clipSummary(`{${parts.join(",")}}`);
    } finally {
      ancestors.delete(value);
    }
  };
  const label = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return undefined;
    for (const key of LABEL_KEYS) {
      if (!remaining) return undefined;
      const field = read(value, key);
      if (typeof field === "string") return field;
    }
    let keys = 0;
    for (const key in value as Record<string, unknown>) {
      if (!Object.hasOwn(value, key)) continue;
      if (!remaining || keys++ >= MAX_KEYS) break;
      const field = read(value, key);
      if (typeof field === "string") return field;
    }
  };

  let firstList: { value: unknown[]; length: number } | undefined;
  let keys = 0;
  for (const key in args) {
    if (!Object.hasOwn(args, key)) continue;
    if (!remaining || keys++ >= MAX_KEYS) break;
    const value = read(args, key);
    if (value === UNAVAILABLE) continue;
    if (typeof value === "string") return { text: clipSummary(value) };
    if (!firstList && Array.isArray(value)) {
      const length = read(value, "length");
      if (typeof length === "number" && length > 0) firstList = { value, length };
    }
  }
  if (!firstList) return { text: keys ? json(args) : "" };
  const count = `${firstList.length} ${firstList.length === 1 ? "item" : "items"}`;
  const item = read(firstList.value, 0);
  const text = item === UNAVAILABLE ? "[unavailable]" : label(item) ?? json(item);
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
