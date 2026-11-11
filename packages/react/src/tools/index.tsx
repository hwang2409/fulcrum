import type { ComponentType } from "react";
import type { ToolCall } from "@fulcrum/core";
import type { ToolBodyProps, ToolItem } from "../parts.js";
import { diffStatText } from "./diff.js";
import { EditBody } from "./edit.js";
import { FetchBody } from "./fetch.js";
import { GenericBody } from "./generic.js";
import { ReadBody } from "./read.js";
import { SearchBody } from "./search.js";
import { ShellBody } from "./shell.js";
import { WriteBody } from "./write.js";
import { lineCount } from "./common.js";

export { EditBody, FetchBody, GenericBody, ReadBody, SearchBody, ShellBody, WriteBody };

const bodies: Record<NonNullable<ToolItem["view"]>["kind"], ComponentType<ToolBodyProps>> = {
  shell: ShellBody,
  read: ReadBody,
  edit: EditBody,
  write: WriteBody,
  search: SearchBody,
  fetch: FetchBody,
};

/** The default body of ToolCall and Approval: the card for the item's view kind, or the generic one with no view. */
export function ToolBody(props: ToolBodyProps) {
  const Body = (props.item.view && bodies[props.item.view.kind]) || GenericBody;
  return <Body {...props} />;
}

// shortcut: the first string argument is the most telling one for common tools (command, path, pattern, url); adapters that set a view do better.
const LABEL_KEYS = ["content", "title", "text", "name"];
const SUMMARY_CHARS = 240;
const SUMMARY_KEYS = 24;
const SUMMARY_NODES = 64;
const SUMMARY_DEPTH = 6;

// JSON-compatible values keep JSON.stringify's text until the fixed work or header budget is reached.
const boundedJson = (root: unknown): string => {
  let nodes = 0;
  const ancestors = new WeakSet<object>();
  const clip = (text: string) => text.length <= SUMMARY_CHARS ? text : `${text.slice(0, SUMMARY_CHARS - 1)}…`;
  const quoted = (text: string) => clip(JSON.stringify(text.slice(0, SUMMARY_CHARS)));
  const visit = (value: unknown, depth: number, arrayValue = false): string | undefined => {
    if (++nodes > SUMMARY_NODES) return quoted("[truncated]");
    if (value === null) return "null";
    switch (typeof value) {
      case "string": return quoted(value);
      case "number": return Number.isFinite(value) ? String(value) : "null";
      case "boolean": return String(value);
      case "bigint": return quoted(`${value}n`);
      case "symbol": return quoted(String(value));
      case "undefined":
      case "function": return arrayValue ? "null" : undefined;
    }
    if (ancestors.has(value)) return quoted("[circular]");
    if (depth >= SUMMARY_DEPTH) return quoted("[depth limit]");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const parts: string[] = [];
        const length = Math.min(value.length, SUMMARY_KEYS);
        for (let index = 0; index < length; index++) {
          let item: unknown;
          try { item = value[index]; } catch { item = "[unavailable]"; }
          parts.push(visit(item, depth + 1, true) ?? "null");
          if (parts.join(",").length >= SUMMARY_CHARS) break;
        }
        if (value.length > length) parts.push(quoted("…"));
        return clip(`[${parts.join(",")}]`);
      }
      const parts: string[] = [];
      let keys = 0;
      let truncated = false;
      for (const key in value as Record<string, unknown>) {
        if (!Object.hasOwn(value, key)) continue;
        if (keys >= SUMMARY_KEYS) { truncated = true; break; }
        keys++;
        let item: unknown;
        try { item = (value as Record<string, unknown>)[key]; } catch { item = "[unavailable]"; }
        const text = visit(item, depth + 1);
        if (text !== undefined) parts.push(`${quoted(key)}:${text}`);
        if (parts.join(",").length >= SUMMARY_CHARS) break;
      }
      if (truncated) parts.push(`${quoted("…")}:${quoted("[truncated]")}`);
      return clip(`{${parts.join(",")}}`);
    } catch {
      return quoted("[unavailable]");
    } finally {
      ancestors.delete(value);
    }
  };
  return visit(root, 0) ?? "";
};

/**
 * A generic tool's summary: its first string argument, else its first list as "N items" and the first item's label
 * (a todo list reads `1 item · cap the pending queue`), else its arguments as bounded JSON-like text.
 */
export function argumentSummary(call: ToolCall): { count?: string; text: string } {
  const args = call.arguments ?? {};
  let firstList: unknown[] | undefined;
  let seen = 0;
  try {
    for (const key in args) {
      if (!Object.hasOwn(args, key)) continue;
      if (seen >= SUMMARY_KEYS) break;
      seen++;
      let value: unknown;
      try { value = args[key]; } catch { continue; }
      if (typeof value === "string") return { text: value.length <= SUMMARY_CHARS ? value : `${value.slice(0, SUMMARY_CHARS - 1)}…` };
      if (!firstList && Array.isArray(value) && value.length > 0) firstList = value;
    }
  } catch {
    return { text: "[unavailable]" };
  }
  if (firstList) {
    const count = `${firstList.length} ${firstList.length === 1 ? "item" : "items"}`;
    let item: unknown;
    try { item = firstList[0]; } catch { item = "[unavailable]"; }
    let label = typeof item === "string" ? item : undefined;
    if (!label && item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      for (const key of LABEL_KEYS) {
        try { if (typeof record[key] === "string") { label = record[key]; break; } } catch { /* use another label or the bounded fallback */ }
      }
      if (!label) {
        let labels = 0;
        try {
          for (const key in record) {
            if (!Object.hasOwn(record, key)) continue;
            if (labels >= SUMMARY_KEYS) break;
            labels++;
            try { if (typeof record[key] === "string") { label = record[key]; break; } } catch { /* keep looking */ }
          }
        } catch { /* use the bounded fallback */ }
      }
    }
    const text = label ?? boundedJson(item);
    const maxText = SUMMARY_CHARS - count.length - 3;
    return { count, text: text.length <= maxText ? text : `${text.slice(0, maxText - 1)}…` };
  }
  return { text: seen ? boundedJson(args) : "" };
}
const firstArgument = (call: ToolCall) => {
  const { count, text } = argumentSummary(call);
  const summary = count ? `${count} · ${text}` : text;
  return summary.length <= SUMMARY_CHARS ? summary : `${summary.slice(0, SUMMARY_CHARS - 1)}…`;
};

/** The default one-line header summary: `$ ls`, `src/a.ts:1-40`, `src/a.ts +3 -1`, `"TODO" packages/`, `example.com/a`. */
export function toolSummary({ view, tool_call }: ToolItem): string {
  switch (view?.kind) {
    case "shell":
      return `$ ${view.command}`;
    case "read": {
      const start = (view.range?.offset ?? 0) + 1;
      const limit = view.range?.limit;
      return limit !== undefined ? `${view.path}:${start}-${start + limit - 1}` : view.range?.offset ? `${view.path}:${start}` : view.path;
    }
    case "edit": {
      const { insert, remove } = diffStatText(view.diff);
      return `${view.path} +${insert} -${remove}`;
    }
    case "write":
      return view.content !== undefined ? `${view.path} +${lineCount(view.content)}` : view.path;
    case "search":
      return view.path ? `"${view.pattern}" ${view.path}` : `"${view.pattern}"`;
    case "fetch":
      return view.url !== undefined ? view.url.replace(/^https?:\/\//, "") : view.query;
  }
  return firstArgument(tool_call);
}
